// collect: the run every ten minutes, with no model. Reads Telegram and the
// forum, prefilters new listings into the pending list, and decides what
// the rest of the workflow does: judge, talk to a sender, act.
//
//   node src/collect.ts --data <khe-deals-watches checkout> [--no-telegram] [--any-hour]
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { keyFromEnv, writeSealedJson } from './box.ts';
import { safeError } from './log.ts';
import { prefilter } from './prefilter.ts';
import { FORUMS, hinnavaatlus, MAX_AGE_MS } from './sources/hinnavaatlus.ts';
import { USER_AGENT, type Fetch, type Item, type ReferencePrice, type Source } from './sources/source.ts';
import { count, emptyState, loadState, recordPass, saveState, type State } from './state.ts';
import { parseChats, telegramBot, toEvents, type RawUpdate, type Unknown } from './telegram.ts';
import { isCollectHour, judgeSlot, overviewDue, weekOf } from './time.ts';
import { loadWatchDir, ownWatches, slugOf, type LoadedWatch, type Owner } from './watches.ts';
import { parseJsonl } from './watchrepo.ts';
import { BATCH, PATHS, type ActInput, type FeedbackLine, type JudgeInput, type PriceLine, type TalkInput } from './work.ts';

export const MAX_REQUESTS = 10; // to the source's hosts, per run
export const REQUEST_GAP_MS = 2000;
const MARKS_PER_WATCH = 20;
/** A forum outage shorter than this is ridden out; the feed covers a day. */
export const SOURCE_OUTAGE_MS = 6 * 3600 * 1000;
const PRICE_DAYS = 15;

export interface CollectInput {
  now: Date;
  state: State | null;
  watches: LoadedWatch[];
  feedback: Record<string, FeedbackLine[]>;
  prices: PriceLine[];
  chats: Partial<Record<Owner, string>>;
  updates: RawUpdate[];
  source: Source;
  fetch: Fetch;
  log?: (line: string) => void;
}

export interface CollectResult {
  state: State;
  outputs: { judge_now: boolean; judges: Owner[]; senders: Owner[]; act_now: boolean };
  act: ActInput;
  judge: Partial<Record<Owner, JudgeInput>>;
  talk: TalkInput[];
  counts: { items: number; fresh: number; candidates: number };
}

/** A fetch that spaces requests and refuses more than `max`; `used` counts them. */
export function limitedFetch(inner: Fetch, max: number, gapMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  let used = 0;
  const f: Fetch & { used: () => number } = Object.assign(
    async (url: string) => {
      if (used >= max) throw new Error(`request cap of ${max} reached`);
      if (used > 0) await sleep(gapMs);
      used += 1;
      return inner(url);
    },
    { used: () => used },
  );
  return f;
}

export async function runCollect(input: CollectInput): Promise<CollectResult> {
  const { now, watches, chats, source } = input;
  const state = input.state ?? emptyState();
  // A state saved only by the failure alert has not seen the forum yet.
  const seeding = !state.seeded;
  const week = weekOf(now);

  // Telegram
  const { events, unknown: unknownAll } = toEvents(input.updates, chats);
  for (const u of input.updates) state.telegramOffset = Math.max(state.telegramOffset, u.update_id + 1);
  const unknown: Unknown[] = [];
  for (const u of unknownAll) {
    if (state.unknownReported.includes(u.userId) || unknown.some((x) => x.userId === u.userId)) continue;
    state.unknownReported.push(u.userId);
    unknown.push(u);
  }

  // Listings
  const active = watches.filter((w) => w.watch.active);
  const forums = [...new Set(active.flatMap((w) => w.watch.forums))];
  const seen = new Set(state.seen);
  let items: Item[] = [];
  let sourceOk = true;
  try {
    if (forums.length) items = await source.listNew(forums, input.fetch, (key) => seen.has(key));
    state.sourceFailedSince = null;
  } catch (e) {
    // Messages are still answered while the forum is down; a long outage fails the run.
    sourceOk = false;
    state.sourceFailedSince ??= now.toISOString();
    if (now.getTime() - new Date(state.sourceFailedSince).getTime() >= SOURCE_OUTAGE_MS) throw e;
    input.log?.(`forum unavailable: ${safeError(e)}`);
  }
  let fresh = 0;
  let candidates = 0;
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    state.seen.push(item.key);
    if (now.getTime() - new Date(item.posted).getTime() > MAX_AGE_MS) continue;
    fresh += 1;
    if (seeding) continue;
    const kept: string[] = [];
    for (const w of active.filter((x) => x.watch.forums.includes(item.forum))) {
      count(state, w.id, week, 'seen');
      const r = prefilter(w.watch, item.title, item.text);
      if (r.pass) recordPass(state, w.id, { at: now.toISOString(), title: item.title, code: r.code, detail: r.keyword });
      else kept.push(w.id);
    }
    if (kept.length && !state.pending.some((p) => p.key === item.key)) {
      state.pending.push({ ...item, text: item.text.slice(0, 4000), watches: kept, attempts: 0 });
      candidates += 1;
    }
  }

  if (sourceOk) state.seeded = true;
  // A paused or deleted watch is not judged.
  const activeIds = new Set(active.map((w) => w.id));
  for (const c of state.pending) c.watches = c.watches.filter((w) => activeIds.has(w));
  state.pending = state.pending.filter((c) => c.watches.length);

  // Judge
  const slot = judgeSlot(now);
  const judgeNow = !seeding && state.pending.length > 0 && state.lastJudgedSlot !== slot;
  // One judge input per owner, so one family member's watches and marks
  // never share a model context with the other's.
  const judge: Partial<Record<Owner, JudgeInput>> = {};
  const batch = judgeNow ? state.pending.slice(0, BATCH) : [];
  if (judgeNow) {
    state.lastJudgedSlot = slot;
    const ids = new Set(batch.flatMap((c) => c.watches));
    const judged = watches.filter((w) => ids.has(w.id));
    const reference: Record<string, ReferencePrice[]> = {};
    for (const w of judged) {
      const q = w.watch.reference_query;
      if (!q) continue;
      try {
        reference[w.id] = await source.referencePrices(q, input.fetch);
      } catch {
        break; // the request cap or a failed search; judging goes on without it
      }
    }
    for (const owner of new Set(judged.map((w) => w.watch.owner))) {
      const mine = judged.filter((w) => w.watch.owner === owner);
      const mineIds = new Set(mine.map((w) => w.id));
      judge[owner] = {
        listings: batch.flatMap((c) => {
          const ws = c.watches.filter((w) => mineIds.has(w));
          return ws.length ? [{ id: c.key, title: c.title, url: c.url, forum: c.forum, posted: c.posted, text: c.text, watches: ws }] : [];
        }),
        watches: mine.map((w) => ({
        id: w.id,
        name: w.watch.name,
        max_eur: w.watch.max_eur,
        bundles: w.watch.bundles,
        brief: w.watch.brief,
        marks: (input.feedback[w.id] ?? [])
          .filter((f) => f.mark !== 'ostsin')
          .slice(-MARKS_PER_WATCH)
          .map((f) => ({ mark: f.mark, title: f.title, effective_eur: f.effective_eur })),
        })),
        reference: Object.fromEntries(Object.entries(reference).filter(([id]) => mineIds.has(id))),
      };
    }
  }

  // Talk
  const senders = [...new Set(events.filter((e) => e.kind === 'text').map((e) => e.owner))];
  const talk: TalkInput[] = senders.map((owner) => {
    const alertByMessage = new Map(Object.values(state.alerts).filter((a) => a.owner === owner).map((a) => [a.messageId, a]));
    return {
      owner,
      messages: events.flatMap((e) => {
        if (e.kind !== 'text' || e.owner !== owner) return [];
        const a = e.replyTo === undefined ? undefined : alertByMessage.get(e.replyTo);
        return [
          {
            update_id: e.updateId,
            text: e.text,
            ...(a ? { reply_to_alert: { title: a.title, url: a.url, item: a.item, asking_eur: a.asking_eur, effective_eur: a.effective_eur } } : {}),
          },
        ];
      }),
      watches: ownWatches(watches, owner).map((w, i) => ({ number: i + 1, slug: slugOf(w.id), watch: w.watch })),
      forums: Object.fromEntries(FORUMS.map((f) => [String(f.id), f.about])),
    };
  });

  const since = now.getTime() - PRICE_DAYS * 86400_000;
  const act: ActInput = {
    events,
    unknown,
    judged: batch,
    judges: Object.keys(judge) as Owner[],
    talkSenders: senders,
    watches,
    prices: input.prices.filter((p) => new Date(p.date).getTime() >= since),
  };
  // act runs after every judge run too: it records the verdicts, or the failed attempt.
  const actNow = judgeNow || events.length > 0 || unknown.length > 0 || overviewDue(now, state.lastOverviewWeek);
  return {
    state,
    outputs: { judge_now: judgeNow, judges: Object.keys(judge) as Owner[], senders, act_now: actNow },
    act,
    judge,
    talk,
    counts: { items: items.length, fresh, candidates },
  };
}

function readJsonl<T>(path: string): T[] {
  return existsSync(path) ? parseJsonl<T>(readFileSync(path, 'utf8')) : [];
}

export function readData(root: string): { watches: LoadedWatch[]; feedback: Record<string, FeedbackLine[]>; prices: PriceLine[] } {
  const { watches, errors } = loadWatchDir(join(root, 'watches'));
  if (errors.length) throw new Error(`watch files are invalid: ${errors.length} problem(s); run check:watches`);
  const feedback: Record<string, FeedbackLine[]> = {};
  for (const w of watches) feedback[w.id] = readJsonl<FeedbackLine>(join(root, 'feedback', `${w.id}.jsonl`));
  const dir = join(root, 'prices');
  const months = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().slice(-2) : [];
  const prices = months.flatMap((f) => readJsonl<PriceLine>(join(dir, f)));
  return { watches, feedback, prices };
}

export async function httpText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

/** `collected=false` outside collection hours, when no state was written. */
function writeOutputs(o: CollectResult['outputs'], collected: boolean): void {
  const lines = `collected=${collected}\njudge_now=${o.judge_now}\njudges=${JSON.stringify(o.judges)}\nsenders=${JSON.stringify(o.senders)}\nact_now=${o.act_now}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { data: { type: 'string' }, 'no-telegram': { type: 'boolean' }, 'any-hour': { type: 'boolean' } } });
  if (!values.data) throw new Error('usage: node src/collect.ts --data <khe-deals-watches checkout> [--no-telegram] [--any-hour]');
  const now = new Date();
  if (!values['any-hour'] && !isCollectHour(now)) {
    console.log('outside collection hours (06-23 Tallinn)');
    writeOutputs({ judge_now: false, judges: [], senders: [], act_now: false }, false);
    return;
  }
  const key = keyFromEnv();
  const state = loadState(PATHS.state, key);
  const data = readData(values.data);
  const noTelegram = Boolean(values['no-telegram']);
  const chats = noTelegram && !process.env.TELEGRAM_CHATS ? {} : parseChats(process.env.TELEGRAM_CHATS);
  let updates: RawUpdate[] = [];
  if (!noTelegram) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    updates = await telegramBot(token).getUpdates(state?.telegramOffset ?? 0);
  }
  const f = limitedFetch(httpText, MAX_REQUESTS, REQUEST_GAP_MS);
  const r = await runCollect({ now, state, ...data, chats, updates, source: hinnavaatlus, fetch: f, log: (l) => console.log(l) });

  saveState(PATHS.state, r.state, key);
  writeSealedJson(PATHS.act, r.act, key);
  for (const [owner, j] of Object.entries(r.judge)) writeSealedJson(PATHS.judge(owner as Owner), j, key);
  for (const t of r.talk) writeSealedJson(PATHS.talk(t.owner), t, key);
  writeOutputs(r.outputs, true);
  console.log(
    `${state?.seeded ? '' : 'seeding: '}${r.counts.items} items, ${r.counts.fresh} new, ${r.counts.candidates} candidates, ${r.state.pending.length} pending, ` +
      `${f.used()} requests, ${updates.length} updates, judge ${r.outputs.judge_now}, senders ${r.outputs.senders.length}`,
  );
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`collect failed: ${safeError(e)}`);
    process.exit(1);
  });
}
