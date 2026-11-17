import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_VERSION, ApiError, createMessage, readStream } from '../src/claude.ts';

type Ev = [string, Record<string, unknown>];

/** A response body of server-sent events, cut into small chunks so events split across reads. */
function sse(events: Ev[]): ReadableStream<Uint8Array> {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
}

function messageEvents(blocks: Ev[], stop: string, usage = { output_tokens: 5 }): Ev[] {
  return [
    ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 2 } } }],
    ['ping', { type: 'ping' }],
    ...blocks,
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

const textBlock = (i: number, parts: string[]): Ev[] => [
  ['content_block_start', { index: i, content_block: { type: 'text', text: '' } }],
  ...parts.map((t): Ev => ['content_block_delta', { index: i, delta: { type: 'text_delta', text: t } }]),
  ['content_block_stop', { index: i }],
];

test('a text answer is folded from its deltas, with usage', async () => {
  const m = await readStream(sse(messageEvents(textBlock(0, ['{"verd', 'icts": []}']), 'end_turn')));
  assert.equal(m.model, 'claude-sonnet-5-5');
  assert.equal(m.stop_reason, 'end_turn');
  assert.deepEqual(m.content, [{ type: 'text', text: '{"verdicts": []}' }]);
  assert.deepEqual(m.usage, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 });
});

test('a tool call, a thinking block with its signature and an unknown block are kept as they came', async () => {
  const m = await readStream(
    sse(
      messageEvents(
        [
          ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
          ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '' } }],
          ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'c2ln' } }],
          ['content_block_stop', { index: 0 }],
          ['content_block_start', { index: 1, content_block: { type: 'new_kind', data: 'opaque', nested: { a: 1 } } }],
          ['content_block_stop', { index: 1 }],
          ['content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'fetch_page', input: {} } }],
          ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"url": "https://foorum.' } }],
          ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: 'hinnavaatlus.ee/viewtopic.php?t=1"}' } }],
          ['content_block_stop', { index: 2 }],
        ],
        'tool_use',
      ),
    ),
  );
  assert.equal(m.stop_reason, 'tool_use');
  assert.deepEqual(m.content[0], { type: 'thinking', thinking: '', signature: 'c2ln' });
  assert.deepEqual(m.content[1], { type: 'new_kind', data: 'opaque', nested: { a: 1 } });
  assert.deepEqual(m.content[2], { type: 'tool_use', id: 'toolu_1', name: 'fetch_page', input: { url: 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=1' } });
});

test('an unknown delta type fails the request', async () => {
  const events = messageEvents(
    [
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'surprise_delta', x: 1 } }],
    ],
    'end_turn',
  );
  await assert.rejects(readStream(sse(events)), /unknown delta type surprise_delta/);
});

function fakeFetch(responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}

const ok = () => new Response(sse(messageEvents(textBlock(0, ['{}']), 'end_turn')), { status: 200 });
const errorJson = (status: number, type: string, message: string, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers });

test('the request carries the key, the version and stream: true', async () => {
  const { f, calls } = fakeFetch([ok]);
  await createMessage({ model: 'm', messages: [] }, { apiKey: 'sk-test', fetch: f });
  const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
  assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-test');
  assert.equal(init.headers['anthropic-version'], API_VERSION);
  assert.deepEqual(JSON.parse(String(init.body)), { model: 'm', messages: [], stream: true });
});

test('a 529, then a mid-stream error, then success: three attempts, with the backoff and retry-after', async () => {
  const midStream = () =>
    new Response(sse([...messageEvents([], 'end_turn').slice(0, 2), ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]]), { status: 200 });
  const { f, calls } = fakeFetch([errorJson(529, 'overloaded_error', 'Overloaded', { 'retry-after': '3' }), midStream, ok]);
  const waits: number[] = [];
  const m = await createMessage({}, { apiKey: 'k', fetch: f, sleep: async (ms) => void waits.push(ms) });
  assert.equal(m.stop_reason, 'end_turn');
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [3000, 20_000]);
});

test('three failures in a row give up with the last error', async () => {
  const { f, calls } = fakeFetch([errorJson(500, 'api_error', 'x'), errorJson(500, 'api_error', 'x'), errorJson(500, 'api_error', 'x')]);
  await assert.rejects(createMessage({}, { apiKey: 'k', fetch: f, sleep: async () => {} }), /API 500 api_error/);
  assert.equal(calls.length, 3);
});

test('an empty credit balance is not retried and names credits, never the message', async () => {
  const { f, calls } = fakeFetch([errorJson(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.')]);
  const e = await createMessage({}, { apiKey: 'k', fetch: f }).catch((x: unknown) => x);
  assert.ok(e instanceof ApiError);
  assert.equal(e.message, 'API 400 invalid_request_error credits');
  assert.equal(calls.length, 1);
  const limit = fakeFetch([errorJson(400, 'invalid_request_error', 'This workspace has reached its spend limit.')]);
  await assert.rejects(createMessage({}, { apiKey: 'k', fetch: limit.f }), { message: 'API 400 invalid_request_error limit' });
});

test('a connection lost mid-body is retried', async () => {
  const cut = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
          c.error(new TypeError('terminated'));
        },
      }),
      { status: 200 },
    );
  const { f, calls } = fakeFetch([cut, ok]);
  const m = await createMessage({}, { apiKey: 'k', fetch: f, sleep: async () => {} });
  assert.equal(m.stop_reason, 'end_turn');
  assert.equal(calls.length, 2);
});

test('a network error is retried', async () => {
  const { f, calls } = fakeFetch([
    () => {
      throw new TypeError('fetch failed');
    },
    ok,
  ]);
  await createMessage({}, { apiKey: 'k', fetch: f, sleep: async () => {} });
  assert.equal(calls.length, 2);
});
