import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELP, overviewText, passText, runAct, runFailure, type ActDeps } from '../src/act.ts';
import type { Scanner } from '../src/scan.ts';
import { emptyState, type Candidate, type PassCode, type State } from '../src/state.ts';
import type { Event } from '../src/telegram.ts';
import type { Verdict } from '../src/verdicts.ts';
import { blobSha, formatWatch, type Watch } from '../src/watches.ts';
import type { ActInput, PriceLine } from '../src/work.ts';
import { CHATS, DDR5_WATCH, fakeBot, fakeRepo, loaded, watch } from './helpers.ts';

const NOW = new Date('2026-11-17T10:13:00Z'); // Tuesday 12:13 Tallinn
const W = 'operator-ddr5';

const scanHitsSecret: Scanner = async (texts) => texts.map((t) => t.includes('SECRET'));

function repoWith(watches: Record<string, Watch>) {
  return fakeRepo(Object.fromEntries(Object.entries(watches).map(([id, w]) => [`watches/${id}.json`, formatWatch(w)])));
}

function candidate(id: string, watches = [W], over: Partial<Candidate> = {}): Candidate {
  return {
    source: 'hv',
    id,
    key: `hv:${id}`,
    title: `M: Teema ${id}`,
    url: `https://foorum.hinnavaatlus.ee/viewtopic.php?t=${id}`,
    text: 'tekst',
    forum: 3,
    posted: NOW.toISOString(),
    watches,
    attempts: 0,
    ...over,
  };
}

function verdict(id: string, over: Partial<Verdict> = {}): Verdict {
  return {
    id: `hv:${id}`,
    watch: W,
    fits: true,
    item: '2x16 GB DDR5',
    asking_eur: 280,
    rest_value_eur: null,
    effective_eur: 280,
    kind: 'ok',
    confidence: 'high',
    reason_et: 'Sobib.',
    ...over,
  };
}

interface Setup {
  now?: Date;
  state?: State;
  events?: Event[];
  judged?: Candidate[];
  verdicts?: Verdict[] | string | null;
  watches?: Record<string, Watch>;
  answers?: ActDeps['answers'];
  talkSenders?: ActInput['talkSenders'];
  prices?: PriceLine[];
  bot?: ReturnType<typeof fakeBot>;
  repo?: ReturnType<typeof fakeRepo>;
  unknown?: ActInput['unknown'];
  verdictsByOwner?: ActDeps['verdicts'];
}

const rawVerdicts = (v: Setup['verdicts']) => (v === undefined || v === null || typeof v === 'string' ? (v ?? null) : JSON.stringify({ verdicts: v }));

function setup(s: Setup = {}) {
  const watches = s.watches ?? { [W]: DDR5_WATCH };
  const state = s.state ?? emptyState();
  const judged = s.judged ?? [];
  if (!s.state) state.pending = structuredClone(judged);
  const bot = s.bot ?? fakeBot();
  const repo = s.repo ?? repoWith(watches);
  let persisted = 0;
  const logs: string[] = [];
  const deps: ActDeps = {
    now: s.now ?? NOW,
    state,
    input: {
      events: s.events ?? [],
      unknown: s.unknown ?? [],
      judged,
      judges: judged.length ? ['operator', 'partner'] : [],
      talkSenders: s.talkSenders ?? [],
      watches: Object.entries(watches).map(([id, w]) => loaded(id, w)),
      prices: s.prices ?? [],
    },
    verdicts: s.verdictsByOwner ?? { operator: rawVerdicts(s.verdicts), partner: rawVerdicts(s.verdicts) },
    answers: s.answers ?? {},
    chats: CHATS,
    bot,
    repo,
    scan: scanHitsSecret,
    persist: () => void persisted++,
    log: (l) => logs.push(l),
  };
  return { deps, state, bot, repo, logs, persisted: () => persisted, run: () => runAct(deps) };
}

const cmd = (command: string, arg = '', owner: 'operator' | 'partner' = 'operator', updateId = 1): Event => ({
  kind: 'command',
  updateId,
  owner,
  chatId: CHATS[owner] as string,
  messageId: 100 + updateId,
  command,
  arg,
});

const texts = (bot: ReturnType<typeof fakeBot>) => bot.sent.filter((m) => m.text !== undefined).map((m) => m.text as string);

test('an alert at or under the limit, a pass over it', async () => {
  const t = setup({ judged: [candidate('1'), candidate('2')], verdicts: [verdict('1', { effective_eur: 300 }), verdict('2', { asking_eur: 900, rest_value_eur: 590, effective_eur: 310 })] });
  await t.run();
  assert.equal(t.bot.sent.length, 1);
  assert.match(texts(t.bot)[0] as string, /^M: Teema 1\n2x16 GB DDR5\nHind 280 €/);
  assert.deepEqual(t.state.passes[W]?.map((p) => [p.code, p.detail]), [['over_limit', '310 € > 300 €']]);
  assert.equal(t.state.pending.length, 0);
  assert.equal(t.state.weekly[W]?.[0]?.judged, 2);
  assert.equal(t.state.weekly[W]?.[0]?.alerted, 1);
});

test('the effective price is computed, not taken from the model', async () => {
  // Not a bundle watch: the rest the model names does not lower the price.
  const single = watch({ name: 'Mälu', bundles: false, max_eur: 150 });
  const t = setup({ watches: { 'operator-mem': single }, judged: [candidate('1', ['operator-mem'])], verdicts: [verdict('1', { watch: 'operator-mem', asking_eur: 300, rest_value_eur: 200, effective_eur: 100 })] });
  await t.run();
  assert.equal(t.bot.sent.length, 0);
  assert.deepEqual(t.state.passes['operator-mem']?.map((p) => p.detail), ['300 € > 150 €']);
  // A bundle: asking minus the rest, whatever effective the model wrote.
  const b = setup({ judged: [candidate('1')], verdicts: [verdict('1', { asking_eur: 900, rest_value_eur: 500, effective_eur: 100 })] });
  await b.run();
  assert.deepEqual(b.state.passes[W]?.map((p) => p.detail), ['400 € > 300 €']);
});

test('a paused watch gets no alert', async () => {
  const t = setup({ watches: { [W]: { ...DDR5_WATCH, active: false } }, judged: [candidate('1')], verdicts: [verdict('1')] });
  await t.run();
  assert.equal(t.bot.sent.length, 0);
  assert.equal(t.state.pending.length, 0);
});

test('a bundle shows the rest and the effective price', async () => {
  const t = setup({ judged: [candidate('1')], verdicts: [verdict('1', { asking_eur: 900, rest_value_eur: 650, effective_eur: 250 })] });
  await t.run();
  assert.match(texts(t.bot)[0] as string, /Hind 900 €, ülejäänu ~650 €, efektiivne 250 €/);
});

test('no price alerts with "Hind puudub"', async () => {
  const t = setup({ judged: [candidate('1')], verdicts: [verdict('1', { asking_eur: null, effective_eur: null })] });
  await t.run();
  assert.match(texts(t.bot)[0] as string, /Hind puudub/);
  assert.equal(t.repo.writes.length, 0, 'no price line without a price');
});

test('unknown ids are ignored', async () => {
  const t = setup({ judged: [candidate('1')], verdicts: [verdict('9'), verdict('1', { watch: 'partner-other' })] });
  await t.run();
  assert.equal(t.bot.sent.length, 0);
  assert.equal(t.state.pending[0]?.attempts, 1);
});

test('the link and title come from collect; foreign links in model text are stripped', async () => {
  const v = { ...verdict('1', { reason_et: 'Vaata https://evil.example/x ja https://foorum.hinnavaatlus.ee/viewtopic.php?t=1' }), url: 'https://evil.example/y', title: 'Muu' };
  const t = setup({ judged: [candidate('1')], verdicts: JSON.stringify({ verdicts: [v] }) });
  await t.run();
  const m = t.bot.sent[0];
  assert.ok(m?.text?.startsWith('M: Teema 1'));
  assert.match(m?.text ?? '', /Vaata \(link eemaldatud\) ja https:\/\/foorum\.hinnavaatlus\.ee\/viewtopic\.php\?t=1/);
  assert.equal(m?.opts?.keyboard?.[0]?.[0]?.url, 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=1');
  assert.ok(!JSON.stringify(t.bot.sent).includes('evil.example'));
});

test('an oversize verdicts file counts as no verdict', async () => {
  const t = setup({ judged: [candidate('1')], verdicts: JSON.stringify({ verdicts: [verdict('1')], pad: 'x'.repeat(70_000) }) });
  await t.run();
  assert.equal(t.bot.sent.length, 0);
  assert.equal(t.state.pending[0]?.attempts, 1);
  assert.ok(t.logs.some((l) => l.includes('64 KB')));
});

test('a scan hit replaces the text', async () => {
  const t = setup({ judged: [candidate('1')], verdicts: [verdict('1', { reason_et: 'Müüja kood SECRET' })] });
  await t.run();
  assert.match(texts(t.bot)[0] as string, /\(tekst eemaldatud\)/);
  assert.ok(!texts(t.bot)[0]?.includes('SECRET'));
});

test('a judge counts only for its own owner\'s watches', async () => {
  const pw = watch({ owner: 'partner', name: 'Käru', max_eur: 150, bundles: false });
  const forPartner = JSON.stringify({ verdicts: [verdict('1', { watch: 'partner-karu', asking_eur: 120, effective_eur: 120 })] });
  const t = setup({
    watches: { [W]: DDR5_WATCH, 'partner-karu': pw },
    judged: [candidate('1', ['partner-karu'])],
    verdictsByOwner: { operator: forPartner, partner: null },
  });
  await t.run();
  assert.equal(t.bot.sent.length, 0, "the operator's judge cannot judge the partner's watch");
  assert.equal(t.state.pending[0]?.attempts, 1);
});

test('alerts go to the watch owner', async () => {
  const pw = watch({ owner: 'partner', name: 'Käru', max_eur: 150, bundles: false });
  const t = setup({
    watches: { [W]: DDR5_WATCH, 'partner-karu': pw },
    judged: [candidate('1', ['partner-karu'])],
    verdicts: [verdict('1', { watch: 'partner-karu', asking_eur: 120, effective_eur: 120 })],
  });
  await t.run();
  assert.equal(t.bot.sent[0]?.chatId, '1002');
  assert.match(texts(t.bot)[0] as string, /Otsing: Käru/);
});

test('each kind: ok and suspicious alert, junk and bait pass; low confidence is marked', async () => {
  const t = setup({
    judged: [candidate('1'), candidate('2'), candidate('3'), candidate('4'), candidate('5')],
    verdicts: [
      verdict('1', { confidence: 'low' }),
      verdict('2', { kind: 'suspicious', reason_et: 'Küsib ettemaksu.' }),
      verdict('3', { kind: 'junk', reason_et: 'Ostusoov.' }),
      verdict('4', { kind: 'bait', reason_et: 'Pood.' }),
      verdict('5', { kind: 'suspicious', confidence: 'low', reason_et: 'Liiga odav.' }),
    ],
  });
  await t.run();
  const sent = texts(t.bot);
  assert.equal(sent.length, 3);
  assert.match(sent[0] as string, /^Ebakindel hinnang: M: Teema 1/);
  assert.match(sent[1] as string, /^Kahtlane: M: Teema 2/);
  assert.match(sent[2] as string, /^Kahtlane, ebakindel hinnang: M: Teema 5/);
  assert.deepEqual(t.state.passes[W]?.map((p) => p.code), ['junk', 'bait']);
});

test('quiet hours send silently', async () => {
  const late = setup({ now: new Date('2026-11-17T20:33:00Z'), judged: [candidate('1')], verdicts: [verdict('1')] });
  await late.run();
  assert.equal(late.bot.sent[0]?.opts?.silent, true);
  const day = setup({ judged: [candidate('1')], verdicts: [verdict('1')] });
  await day.run();
  assert.equal(day.bot.sent[0]?.opts?.silent, false);
});

test('price lines are appended in one write', async () => {
  const repo = repoWith({ [W]: DDR5_WATCH });
  repo.files.set('prices/2026-11.jsonl', '{"old":1}\n');
  const t = setup({ repo, judged: [candidate('1'), candidate('2')], verdicts: [verdict('1'), verdict('2', { fits: false, reason_et: 'SO-DIMM.' })] });
  await t.run();
  assert.deepEqual(repo.writes, ['prices/2026-11.jsonl']);
  const lines = (repo.files.get('prices/2026-11.jsonl') ?? '').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[2] as string), { date: NOW.toISOString(), source: 'hv', key: 'hv:2', watch: W, item: '2x16 GB DDR5', asking_eur: 280, effective_eur: 280 });
});

test('a picture goes with sendPhoto, and a refused picture falls back to text', async () => {
  const c = candidate('1', [W], { picture: 'https://www.upload.ee/thumb/1/a.jpg' });
  const ok = setup({ judged: [c], verdicts: [verdict('1')] });
  await ok.run();
  assert.equal(ok.bot.sent[0]?.method, 'sendPhoto');
  assert.equal(ok.bot.sent[0]?.photo, 'https://www.upload.ee/thumb/1/a.jpg');
  const refused = setup({ judged: [c], verdicts: [verdict('1')], bot: fakeBot({ failPhoto: true }) });
  await refused.run();
  assert.equal(refused.bot.sent[0]?.method, 'sendMessage');
  assert.ok(refused.state.alerts['1']);
});

test('the send record keeps a re-run from sending twice', async () => {
  const t = setup({ judged: [candidate('1')], verdicts: [verdict('1')], events: [cmd('abi')] });
  await t.run();
  assert.equal(t.bot.sent.length, 2);
  assert.ok(t.persisted() >= 2);
  // The same job again (a re-run) with the state it saved.
  const again = setup({ state: t.state, judged: [candidate('1')], verdicts: [verdict('1')], events: [cmd('abi')], bot: t.bot });
  await again.run();
  assert.equal(t.bot.sent.length, 2);
});

test('a candidate is dropped with a note after two failed judge runs', async () => {
  const first = setup({ judged: [candidate('1')], verdicts: null });
  first.state.lastJudgedSlot = '2026-11-17T07';
  await first.run();
  assert.equal(first.state.pending[0]?.attempts, 1);
  first.state.lastJudgedSlot = '2026-11-17T12';
  assert.equal(first.bot.sent.length, 0);
  const second = setup({ state: first.state, judged: [candidate('1', [W], { attempts: 1 })], verdicts: '{broken' });
  await second.run();
  assert.equal(second.state.pending.length, 0);
  assert.match(texts(second.bot)[0] as string, /^Ei suutnud seda kuulutust hinnata, vaata ise: M: Teema 1/);
  assert.equal(second.state.passes[W]?.[0]?.code, 'judge_failed');
});

test('commands are answered when the judge failed', async () => {
  const t = setup({ judged: [candidate('1')], verdicts: null, events: [cmd('otsingud')] });
  await t.run();
  assert.equal(texts(t.bot)[0], '1. DDR5 mälu (näide), kuni 300 €');
});

test('/abi, /start, /otsingud and an unknown command', async () => {
  const t = setup({ events: [cmd('abi', '', 'operator', 1), cmd('start', '', 'operator', 2), cmd('otsingud', '', 'partner', 3), cmd('foo', '', 'operator', 4)] });
  await t.run();
  const s = texts(t.bot);
  assert.equal(s[0], HELP);
  assert.equal(s[1], HELP);
  assert.match(s[2] as string, /Sul ei ole veel otsinguid/);
  assert.equal(t.bot.sent[2]?.chatId, '1002');
  assert.match(s[3] as string, /Sellist käsku ei ole/);
  assert.equal(t.bot.sent[0]?.opts?.replyTo, 101);
});

test('/peata, /jätka and /kustuta change only the sender\'s own watches', async () => {
  const t = setup({ events: [cmd('peata', '1', 'operator', 1), cmd('peata', '1', 'partner', 2), cmd('peata', 'x', 'operator', 3)] });
  await t.run();
  const s = texts(t.bot);
  assert.match(s[0] as string, /on peatatud/);
  assert.match(s[1] as string, /Sellist otsingut ei ole/);
  assert.match(s[2] as string, /Anna otsingu number/);
  const saved = JSON.parse(t.repo.files.get(`watches/${W}.json`) ?? '{}') as Watch;
  assert.equal(saved.active, false);
  const resume = setup({ repo: t.repo, watches: { [W]: saved }, events: [cmd('jätka', '1', 'operator', 4)] });
  await resume.run();
  assert.match(texts(resume.bot)[0] as string, /jälle käimas/);
  assert.equal((JSON.parse(t.repo.files.get(`watches/${W}.json`) ?? '{}') as Watch).active, true);
  const del = setup({ repo: t.repo, watches: { [W]: { ...saved, active: true } }, events: [cmd('kustuta', '1', 'operator', 5)] });
  await del.run();
  assert.match(texts(del.bot)[0] as string, /on kustutatud/);
  assert.equal(t.repo.files.has(`watches/${W}.json`), false);
});

test('numbers in one batch mean what /otsingud showed', async () => {
  const a = watch({ name: 'A' });
  const b = watch({ name: 'B' });
  const c = watch({ name: 'C' });
  const t = setup({ watches: { 'operator-a': a, 'operator-b': b, 'operator-c': c }, events: [cmd('kustuta', '1', 'operator', 1), cmd('kustuta', '2', 'operator', 2), cmd('peata', '1', 'operator', 3)] });
  await t.run();
  const s = texts(t.bot);
  assert.equal(s[0], 'Otsing "A" on kustutatud.');
  assert.equal(s[1], 'Otsing "B" on kustutatud.');
  assert.equal(s[2], 'Sellist otsingut ei ole. /otsingud näitab sinu otsinguid.');
  assert.ok(t.repo.files.has('watches/operator-c.json'));
});

test('a re-run of act does not judge the same batch twice', async () => {
  const state = emptyState();
  state.lastJudgedSlot = '2026-11-17T12';
  const first = setup({ state, judged: [candidate('1')], verdicts: null });
  first.state.pending = [candidate('1')];
  await first.run();
  assert.equal(first.state.pending[0]?.attempts, 1);
  const again = setup({ state: first.state, judged: [candidate('1')], verdicts: null });
  await again.run();
  assert.equal(again.state.pending[0]?.attempts, 1);
});

test('/miks for each reason code, and not for another user\'s watch', async () => {
  const state = emptyState();
  const codes: [PassCode, string][] = [
    ['excluded', 'ddr4 unless ddr5'],
    ['no_keyword', ''],
    ['over_limit', '410 € > 300 €'],
    ['not_fit', 'SO-DIMM'],
    ['junk', 'ostusoov'],
    ['bait', 'pood'],
    ['judge_failed', ''],
  ];
  state.passes[W] = codes.map(([code, detail], i) => ({ at: `2026-11-17T0${i}:00:00Z`, title: `T${i}`, code, detail }));
  const t = setup({ state, events: [cmd('miks', '', 'operator', 1), cmd('miks', '1', 'partner', 2), cmd('miks', '1', 'operator', 3)] });
  await t.run();
  const s = texts(t.bot);
  assert.equal(
    s[0],
    ['T0 - välistatud: ddr4, kui pole ddr5', 'T1 - ükski märksõna ei sobinud', 'T2 - üle piiri: 410 € > 300 €', 'T3 - ei sobi: SO-DIMM', 'T4 - pole see asi: ostusoov', 'T5 - edasimüüja: pood', 'T6 - hindamine ebaõnnestus'].join('\n'),
  );
  assert.match(s[1] as string, /Sellist otsingut ei ole/);
  assert.equal(s[2], s[0]);
  for (const [code, detail] of codes) assert.ok(passText(code, detail).length > 0);
});

test('a proposal is shown, /kinnita saves it, and an invalid one is refused', async () => {
  const text = (updateId: number): Event => ({ kind: 'text', updateId, owner: 'partner', chatId: '1002', messageId: 40 + updateId, text: 'otsi beebikäru alla 150 eur' });
  const good = { update_id: 7, action: 'create', slug: 'beebikaru', fields: { name: 'Beebikäru', forums: [70], include: ['käru', 'vanker'], max_eur: 150, brief: 'Kasutatud beebikäru.' }, summary_et: 'Uus otsing beebikärule.' };
  const t = setup({ events: [text(7)], talkSenders: ['partner'], answers: { partner: JSON.stringify({ replies: [], proposals: [good] }) } });
  await t.run();
  assert.match(texts(t.bot)[0] as string, /^Uus otsing beebikärule\.\n\nNimi: Beebikäru\nHind kuni: 150 €\nMärksõnad: käru, vanker\nFoorumid: Varia ja muu tehnika \(sh helitehnika ja fototehnika\) ost\/müük\/vahetus\n/);
  assert.match(texts(t.bot)[0] as string, /\/kinnita salvestab\.$/);
  assert.equal(t.bot.sent[0]?.opts?.replyTo, 47);
  assert.equal(t.state.proposals.partner?.id, 'partner-beebikaru');
  const confirm = setup({ state: t.state, repo: t.repo, events: [cmd('kinnita', '', 'partner', 8)] });
  await confirm.run();
  assert.equal(texts(confirm.bot)[0], 'Salvestatud: Beebikäru.');
  const saved = JSON.parse(t.repo.files.get('watches/partner-beebikaru.json') ?? '{}') as Watch;
  assert.equal(saved.owner, 'partner');
  assert.equal(saved.active, true);
  assert.equal(confirm.state.proposals.partner, undefined);

  const bad = { ...good, update_id: 9, fields: { ...good.fields, forums: [39] } };
  const refused = setup({ events: [text(9)], talkSenders: ['partner'], answers: { partner: JSON.stringify({ replies: [], proposals: [bad] }) } });
  await refused.run();
  assert.match(texts(refused.bot)[0] as string, /^Ettepanek ei sobinud: forum 39/);
  assert.equal(refused.state.proposals.partner, undefined);
  // The error quotes the model's value; its link is stripped like any model text.
  const linky = { ...good, update_id: 10, fields: { ...good.fields, include: ['vaata https://evil.example/pikk-tee kohe ja kiiresti'] } };
  const stripped = setup({ events: [text(10)], talkSenders: ['partner'], answers: { partner: JSON.stringify({ replies: [], proposals: [linky] }) } });
  await stripped.run();
  assert.match(texts(stripped.bot)[0] as string, /^Ettepanek ei sobinud: include: keyword "vaata \(link eemaldatud\) kohe ja kiiresti"/);
});

test('/kinnita with a stale sha is refused', async () => {
  const state = emptyState();
  state.proposals.operator = { action: 'update', id: W, watch: { ...DDR5_WATCH, max_eur: 250 }, sha: blobSha('older content'), at: NOW.toISOString() };
  const t = setup({ state, events: [cmd('kinnita', '', 'operator', 2)] });
  await t.run();
  assert.match(texts(t.bot)[0] as string, /Otsingut muudeti vahepeal/);
  assert.equal((JSON.parse(t.repo.files.get(`watches/${W}.json`) ?? '{}') as Watch).max_eur, 300);
});

test('replies go to the sender, cleaned; unanswered text gets a note', async () => {
  const ev = (updateId: number, owner: 'operator' | 'partner'): Event => ({ kind: 'text', updateId, owner, chatId: CHATS[owner] as string, messageId: updateId, text: 'kas tasub?' });
  const answers = JSON.stringify({ replies: [{ update_id: 1, text_et: 'Tasub, vaata t.me/scam' }, { update_id: 2, text_et: 'Teise inimese sõnum' }], proposals: [] });
  const t = setup({ events: [ev(1, 'operator'), ev(2, 'partner')], talkSenders: ['operator', 'partner'], answers: { operator: answers, partner: null } });
  await t.run();
  const s = texts(t.bot);
  assert.equal(s[0], 'Tasub, vaata (link eemaldatud)');
  assert.equal(t.bot.sent[0]?.chatId, '1001');
  assert.match(s[1] as string, /Ei saanud praegu vastata/);
  assert.equal(t.bot.sent[1]?.chatId, '1002');
  assert.equal(s.length, 2, 'the operator\'s answers cannot reply to the partner');
});

test('each button marks the alert; Ostsin pauses the watch', async () => {
  const state = emptyState();
  for (const id of ['1', '2', '3']) {
    state.alerts[id] = { owner: 'operator', chatId: '1001', messageId: 500 + Number(id), key: `hv:${id}`, watch: W, title: `T${id}`, url: `https://foorum.hinnavaatlus.ee/viewtopic.php?t=${id}`, item: 'x', asking_eur: 280, effective_eur: 280, at: NOW.toISOString() };
  }
  const press = (updateId: number, data: string, owner: 'operator' | 'partner' = 'operator'): Event => ({ kind: 'callback', updateId, owner, chatId: CHATS[owner] as string, queryId: `q${updateId}`, data });
  const t = setup({ state, events: [press(1, 'h:1'), press(2, 'e:2'), press(3, 'o:3'), press(4, 'h:2'), press(5, 'e:1', 'partner')], bot: fakeBot({ failAnswer: true }) });
  await t.run();
  assert.equal(state.alerts['1']?.mark, 'huvitav');
  assert.equal(state.alerts['2']?.mark, 'ei_sobi', 'a second press does not change the mark');
  assert.equal(state.alerts['3']?.mark, 'ostsin');
  const edits = t.bot.sent.filter((m) => m.method === 'editKeyboard');
  assert.equal(edits.length, 3);
  assert.equal(edits[0]?.keyboard?.[1]?.[0]?.text, 'Märgitud: Huvitav');
  const feedback = (t.repo.files.get(`feedback/${W}.jsonl`) ?? '').trim().split('\n').map((l) => JSON.parse(l) as { mark: string });
  assert.deepEqual(feedback.map((f) => f.mark), ['huvitav', 'ei_sobi', 'ostsin']);
  assert.equal((JSON.parse(t.repo.files.get(`watches/${W}.json`) ?? '{}') as Watch).active, false);
  assert.match(texts(t.bot)[0] as string, /on peatatud\. \/jätka 1/);
  // The partner's press on the operator's alert was ignored; failed answers did not stop the run.
  assert.equal(t.bot.sent.filter((m) => m.method === 'answerCallback').length, 4);
});

test('an unknown user is reported to the operator', async () => {
  const t = setup({ unknown: [{ userId: '9999', name: 'Võõras (@v66ras)' }] });
  await t.run();
  assert.equal(t.bot.sent[0]?.chatId, '1001');
  assert.match(texts(t.bot)[0] as string, /tundmatu kasutaja Võõras \(@v66ras\), id 9999/);
});

test('the failure alert goes out at most once a day', async () => {
  const state = emptyState();
  const bot = fakeBot();
  assert.equal(await runFailure(NOW, state, '1001', 'https://github.com/khelias/khe-deals/actions/runs/1', bot), true);
  assert.equal(await runFailure(new Date(NOW.getTime() + 23 * 3600_000), state, '1001', 'u', bot), false);
  assert.equal(await runFailure(new Date(NOW.getTime() + 25 * 3600_000), state, '1001', 'u', bot), true);
  assert.equal(bot.sent.length, 2);
});

test('the weekly overview: medians against the week before, sent once', async () => {
  const line = (date: string, asking: number, effective: number, item = 'x'): PriceLine => ({ date, source: 'hv', key: `hv:${date}`, watch: W, item, asking_eur: asking, effective_eur: effective });
  const prices = [
    line('2026-11-17T10:00:00Z', 400, 300),
    line('2026-11-19T10:00:00Z', 500, 260, 'i5 arvuti 2x16 GB'),
    line('2026-11-21T10:00:00Z', 600, 350),
    line('2026-11-12T10:00:00Z', 450, 310),
    line('2026-11-13T10:00:00Z', 470, 330),
  ];
  const sunday = new Date('2026-11-22T16:03:00Z'); // 18:03
  const state = emptyState();
  state.weekly[W] = [{ week: '2026-11-16', seen: 12, judged: 5, alerted: 1 }];
  const t = setup({ now: sunday, state, prices });
  await t.run();
  assert.equal(
    texts(t.bot)[0],
    [
      'Nädala ülevaade alates 16.11.',
      '',
      'DDR5 mälu (näide): nähtud 12, hinnatud 5, teavitusi 1.',
      'Mediaan: küsitud 500 € (nädal varem 460 €), efektiivne 300 € (320 €).',
      'Parim leid: i5 arvuti 2x16 GB, 260 €.',
    ].join('\n'),
  );
  assert.equal(state.lastOverviewWeek, '2026-11-16');
  const later = setup({ now: new Date('2026-11-22T16:13:00Z'), state, prices });
  await later.run();
  assert.equal(later.bot.sent.length, 0);
});

test('the overview week boundary holds across a DST change', () => {
  // Sunday 2026-10-25 is the day summer time ends; 23:30 EET that night is still its week.
  const state = emptyState();
  const p = (date: string, effective: number): PriceLine => ({ date, source: 'hv', key: date, watch: W, item: 'x', asking_eur: effective, effective_eur: effective });
  const text = overviewText([{ id: W, watch: DDR5_WATCH, sha: '' }], [p('2026-10-25T21:30:00Z', 100), p('2026-10-25T22:00:00Z', 900), p('2026-10-19T00:00:00Z', 200)], state, '2026-10-19');
  // Monday 02:00 EEST and Sunday 23:30 EET are in the week; Monday 00:00 EET after it is not.
  assert.match(text, /Mediaan: küsitud 150 € \(nädal varem \?\), efektiivne 150 € \(\?\)\./);
  assert.ok(!text.includes('900'));
  assert.match(text, /Parim leid: x, 100 €\./);
});

test('the overview marks a paused watch', () => {
  const state = emptyState();
  const text = overviewText([loaded('operator-x', watch({ name: 'X', active: false }))], [], state, '2026-11-16');
  assert.equal(text, ['Nädala ülevaade alates 16.11.', '', 'X (peatatud): nähtud 0, hinnatud 0, teavitusi 0.', 'Hindu sel nädalal ei olnud.'].join('\n'));
});
