import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  allowedTopics,
  checkFetchUrl,
  MAX_FETCHES,
  MAX_REQUESTS,
  MODEL,
  QUERY_MAX,
  requestBody,
  runAgent,
  summary,
  type AgentInput,
} from '../src/agent.ts';
import { ApiError, type Block, type Message } from '../src/claude.ts';
import { httpText, limitedFetch } from '../src/http.ts';
import type { Fetch } from '../src/sources/source.ts';
import { ANSWERS_SCHEMA, parseAnswers, parseVerdicts, type ProposalIn } from '../src/verdicts.ts';
import { KEYS, validateWatch, watchId, type Watch } from '../src/watches.ts';
import { fixture } from './helpers.ts';

const MARKER = 'MARKER-zq81x';
const TOPIC = 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=875958';

const judgeInput = JSON.stringify({
  listings: [{ id: 'hv:875958', title: `M: RTX ${MARKER}`, url: TOPIC, forum: 3, posted: '2026-11-15T18:18:56Z', text: `Müüa ${MARKER}`, watches: ['operator-ddr5'] }],
  watches: [{ id: 'operator-ddr5', name: 'DDR5', max_eur: 300, bundles: true, brief: 'DDR5', marks: [] }],
  reference: {},
});

const talkInput = JSON.stringify({
  owner: 'operator',
  messages: [
    { update_id: 500001, text: 'kas see on hea hind?', reply_to_alert: { title: 'M: RTX', url: TOPIC, item: 'x', asking_eur: 90, effective_eur: 90 } },
    { update_id: 500002, text: 'vaata ka https://foorum.hinnavaatlus.ee/viewtopic.php?t=876001 palun' },
  ],
  watches: [],
  forums: { '3': 'computer parts' },
});

const verdictsText = JSON.stringify({
  verdicts: [
    {
      id: 'hv:875958',
      watch: 'operator-ddr5',
      fits: true,
      item: `16 GB DDR5 SO-DIMM ${MARKER}`,
      asking_eur: 90,
      rest_value_eur: null,
      effective_eur: 90,
      kind: 'ok',
      confidence: 'high',
      reason_et: 'Mälu eraldi, hind on paigas.',
    },
  ],
});

const msg = (content: Block[], stop: string): Message => ({
  model: MODEL,
  content,
  stop_reason: stop,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
});
const text = (t: string, stop = 'end_turn') => msg([{ type: 'text', text: t }], stop);
let toolN = 0;
const toolUse = (...urls: string[]) =>
  msg(
    [{ type: 'thinking', thinking: '', signature: 'c2ln' }, ...urls.map((url): Block => ({ type: 'tool_use', id: `toolu_${++toolN}`, name: 'fetch_page', input: { url } }))],
    'tool_use',
  );

/** A fake API answering from a script, recording each request body. */
function api(script: Message[]) {
  const bodies: Record<string, unknown>[] = [];
  const call = async (body: Record<string, unknown>) => {
    bodies.push(structuredClone(body));
    const next = script.shift();
    if (!next) throw new Error('script ran out');
    return next;
  };
  return { call, bodies };
}

/** A fake forum: records URLs and answers with the topic or search fixture. */
function forum() {
  const urls: string[] = [];
  const f = limitedFetch(
    async (url) => {
      urls.push(url);
      return url.includes('/search/') ? fixture('hinnavaatlus/search.html') : fixture('hinnavaatlus/topic.html');
    },
    MAX_FETCHES,
    0,
  );
  return { f, urls };
}

function run(job: 'judge' | 'talk', input: string, script: Message[], fetch: Fetch = forum().f): Promise<Awaited<ReturnType<typeof runAgent>>> & { api: ReturnType<typeof api> } {
  const a = api(script);
  const p = runAgent({ job, system: 'prompt', input, call: a.call, fetch } satisfies AgentInput);
  return Object.assign(p, { api: a });
}

const results = (body: Record<string, unknown> | undefined): Block[] => {
  const messages = (body?.messages ?? []) as { role: string; content: Block[] }[];
  return messages[messages.length - 1]?.content ?? [];
};

test('a judge run ends with a file parseVerdicts accepts', async () => {
  const r = await run('judge', judgeInput, [text(verdictsText)]);
  assert.equal(r.text, verdictsText);
  assert.deepEqual(parseVerdicts(r.text as string).errors, []);
  assert.equal(r.requests, 1);
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 });
});

test('the request: model, the schema, caching, the strict tool and no sampling parameters', () => {
  const body = requestBody('talk', 'prompt', [{ role: 'user', content: '{}' }]);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.max_tokens, 32_000);
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  const format = (body.output_config as { format: { type: string; schema: { properties: object } } }).format;
  assert.equal(format.type, 'json_schema');
  assert.deepEqual(Object.keys(format.schema.properties), ['replies', 'proposals']);
  const tools = body.tools as { name: string; strict: boolean }[];
  assert.deepEqual(tools.map((t) => [t.name, t.strict]), [['fetch_page', true]]);
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) assert.ok(!(k in body), k);
});

test('a proposal schema field for every watch key but owner', () => {
  const proposal = (ANSWERS_SCHEMA.properties.proposals as { items: { properties: { fields: { properties: object } } } }).items;
  assert.deepEqual(Object.keys(proposal.properties.fields.properties).sort(), [...KEYS].filter((k) => k !== 'owner').sort());
});

test('a talk proposal passes parseAnswers and, after act spreads it, validateWatch', () => {
  const fields = { name: 'Beebikäru', forums: [70], include: ['käru', 'vanker'], max_eur: 150, brief: 'Kasutatud beebikäru heas korras.' };
  const raw = JSON.stringify({ replies: [], proposals: [{ update_id: 500001, action: 'create', slug: 'beebikaru', fields, summary_et: 'Uus otsing.' }] });
  const { answers, errors } = parseAnswers(raw);
  assert.deepEqual(errors, []);
  const p = answers.proposals[0] as ProposalIn;
  const watch = { active: true, exclude: [], bundles: false, ...p.fields, owner: 'operator' } as Watch;
  assert.deepEqual(validateWatch(watchId('operator', p.slug), watch), []);
});

test('talk fetches the alert it replies to and a topic the person linked; earlier blocks go back unchanged', async () => {
  const fake = forum();
  const r = run('talk', talkInput, [toolUse(TOPIC), toolUse('https://foorum.hinnavaatlus.ee/viewtopic.php?t=876001', 'https://www.hinnavaatlus.ee/search/?query=ddr5%20so-dimm'), text('{"replies": [], "proposals": []}')], fake.f);
  const done = await r;
  assert.equal(done.text, '{"replies": [], "proposals": []}');
  assert.deepEqual(fake.urls, [TOPIC, 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=876001', 'https://www.hinnavaatlus.ee/search/?query=ddr5%20so-dimm']);
  const first = results(r.api.bodies[1]);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.type, 'tool_result');
  assert.match(String(first[0]?.content), /seller\]\nMüüa heas korras/);
  const second = results(r.api.bodies[2]);
  assert.equal(second.length, 2, 'both results in one user message');
  assert.match(String(second[1]?.content), /^\[\{"name":/);
  const assistant = (r.api.bodies[1]?.messages as { role: string; content: Block[] }[])[1];
  assert.deepEqual(assistant?.content[0], { type: 'thinking', thinking: '', signature: 'c2ln' });
});

test('the allowlist: only topics in the input and a short price search, rebuilt by us', () => {
  const topics = allowedTopics('talk', talkInput);
  assert.deepEqual([...topics].sort(), ['875958', '876001']);
  const strangerLink = JSON.parse(judgeInput) as { listings: { text: string }[] };
  (strangerLink.listings[0] as { text: string }).text += ' vt https://foorum.hinnavaatlus.ee/viewtopic.php?t=777777';
  assert.deepEqual([...allowedTopics('judge', JSON.stringify(strangerLink))], ['875958'], 'a link in a listing text is not a listing');
  assert.deepEqual(checkFetchUrl(`${TOPIC}#p1`, topics), { url: TOPIC, kind: 'topic' });
  const refused = [
    'https://evil.example/viewtopic.php?t=875958',
    'http://foorum.hinnavaatlus.ee/viewtopic.php?t=875958',
    'https://foorum.hinnavaatlus.ee:8443/viewtopic.php?t=875958',
    Object.assign(new URL(TOPIC), { username: 'user' }).href,
    'https://foorum.hinnavaatlus.ee/posting.php?t=875958',
    'https://foorum.hinnavaatlus.ee/viewtopic.php?t=875958&x=1',
    'https://foorum.hinnavaatlus.ee/viewtopic.php?t=999999',
    'https://foorum.hinnavaatlus.ee.evil.example/viewtopic.php?t=875958',
    `https://www.hinnavaatlus.ee/search/?query=${'a'.repeat(QUERY_MAX + 1)}`,
    'https://www.hinnavaatlus.ee/search/?query=',
    'https://www.hinnavaatlus.ee/products/?query=x',
    'not a url',
  ];
  for (const u of refused) assert.equal(typeof checkFetchUrl(u, topics), 'string', u);
  assert.deepEqual(checkFetchUrl(`https://www.hinnavaatlus.ee/search/?query=${'a'.repeat(QUERY_MAX)}`, topics), {
    url: `https://www.hinnavaatlus.ee/search/?query=${'a'.repeat(QUERY_MAX)}`,
    kind: 'search',
  });
});

test('a refused URL and a sixth fetch come back as errors, with no request made', async () => {
  const fake = forum();
  const r = run('judge', judgeInput, [toolUse('https://evil.example/x', ...Array<string>(MAX_FETCHES + 1).fill(TOPIC)), text(verdictsText)], fake.f);
  await r;
  const res = results(r.api.bodies[1]);
  assert.equal(res.length, MAX_FETCHES + 2);
  assert.match(String(res[0]?.content), /^refused:/);
  assert.equal(res[0]?.is_error, true);
  assert.match(String(res[MAX_FETCHES + 1]?.content), /request cap/);
  assert.equal(res[MAX_FETCHES + 1]?.is_error, true);
  assert.equal(fake.urls.length, MAX_FETCHES);
});

test('a refusal, max_tokens and an empty answer write no file', async () => {
  for (const [m, why] of [
    [text('', 'refusal'), 'stop reason refusal'],
    [text('{"verdicts": [', 'max_tokens'), 'stop reason max_tokens'],
    [text('  '), 'empty answer'],
  ] as const) {
    const r = await run('judge', judgeInput, [m]);
    assert.equal(r.text, null);
    assert.equal(r.failure, why);
  }
});

test('an API error ends the run with its fixed words and the counts so far', async () => {
  const a = api([toolUse(TOPIC)]);
  const call = async (body: Record<string, unknown>) => (a.bodies.length ? Promise.reject(new ApiError(400, 'invalid_request_error', 'Your credit balance is too low')) : a.call(body));
  const r = await runAgent({ job: 'judge', system: 'p', input: judgeInput, call, fetch: forum().f });
  assert.equal(r.text, null);
  assert.equal(r.failure, 'API 400 invalid_request_error credits');
  assert.equal(r.requests, 2);
  assert.equal(r.usage.input_tokens, 100);
});

test('a page with no posts says so instead of an empty result', async () => {
  const r = run('judge', judgeInput, [toolUse(TOPIC), text(verdictsText)], async () => '<html></html>');
  await r;
  assert.equal(results(r.api.bodies[1])[0]?.content, 'no posts on this page');
});

test('the request cap stops a model that keeps fetching', async () => {
  const script = Array.from({ length: MAX_REQUESTS + 2 }, () => toolUse('https://evil.example/x'));
  const r = run('judge', judgeInput, script);
  const done = await r;
  assert.equal(done.text, null);
  assert.equal(done.failure, 'request cap reached');
  assert.equal(r.api.bodies.length, MAX_REQUESTS);
});

test('nothing the run prints holds input or model text', async () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.join(' '));
  try {
    const r = await run('judge', judgeInput, [toolUse(TOPIC), text(verdictsText)]);
    printed.push(summary('judge', r, 1));
  } finally {
    console.log = log;
  }
  assert.match(printed.join('\n'), /^judge: claude-sonnet-5-5, stop end_turn, 2 requests, 1 fetches, tokens in 200 cache-read 100 cache-write 20 out 40$/);
  assert.doesNotMatch(printed.join('\n'), new RegExp(MARKER));
});

test('the agent fetch refuses a redirect', async () => {
  const server = createServer((req, res) => (req.url === '/' ? res.writeHead(200).end('ok') : res.writeHead(302, { location: '/' }).end()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    assert.equal(await httpText(`http://127.0.0.1:${port}/`, 'error'), 'ok');
    assert.equal(await httpText(`http://127.0.0.1:${port}/r`), 'ok', 'collect still follows');
    await assert.rejects(httpText(`http://127.0.0.1:${port}/r`, 'error'));
  } finally {
    server.close();
  }
});
