// The Claude Messages API over built-in fetch, streamed (ADR-002 point 1).
// A response's headers come at once, so a long answer never trips fetch's
// 300-second header timeout. Every content block is kept as it came, so a
// thinking block's signature, or a block type this reader does not know,
// goes back to the API unchanged in the next turn of a tool loop.

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2026-10-21';
const BACKOFF_MS = [5_000, 20_000]; // before the second and the third attempt
const ATTEMPTS = BACKOFF_MS.length + 1;
const RETRY_AFTER_MAX_MS = 60_000;
// Three attempts and their waits fit the workflow step's 20 minutes.
const ATTEMPT_TIMEOUT_MS = 6 * 60_000;

export type Block = { type: string } & Record<string, unknown>;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface Message {
  model: string;
  content: Block[];
  stop_reason: string | null;
  usage: Usage;
}

/** A failed request. Its message holds the status, the API's error type and, from the API's message, one fixed word; never that message itself. */
export class ApiError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, type: string, text: string, retryAfterMs?: number) {
    const word = /credit balance/i.test(text) ? 'credits' : /spend limit|usage limit|workspace limit/i.test(text) ? 'limit' : undefined;
    super(`API ${status || 'stream'} ${type}${word ? ` ${word}` : ''}`);
    this.retryable = word === undefined && (status === 0 || status === 429 || status >= 500);
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const USAGE_KEYS = Object.keys(emptyUsage()) as (keyof Usage)[];

/** Sets (a stream's later counts replace its earlier ones) or adds (one request's counts to a job's) each count `from` has. */
export function mergeUsage(into: Usage, from: unknown, add = false): void {
  if (typeof from !== 'object' || from === null) return;
  for (const k of USAGE_KEYS) {
    const v = (from as Record<string, unknown>)[k];
    if (typeof v === 'number') into[k] = add ? into[k] + v : v;
  }
}

/** Server-sent events of one response, as `[event, data]` pairs. */
async function* events(body: ReadableStream<Uint8Array<ArrayBuffer>>): AsyncGenerator<[string, string]> {
  let buf = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buf += chunk.replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield [event, data.join('\n')];
    }
  }
}

/** Folds one response's events into the final message. */
export async function readStream(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<Message> {
  let msg: Message | undefined;
  const json = new Map<number, string>();
  for await (const [event, data] of events(body)) {
    if (event === 'ping') continue;
    const d = JSON.parse(data) as Record<string, unknown>;
    if (event === 'error') {
      const e = (d.error ?? {}) as Record<string, unknown>;
      throw new ApiError(0, String(e.type ?? 'error'), String(e.message ?? ''));
    }
    if (event === 'message_start') {
      const m = d.message as Record<string, unknown>;
      msg = { model: String(m.model ?? ''), content: [], stop_reason: null, usage: emptyUsage() };
      mergeUsage(msg.usage, m.usage);
      continue;
    }
    if (!msg) throw new Error(`stream event ${event} before message_start`);
    const i = Number(d.index);
    if (event === 'content_block_start') {
      msg.content[i] = d.content_block as Block;
    } else if (event === 'content_block_delta') {
      const b = msg.content[i];
      const delta = d.delta as Record<string, unknown>;
      if (!b) throw new Error('delta for a block that did not start');
      const add = (key: string, v: unknown) => (b[key] = String(b[key] ?? '') + String(v ?? ''));
      if (delta.type === 'text_delta') add('text', delta.text);
      else if (delta.type === 'thinking_delta') add('thinking', delta.thinking);
      else if (delta.type === 'signature_delta') add('signature', delta.signature);
      else if (delta.type === 'input_json_delta') json.set(i, (json.get(i) ?? '') + String(delta.partial_json ?? ''));
      else throw new Error(`unknown delta type ${String(delta.type)}`);
    } else if (event === 'content_block_stop') {
      const b = msg.content[i];
      const partial = json.get(i);
      if (b && partial !== undefined) b.input = partial ? JSON.parse(partial) : {};
    } else if (event === 'message_delta') {
      const delta = d.delta as Record<string, unknown>;
      if (typeof delta.stop_reason === 'string') msg.stop_reason = delta.stop_reason;
      mergeUsage(msg.usage, d.usage);
    } else if (event === 'message_stop') {
      return msg;
    }
  }
  throw new Error('stream ended before message_stop');
}

function retryAfter(res: Response): number | undefined {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, RETRY_AFTER_MAX_MS) : undefined;
}

async function attempt(body: Record<string, unknown>, o: ClientOptions): Promise<Message> {
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify({ ...body, stream: true }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, 'network_error', '');
  }
  if (!res.ok || !res.body) {
    let type = 'error';
    let text = '';
    try {
      const e = ((await res.json()) as { error?: { type?: string; message?: string } }).error;
      type = e?.type ?? type;
      text = e?.message ?? '';
    } catch {
      // A body that is not JSON (a proxy's page) leaves the status alone to explain it.
    }
    throw new ApiError(res.status, type, text, retryAfter(res));
  }
  try {
    return await readStream(res.body);
  } catch (e) {
    // A connection lost or timed out mid-body; parse errors and unknown deltas stay fatal.
    if (e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError')) throw new ApiError(0, 'network_error', '');
    throw e;
  }
}

/** One Messages API request, streamed, with up to three attempts on 429, 5xx, a stream error or a network error. */
export async function createMessage(body: Record<string, unknown>, o: ClientOptions): Promise<Message> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let n = 1; ; n++) {
    try {
      return await attempt(body, o);
    } catch (e) {
      if (!(e instanceof ApiError) || !e.retryable || n >= ATTEMPTS) throw e;
      await sleep(e.retryAfterMs ?? (BACKOFF_MS[n - 1] as number));
    }
  }
}
