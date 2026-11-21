// The two model jobs, judge and talk, on the Claude API (ADR-002).
// The model reads its input in the request, may call one tool, fetch_page,
// that this code runs against two fixed pages of the Hinnavaatlus hosts, and
// answers with the job's JSON file, which act checks as before. Nothing here
// prints listing, message or model text: counts only.
//
//   node src/agent.ts judge|talk <owner>     with ANTHROPIC_API_KEY set
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMessage, emptyUsage, mergeUsage, type Block, type Message, type Usage } from './claude.ts';
import { httpText, limitedFetch } from './http.ts';
import { safeError } from './log.ts';
import { FORUM_HOST, parseReferencePrices, parseTopicPage, searchUrl, topicUrl, WWW_HOST } from './sources/hinnavaatlus.ts';
import type { Fetch } from './sources/source.ts';
import { ANSWERS_SCHEMA, VERDICTS_SCHEMA } from './verdicts.ts';
import { OWNERS, type Owner } from './watches.ts';
import { PATHS, type JudgeInput, type TalkInput } from './work.ts';

export const MODEL = 'claude-sonnet-5-5';
export const MAX_TOKENS = 32_000;
export const MAX_REQUESTS = 8; // model requests per job
export const MAX_FETCHES = 5; // fetch_page requests per job
export const FETCH_GAP_MS = 2000;
export const QUERY_MAX = 100;

export type Job = 'judge' | 'talk';

export const JOBS: Record<Job, { prompt: string; input: (o: Owner) => string; output: (o: Owner) => string; schema: object }> = {
  judge: { prompt: '.github/agent/judge.md', input: () => PATHS.judgeInput, output: () => PATHS.verdicts, schema: VERDICTS_SCHEMA },
  talk: { prompt: '.github/agent/talk.md', input: PATHS.talkInput, output: PATHS.answers, schema: ANSWERS_SCHEMA },
};

export const FETCH_TOOL = {
  name: 'fetch_page',
  description:
    `Fetches one page and returns its text. Only two kinds of URL work: a forum topic https://${FORUM_HOST}/viewtopic.php?t=<id> ` +
    `whose link is in your input (returns its posts, the seller marked), and a price search https://${WWW_HOST}/search/?query=<words> ` +
    `with at most ${QUERY_MAX} characters (returns retail products and prices as JSON). Anything else is refused.`,
  input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  strict: true,
};

const TOPIC_LINK = new RegExp(`${FORUM_HOST.replaceAll('.', '\\.')}/viewtopic\\.php\\?t=(\\d+)`, 'g');
const topicIds = (s: string | undefined) => [...(s ?? '').matchAll(TOPIC_LINK)].map((m) => m[1] as string);

/** Topic ids the job may fetch: the judge's listings, and for talk the alerts replied to and topics the person linked. */
export function allowedTopics(job: Job, input: string): Set<string> {
  if (job === 'judge') return new Set((JSON.parse(input) as JudgeInput).listings.flatMap((l) => topicIds(l.url)));
  return new Set((JSON.parse(input) as TalkInput).messages.flatMap((m) => [...topicIds(m.reply_to_alert?.url), ...topicIds(m.text)]));
}

/** The URL this code will fetch for the model's URL (built here, never the model's string), or why it is refused. */
export function checkFetchUrl(raw: string, topics: Set<string>): { url: string; kind: 'topic' | 'search' } | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return 'only https on the default port';
  const keys = [...u.searchParams.keys()];
  if (u.hostname === FORUM_HOST && u.pathname === '/viewtopic.php' && keys.length === 1 && keys[0] === 't') {
    const t = u.searchParams.get('t') ?? '';
    if (!/^\d+$/.test(t)) return 'a topic id is digits';
    if (!topics.has(t)) return 'only topics linked in the input';
    return { url: topicUrl(t), kind: 'topic' };
  }
  if (u.hostname === WWW_HOST && u.pathname === '/search/' && keys.length === 1 && keys[0] === 'query') {
    const q = (u.searchParams.get('query') ?? '').trim();
    if (!q || q.length > QUERY_MAX) return `a query is 1-${QUERY_MAX} characters`;
    return { url: searchUrl(q), kind: 'search' };
  }
  return 'only a forum topic or the price search';
}

export interface AgentInput {
  job: Job;
  system: string;
  input: string; // the opened input file, as text
  call: (body: Record<string, unknown>) => Promise<Message>;
  fetch: Fetch;
}

export interface AgentResult {
  text: string | null; // the job's file, or null when it failed
  failure?: string; // why, in fixed words
  model: string;
  stop: string | null;
  requests: number;
  usage: Usage;
}

export function requestBody(job: Job, system: string, messages: unknown[]): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    tools: [FETCH_TOOL],
    output_config: { format: { type: 'json_schema', schema: JOBS[job].schema } },
    cache_control: { type: 'ephemeral' },
  };
}

async function runTool(block: Block, topics: Set<string>, fetch: Fetch): Promise<Block> {
  const reply = (content: string, isError = false): Block => ({ type: 'tool_result', tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
  if (block.name !== FETCH_TOOL.name) return reply('unknown tool', true);
  const url = (block.input as { url?: unknown } | undefined)?.url;
  const checked = checkFetchUrl(typeof url === 'string' ? url : '', topics);
  if (typeof checked === 'string') return reply(`refused: ${checked}`, true);
  try {
    const html = await fetch(checked.url);
    const text = checked.kind === 'topic' ? parseTopicPage(html) : JSON.stringify(parseReferencePrices(html));
    return reply(text || 'no posts on this page');
  } catch (e) {
    return reply(`fetch failed: ${safeError(e)}`, true);
  }
}

/** The tool loop: at most MAX_REQUESTS model requests; the final text is the job's file. */
export async function runAgent(a: AgentInput): Promise<AgentResult> {
  const topics = allowedTopics(a.job, a.input);
  const messages: { role: string; content: unknown }[] = [{ role: 'user', content: a.input }];
  const usage = emptyUsage();
  let model = MODEL;
  let stop: string | null = null;
  let requests = 0;
  const done = (text: string | null, failure?: string): AgentResult => ({ text, ...(failure ? { failure } : {}), model, stop, requests, usage });
  while (requests < MAX_REQUESTS) {
    requests += 1;
    let msg: Message;
    try {
      msg = await a.call(requestBody(a.job, a.system, messages));
    } catch (e) {
      return done(null, safeError(e));
    }
    model = msg.model || model;
    stop = msg.stop_reason;
    mergeUsage(usage, msg.usage, true);
    if (stop === 'end_turn') {
      const text = msg.content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('');
      return text.trim() ? done(text) : done(null, 'empty answer');
    }
    if (stop !== 'tool_use') return done(null, `stop reason ${stop ?? 'none'}`);
    messages.push({ role: 'assistant', content: msg.content });
    const results: Block[] = [];
    for (const b of msg.content) if (b.type === 'tool_use') results.push(await runTool(b, topics, a.fetch));
    if (!results.length) return done(null, 'tool_use without a tool call');
    messages.push({ role: 'user', content: results });
  }
  return done(null, 'request cap reached');
}

export function summary(job: Job, r: AgentResult, fetches: number): string {
  const u = r.usage;
  return (
    `${job}: ${r.model}, stop ${r.stop ?? 'none'}, ${r.requests} requests, ${fetches} fetches, ` +
    `tokens in ${u.input_tokens} cache-read ${u.cache_read_input_tokens} cache-write ${u.cache_creation_input_tokens} out ${u.output_tokens}` +
    (r.failure ? `; failed: ${r.failure}` : '')
  );
}

async function main(): Promise<void> {
  const [job, owner] = process.argv.slice(2) as [Job, Owner];
  if (!Object.hasOwn(JOBS, job) || !OWNERS.includes(owner)) throw new Error('usage: node src/agent.ts judge|talk <owner>');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const spec = JOBS[job];
  const fetch = limitedFetch((url) => httpText(url, 'error'), MAX_FETCHES, FETCH_GAP_MS);
  const r = await runAgent({
    job,
    system: readFileSync(spec.prompt, 'utf8'),
    input: readFileSync(spec.input(owner), 'utf8'),
    call: (body) => createMessage(body, { apiKey }),
    fetch,
  });
  console.log(summary(job, r, fetch.used()));
  if (r.text === null) {
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(spec.output(owner)), { recursive: true });
  writeFileSync(spec.output(owner), r.text);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`agent failed: ${safeError(e)}`);
    process.exit(1);
  });
}
