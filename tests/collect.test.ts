import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCollect, type CollectInput } from '../src/collect.ts';
import { limitedFetch } from '../src/http.ts';
import { forumUrl, hinnavaatlus, searchUrl } from '../src/sources/hinnavaatlus.ts';
import type { Fetch, Source } from '../src/sources/source.ts';
import { emptyState, type State } from '../src/state.ts';
import type { RawUpdate } from '../src/telegram.ts';
import { CHATS, DDR5_WATCH, fixture, loaded, update, watch } from './helpers.ts';

const NOW = new Date('2026-11-17T10:13:00Z'); // 12:13 Tallinn, judge slot 12

/** The fixture forum as of `now`: every item posted an hour before, unless told otherwise. */
function forum(now: Date, ageHours: Record<string, number> = {}): { source: Source; urls: string[] } {
  const urls: string[] = [];
  const pages: Record<string, string> = {
    [forumUrl(3)]: fixture('hinnavaatlus/forum-3.html'),
    [forumUrl(59)]: '<html></html>',
    [searchUrl(DDR5_WATCH.reference_query as string)]: fixture('hinnavaatlus/search.html'),
  };
  const source: Source = {
    ...hinnavaatlus,
    async listNew(forums, f, isSeen) {
      const items = await hinnavaatlus.listNew(forums, f, isSeen);
      return items.map((i) => ({ ...i, posted: new Date(now.getTime() - (ageHours[i.id] ?? 1) * 3600_000).toISOString() }));
    },
  };
  const fetch: Fetch = async (url) => {
    urls.push(url);
    if (url.includes('smartfeed.php')) return fixture('hinnavaatlus/feed.xml');
    const page = pages[url];
    if (page === undefined) throw new Error(`unexpected ${url}`);
    return page;
  };
  return { source: { ...source, listNew: (forums, _f, isSeen) => source.listNew(forums, fetch, isSeen), referencePrices: (q) => hinnavaatlus.referencePrices(q, fetch) }, urls };
}

const seededState = (): State => ({ ...emptyState(), seeded: true });

function input(over: Partial<CollectInput> = {}): CollectInput {
  const { source } = forum(over.now ?? NOW);
  return {
    now: NOW,
    state: seededState(),
    watches: [loaded('operator-ddr5', DDR5_WATCH)],
    feedback: {},
    prices: [],
    chats: CHATS,
    updates: [],
    source,
    fetch: async () => '',
    ...over,
  };
}

test('seeding marks everything seen and alerts nothing', async () => {
  const r = await runCollect(input({ state: null }));
  assert.equal(r.state.seen.length, 5);
  assert.equal(r.state.pending.length, 0);
  assert.equal(r.outputs.judge_now, false);
  assert.deepEqual(r.judge, {});
  // The next run finds nothing new, with the feed as its only request.
  const quiet = forum(NOW);
  const r2 = await runCollect(input({ state: r.state, source: quiet.source }));
  assert.equal(r2.counts.fresh, 0);
  assert.equal(r2.state.pending.length, 0);
  assert.equal(quiet.urls.length, 1);
  assert.match(quiet.urls[0] as string, /smartfeed\.php/);
});

test('a state saved only by the failure alert still seeds', async () => {
  const r = await runCollect(input({ state: { ...emptyState(), lastFailureAlert: NOW.toISOString() } }));
  assert.equal(r.state.pending.length, 0);
  assert.equal(r.state.seen.length, 5);
  assert.equal(r.state.seeded, true);
  assert.equal(r.state.lastFailureAlert, NOW.toISOString());
});

test('a forum outage keeps answering, and fails the run after six hours', async () => {
  const down: Source = { ...hinnavaatlus, listNew: async () => Promise.reject(new Error('HTTP 503 from foorum.hinnavaatlus.ee')) };
  const logs: string[] = [];
  const r = await runCollect(input({ source: down, updates: [update('text.json') as RawUpdate], log: (l) => logs.push(l) }));
  assert.deepEqual(r.outputs.senders, ['operator']);
  assert.equal(r.state.sourceFailedSince, NOW.toISOString());
  assert.match(logs[0] as string, /forum unavailable: HTTP 503/);
  const later = new Date(NOW.getTime() + 6 * 3600_000);
  await assert.rejects(runCollect(input({ now: later, state: r.state, source: down })), /503/);
  const back = await runCollect(input({ state: r.state }));
  assert.equal(back.state.sourceFailedSince, null);
});

test('candidates of a paused watch are not judged', async () => {
  const r = await runCollect(input());
  const paused = loaded('operator-ddr5', { ...DDR5_WATCH, active: false });
  const next = await runCollect(input({ state: r.state, watches: [paused], now: new Date('2026-11-17T15:13:00Z') }));
  assert.equal(next.state.pending.length, 0);
  assert.equal(next.outputs.judge_now, false);
});

test('the first watch keeps the two DDR5 listings and records why the rest passed', async () => {
  const r = await runCollect(input());
  assert.deepEqual(
    r.state.pending.map((c) => c.key),
    ['hv:874642', 'hv:875412'],
  );
  const passes = r.state.passes['operator-ddr5'] ?? [];
  assert.deepEqual(
    passes.map((p) => [p.code, p.detail]),
    [
      ['excluded', 'sülearvuti'],
      ['excluded', 'ddr4 unless ddr5'],
    ],
  );
  // The laptop is in forum 59, which this watch does not read.
  assert.ok(!passes.some((p) => p.title.includes('Alienware')));
  assert.equal(r.state.weekly['operator-ddr5']?.[0]?.seen, 4);
  // The picture travels with its item.
  assert.equal(r.state.pending[1]?.picture, 'https://www.upload.ee/thumb/19892700/20261026_165637.jpg');
});

test('seen ids are not taken again, and pending holds no duplicates', async () => {
  const r = await runCollect(input());
  const again = await runCollect(input({ state: structuredClone(r.state), now: new Date(NOW.getTime() + 600_000) }));
  assert.equal(again.counts.fresh, 0);
  assert.equal(again.state.pending.length, 2);
  assert.equal(new Set(again.state.seen).size, again.state.seen.length);
});

test('an item older than the feed window is skipped', async () => {
  const { source } = forum(NOW, { '874642': 30 });
  const r = await runCollect(input({ source }));
  assert.deepEqual(
    r.state.pending.map((c) => c.key),
    ['hv:875412'],
  );
  assert.ok(r.state.seen.includes('hv:874642'));
});

test('two watches of two owners', async () => {
  const laptops = loaded('partner-laptop', watch({ owner: 'partner', forums: [59], include: ['laptop', 'sülearvuti'] }));
  const r = await runCollect(input({ watches: [loaded('operator-ddr5', DDR5_WATCH), laptops] }));
  const alien = r.state.pending.find((c) => c.key === 'hv:875884');
  assert.deepEqual(alien?.watches, ['partner-laptop']);
  assert.equal(r.state.pending.length, 3);
  assert.equal(r.outputs.judge_now, true);
  // Each owner's judge sees only that owner's watches and the listings kept for them.
  assert.deepEqual(r.outputs.judges, ['operator', 'partner']);
  assert.deepEqual(r.judge.operator?.watches.map((w) => w.id), ['operator-ddr5']);
  assert.deepEqual(r.judge.partner?.watches.map((w) => w.id), ['partner-laptop']);
  assert.deepEqual(r.judge.partner?.listings.map((l) => l.id), ['hv:875884']);
  assert.ok(!JSON.stringify(r.judge.partner).includes(DDR5_WATCH.brief));
});

test('the judge runs once per slot, and a late run judges in the next slot', async () => {
  const r = await runCollect(input());
  assert.equal(r.outputs.judge_now, true);
  assert.equal(r.state.lastJudgedSlot, '2026-11-17T12');
  assert.equal(r.judge.operator?.listings.length, 2);
  assert.deepEqual(Object.keys(r.judge.operator?.reference ?? {}), ['operator-ddr5']);
  assert.equal(r.act.judged.length, 2);
  // 12:23, same slot: no second judge run.
  const same = await runCollect(input({ state: structuredClone(r.state), now: new Date('2026-11-17T10:23:00Z') }));
  assert.equal(same.outputs.judge_now, false);
  assert.equal(same.act.judged.length, 0);
  // The 17:03 run was dropped; 17:43 still judges what is pending.
  const late = await runCollect(input({ state: structuredClone(same.state), now: new Date('2026-11-17T15:43:00Z') }));
  assert.equal(late.outputs.judge_now, true);
  assert.equal(late.state.lastJudgedSlot, '2026-11-17T17');
});

test('the request cap stops reference prices, not judging', async () => {
  const { source } = forum(NOW);
  const capped = limitedFetch(async () => '', 0, 0);
  await assert.rejects(capped('https://x'), /request cap of 0/);
  const watches = Array.from({ length: 12 }, (_, i) => loaded(`operator-w${i}`, watch({ reference_query: DDR5_WATCH.reference_query as string, include: ['ddr5'] })));
  // Three reference requests left in the run's budget.
  const f = limitedFetch(async () => '', 3, 0);
  const r = await runCollect(input({ watches, source: { ...source, referencePrices: async (q) => (await f(q), []) } }));
  assert.equal(r.outputs.judge_now, true);
  assert.equal(Object.keys(r.judge.operator?.reference ?? {}).length, 3);
});

test('Telegram updates: commands, free text, replies to alerts, unknown users once', async () => {
  const state: State = seededState();
  state.alerts['1'] = {
    owner: 'operator',
    chatId: '1001',
    messageId: 501,
    key: 'hv:874642',
    watch: 'operator-ddr5',
    title: 'M: G.Skill Trident Z5 Royal Neo DDR5-6000 CL28 32GB',
    url: 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=874642',
    item: '2x16 GB DDR5-6000',
    asking_eur: 800,
    effective_eur: 800,
    at: NOW.toISOString(),
  };
  const updates = [update('text.json'), update('reply.json'), update('callback.json'), update('unknown.json'), update('group.json'), ...(update('commands.json') as RawUpdate[])] as RawUpdate[];
  const r = await runCollect(input({ state, updates }));
  assert.equal(r.state.telegramOffset, 500019);
  assert.deepEqual(r.outputs.senders, ['operator']);
  assert.equal(r.outputs.act_now, true);
  assert.equal(r.talk.length, 1);
  assert.deepEqual(
    r.talk[0]?.messages.map((m) => [m.update_id, m.reply_to_alert?.url]),
    [
      [500001, undefined],
      [500002, 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=874642'],
    ],
  );
  assert.equal(r.talk[0]?.watches[0]?.slug, 'ddr5');
  assert.equal(r.talk[0]?.forums['59'], 'laptops and tablets');
  assert.deepEqual(r.act.unknown, [{ userId: '9999', name: 'Võõras (@v66ras)' }]);
  const kinds = r.act.events.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'command').length, 9);
  assert.equal(kinds.filter((k) => k === 'callback').length, 1);
  assert.ok(!r.act.events.some((e) => e.chatId === '-100123'), 'group chats are ignored');
  const peata = r.act.events.find((e) => e.kind === 'command' && e.command === 'peata');
  assert.equal(peata?.kind === 'command' && peata.arg, '1');
  assert.ok(r.act.events.some((e) => e.kind === 'command' && e.command === 'jätka'));
  // The same unknown user again is not reported twice.
  const again = await runCollect(input({ state: r.state, updates: [{ ...(update('unknown.json') as RawUpdate), update_id: 500100 }] }));
  assert.deepEqual(again.act.unknown, []);
  assert.equal(again.outputs.act_now, false);
});

test('a talk input holds only its sender', async () => {
  const partnerText: RawUpdate = { update_id: 600001, message: { message_id: 3, from: { id: 1002 }, chat: { id: 1002, type: 'private' }, text: 'otsi lastevankrit' } };
  const watches = [loaded('operator-ddr5', DDR5_WATCH), loaded('partner-vanker', watch({ owner: 'partner', include: ['vanker'] }))];
  const r = await runCollect(input({ watches, updates: [update('text.json') as RawUpdate, partnerText] }));
  const p = r.talk.find((t) => t.owner === 'partner');
  assert.deepEqual(
    p?.messages.map((m) => m.text),
    ['otsi lastevankrit'],
  );
  assert.deepEqual(
    p?.watches.map((w) => w.slug),
    ['vanker'],
  );
});
