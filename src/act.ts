// act: the model-free job that makes every write: Telegram messages and the
// users' own files in khe-deals-watches. It trusts nothing the models wrote
// beyond their schemas, and takes titles, links and pictures from collect.
// Every send and every command is recorded in the state before it is made,
// so a re-run never repeats one.
//
//   node src/act.ts [--dry-run]          node src/act.ts --failure <run-url> [--dry-run]
import { parseArgs } from 'node:util';
import { keyFromEnv, readSealedJson, readSealedText } from './box.ts';
import { safeError } from './log.ts';
import { alertText, euro, HELP, markedKeyboard, MARKS, overviewText, passText, proposalText, T, watchList } from './messages.ts';
import { cleanTexts, gitleaksScanner, REMOVED_TEXT, type Scanner } from './scan.ts';
import { count, emptyState, loadState, recordPass, saveState, type Candidate, type PassCode, type State } from './state.ts';
import { dryBot, parseChats, telegramBot, type Bot, type Event } from './telegram.ts';
import { isQuietHour, overviewDue, tallinn, weekOf } from './time.ts';
import { appendLines, dryRepo, githubRepo, StaleError, type DataRepo } from './watchrepo.ts';
import { parseAnswers, parseVerdicts, type ProposalIn, type Verdict } from './verdicts.ts';
import { formatWatch, MAX_WATCHES_PER_OWNER, OWNERS, ownWatches, validateWatch, watchId, watchPath, type LoadedWatch, type Owner, type Watch } from './watches.ts';
import { PATHS, type ActInput, type FeedbackLine, type PriceLine } from './work.ts';

export { HELP, overviewText, passText };

const FAILURE_GAP_MS = 24 * 3600 * 1000;
const PROPOSAL_DAYS = 7;
const CAPTION_MAX = 1024;
const TEXT_MAX = 4000;

export interface ActDeps {
  now: Date;
  state: State;
  input: ActInput;
  verdicts: Partial<Record<Owner, string | null>>; // each owner's judge file, null when it wrote none
  answers: Partial<Record<Owner, string | null>>;
  chats: Partial<Record<Owner, string>>;
  bot: Bot;
  repo: DataRepo;
  scan: Scanner;
  persist: (state: State) => void;
  log: (line: string) => void;
}

type TextEvent = Extract<Event, { kind: 'text' }>;
type CommandEvent = Extract<Event, { kind: 'command' }>;

/** One act run: the deps plus what it changes as it goes. */
class Run {
  d: ActDeps;
  state: State;
  watches: Map<string, LoadedWatch>;
  feedback = new Map<string, FeedbackLine[]>();
  prices: PriceLine[] = [];
  failed: string[] = [];
  week: string;
  /** Each owner's watches as numbered when the run began, which is what /otsingud showed. */
  numbered: Map<Owner, LoadedWatch[]>;

  constructor(d: ActDeps) {
    this.d = d;
    this.state = d.state;
    this.watches = new Map(d.input.watches.map((w) => [w.id, w]));
    this.week = weekOf(d.now);
    this.numbered = new Map(OWNERS.map((o) => [o, ownWatches(d.input.watches, o)]));
  }

  /** Records `key` as done; false when an earlier run already did it. */
  claim(key: string): boolean {
    if (this.state.sent.includes(key)) return false;
    this.state.sent.push(key);
    this.d.persist(this.state);
    return true;
  }

  async send<T>(what: string, send: () => Promise<T>): Promise<T | undefined> {
    try {
      return await send();
    } catch (e) {
      this.d.log(`send ${what} failed: ${safeError(e)}`);
      return undefined;
    }
  }

  async reply(key: string, chatId: string, text: string, replyTo?: number): Promise<void> {
    if (this.claim(key)) await this.send(key.split(':')[0] ?? '', () => this.d.bot.sendMessage(chatId, text.slice(0, TEXT_MAX), replyTo ? { replyTo } : {}));
  }

  own(owner: Owner): LoadedWatch[] {
    return ownWatches([...this.watches.values()], owner);
  }

  async writeWatch(id: string, watch: Watch, message: string, sha: string | null): Promise<void> {
    if (validateWatch(id, watch).length) throw new Error('a watch failed validation before its write');
    const newSha = await this.d.repo.put(watchPath(id), formatWatch(watch), message, sha);
    this.watches.set(id, { id, watch, sha: newSha });
  }

  async removeWatch(w: { id: string; sha: string }): Promise<void> {
    await this.d.repo.remove(watchPath(w.id), `Delete ${w.id}`, w.sha);
    this.watches.delete(w.id);
  }

  /** Runs a watch write and answers with `ok`, or with why it failed. */
  async save(write: () => Promise<void>, ok: string): Promise<string> {
    try {
      await write();
      return ok;
    } catch (e) {
      if (e instanceof StaleError) return T.stale;
      this.d.log(`watch write failed: ${safeError(e)}`);
      this.failed.push('watch write');
      return T.saveFailed;
    }
  }

  /** A model file through its parser; null when it is missing or unusable. */
  parse<R extends { errors: string[] }>(label: string, raw: string | null | undefined, parse: (raw: string) => R): R | null {
    if (!raw) return null;
    try {
      const r = parse(raw);
      if (r.errors.length) this.d.log(`${label}: ${r.errors.length} invalid entr(ies) dropped`);
      return r;
    } catch (e) {
      this.d.log(`${label} unusable: ${safeError(e)}`);
      return null;
    }
  }

  pass(watch: string, c: Candidate, code: PassCode, detail = ''): void {
    recordPass(this.state, watch, { at: this.d.now.toISOString(), title: c.title, code, detail });
  }
}

export async function runAct(d: ActDeps): Promise<{ failed: string[] }> {
  const run = new Run(d);
  for (const u of d.input.unknown) {
    if (d.chats.operator) await run.reply(`unknown:${u.userId}`, d.chats.operator, T.unknownUser(u.name, u.userId));
  }
  for (const ev of d.input.events) {
    if (ev.kind === 'callback') await press(run, ev);
    if (ev.kind === 'command') await command(run, ev);
  }
  for (const owner of d.input.talkSenders) await answer(run, owner);
  if (d.input.judged.length) await judge(run);
  if (overviewDue(d.now, run.state.lastOverviewWeek)) await overview(run);
  await writeLines(run);
  d.persist(run.state);
  return { failed: run.failed };
}

async function press(run: Run, ev: Extract<Event, { kind: 'callback' }>): Promise<void> {
  const { state, d } = run;
  const [code, alertId] = ev.data.split(':');
  const alert = alertId ? state.alerts[alertId] : undefined;
  if (!alert || alert.owner !== ev.owner) return;
  // The query may have expired by the next run; its answer only stops the spinner.
  await d.bot.answerCallback(ev.queryId).catch(() => undefined);
  const m = code ? MARKS[code] : undefined;
  if (!m || alert.mark || !run.claim(`cb:${ev.updateId}`)) return;
  alert.mark = m.mark;
  d.persist(state);
  const lines = run.feedback.get(alert.watch) ?? [];
  lines.push({ date: d.now.toISOString(), key: alert.key, title: alert.title, mark: m.mark, effective_eur: alert.effective_eur });
  run.feedback.set(alert.watch, lines);
  await d.bot.editKeyboard(alert.chatId, alert.messageId, markedKeyboard(alert.url, alertId as string, m.mark)).catch(() => undefined);
  const w = run.watches.get(alert.watch);
  if (m.mark !== 'ostsin' || !w || !w.watch.active) return;
  const n = run.own(ev.owner).findIndex((x) => x.id === w.id) + 1;
  const text = await run.save(() => run.writeWatch(w.id, { ...w.watch, active: false }, `Pause ${w.id} after a purchase`, w.sha), T.bought(w.watch.name, n));
  await run.reply(`bought:${ev.updateId}`, ev.chatId, text, alert.messageId);
}

async function command(run: Run, ev: CommandEvent): Promise<void> {
  // Claimed before it runs, so a re-run never repeats its write.
  if (!run.claim(`cmd:${ev.updateId}`)) return;
  const text = await commandText(run, ev);
  await run.send('cmd', () => run.d.bot.sendMessage(ev.chatId, text.slice(0, TEXT_MAX), { replyTo: ev.messageId }));
}

async function commandText(run: Run, ev: CommandEvent): Promise<string> {
  const { state, d } = run;
  const list = run.own(ev.owner);
  const numbered = run.numbered.get(ev.owner) ?? [];
  const pick = (): LoadedWatch | string => {
    const n = Number(ev.arg);
    if (!/^\d+$/.test(ev.arg)) return T.pickNumber(ev.command);
    if (n < 1 || n > numbered.length) return T.noSuchWatch;
    // The watch as it is now, after earlier commands in this run.
    return run.watches.get((numbered[n - 1] as LoadedWatch).id) ?? T.noSuchWatch;
  };
  switch (ev.command) {
    case 'start':
    case 'abi':
    case 'help':
      return HELP;
    case 'otsingud':
      return watchList(numbered.map((w) => run.watches.get(w.id) ?? { ...w, watch: { ...w.watch, name: `${w.watch.name} (kustutatud)` } }));
    case 'peata':
    case 'jätka': {
      const w = pick();
      if (typeof w === 'string') return w;
      const active = ev.command === 'jätka';
      if (w.watch.active === active) return T.already(w.watch.name, active);
      return run.save(() => run.writeWatch(w.id, { ...w.watch, active }, `${active ? 'Resume' : 'Pause'} ${w.id}`, w.sha), T.switched(w.watch.name, active));
    }
    case 'kustuta': {
      const w = pick();
      if (typeof w === 'string') return w;
      return run.save(() => run.removeWatch(w), T.deleted(w.watch.name));
    }
    case 'miks': {
      let ids = list.map((w) => w.id);
      if (ev.arg) {
        const w = pick();
        if (typeof w === 'string') return w;
        ids = [w.id];
      }
      const passes = ids
        .flatMap((id) => state.passes[id] ?? [])
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-10);
      if (!passes.length) return T.noPasses;
      return passes.map((p) => `${p.title} - ${passText(p.code, p.detail)}`).join('\n');
    }
    case 'kinnita': {
      const p = state.proposals[ev.owner];
      if (!p) return T.noProposal;
      delete state.proposals[ev.owner];
      d.persist(state);
      if (d.now.getTime() - new Date(p.at).getTime() > PROPOSAL_DAYS * 86400_000) return T.proposalExpired;
      if (p.action === 'delete') {
        const existing = run.watches.get(p.id);
        if (!p.sha || !existing) return T.stale;
        return run.save(() => run.removeWatch({ id: p.id, sha: p.sha as string }), T.deleted(existing.watch.name));
      }
      if (!p.watch) return T.proposalBroken;
      if (p.action === 'create' && list.length >= MAX_WATCHES_PER_OWNER) return T.tooMany;
      const watch = p.watch;
      return run.save(() => run.writeWatch(p.id, watch, `${p.action === 'create' ? 'Add' : 'Update'} ${p.id}`, p.sha), T.saved(watch.name));
    }
    default:
      return T.unknownCommand;
  }
}

async function answer(run: Run, owner: Owner): Promise<void> {
  const { d } = run;
  const texts = d.input.events.filter((e): e is TextEvent => e.kind === 'text' && e.owner === owner);
  const byUpdate = new Map(texts.map((e) => [e.updateId, e]));
  const answers = run.parse(`${owner} answers`, d.answers[owner], parseAnswers)?.answers;
  const answered = new Set<number>();
  if (answers) {
    const replies = answers.replies.filter((r) => byUpdate.has(r.update_id));
    const cleaned = await cleanTexts(
      replies.map((r) => r.text_et),
      d.scan,
    );
    for (const [i, r] of replies.entries()) {
      const ev = byUpdate.get(r.update_id) as TextEvent;
      answered.add(r.update_id);
      await run.reply(`reply:${r.update_id}`, ev.chatId, cleaned[i] as string, ev.messageId);
    }
    for (const p of answers.proposals.filter((x) => byUpdate.has(x.update_id))) {
      const ev = byUpdate.get(p.update_id) as TextEvent;
      answered.add(p.update_id);
      await run.reply(`proposal:${p.update_id}:${p.slug}`, ev.chatId, await propose(run, owner, p), ev.messageId);
    }
  }
  for (const ev of texts) {
    if (!answered.has(ev.updateId)) await run.reply(`reply:${ev.updateId}`, ev.chatId, T.noAnswer, ev.messageId);
  }
}

/** Checks a proposal, stores it for /kinnita and returns its text. */
async function propose(run: Run, owner: Owner, p: ProposalIn): Promise<string> {
  const id = watchId(owner, p.slug);
  const existing = run.watches.get(id);
  let watch: Watch | null = null;
  if (p.action === 'create') {
    if (existing) return T.exists(existing.watch.name);
    if (run.own(owner).length >= MAX_WATCHES_PER_OWNER) return T.tooMany;
    watch = { active: true, exclude: [], bundles: false, ...p.fields, owner } as Watch;
  } else {
    if (!existing) return T.noSuchWatch;
    if (p.action === 'update') watch = { ...existing.watch, ...p.fields, owner };
  }
  // Validation errors quote the model's values, so they are cleaned like its text.
  const error = watch && validateWatch(id, watch)[0];
  const [text] = await cleanTexts([error ? T.invalid(error) : proposalText(p.summary_et, watch, existing?.watch)], run.d.scan);
  if (error || text === REMOVED_TEXT) return text as string;
  run.state.proposals[owner] = { action: p.action, id, watch, sha: existing?.sha ?? null, at: run.d.now.toISOString() };
  run.d.persist(run.state);
  return text as string;
}

async function judge(run: Run): Promise<void> {
  const { state, d } = run;
  // Once per judge run: a re-run of act would count attempts and append prices twice.
  if (!run.claim(`judge:${state.lastJudgedSlot}`)) return;
  // A judge saw only its owner's watches, so only verdicts on them count.
  const verdicts = d.input.judges.flatMap((owner) => {
    const list = run.parse(`${owner} verdicts`, d.verdicts[owner], parseVerdicts)?.verdicts;
    if (!list) d.log(`the ${owner} judge wrote no usable verdicts`);
    return (list ?? []).filter((v) => run.watches.get(v.watch)?.watch.owner === owner);
  });
  const byPair = new Map(verdicts.map((v) => [`${v.id}|${v.watch}`, v]));
  const work: [Candidate, LoadedWatch, Verdict][] = [];
  const done = new Set<string>();
  for (const c of d.input.judged) {
    const found = c.watches.map((w) => [w, byPair.get(`${c.key}|${w}`)] as const);
    if (found.some(([, v]) => v)) {
      done.add(c.key);
      for (const [w, v] of found) {
        const lw = run.watches.get(w);
        if (!lw || !lw.watch.active) continue; // deleted or paused since collect
        if (v) work.push([c, lw, v]);
        else run.pass(w, c, 'judge_failed');
      }
      continue;
    }
    const pending = state.pending.find((p) => p.key === c.key);
    const attempts = (pending?.attempts ?? c.attempts) + 1;
    if (pending) pending.attempts = attempts;
    if (attempts < 2) continue;
    done.add(c.key);
    for (const w of c.watches) {
      const lw = run.watches.get(w);
      if (!lw) continue;
      run.pass(w, c, 'judge_failed');
      const chat = d.chats[lw.watch.owner];
      if (chat) await run.reply(`drop:${c.key}:${w}`, chat, T.dropped(c));
    }
  }
  state.pending = state.pending.filter((p) => !done.has(p.key));
  // One scan for the whole batch.
  const cleaned = await cleanTexts(
    work.flatMap(([, , v]) => [v.item, v.reason_et]),
    d.scan,
  );
  for (const [i, [c, lw, v]] of work.entries()) await judgeOne(run, c, lw, v, cleaned[2 * i] as string, cleaned[2 * i + 1] as string);
}

/** The price the limit applies to, computed here, not taken from the model: asking minus the rest only for a bundle watch. */
export function effectivePrice(w: Watch, v: Verdict): number | null {
  if (!w.bundles || v.asking_eur === null) return v.asking_eur;
  if (v.rest_value_eur === null) return v.effective_eur === null ? v.asking_eur : Math.min(v.effective_eur, v.asking_eur);
  return Math.max(0, v.asking_eur - Math.min(v.rest_value_eur, v.asking_eur));
}

async function judgeOne(run: Run, c: Candidate, lw: LoadedWatch, v: Verdict, item: string, reason: string): Promise<void> {
  const { state, d } = run;
  count(state, lw.id, run.week, 'judged');
  const effective = effectivePrice(lw.watch, v);
  if (v.asking_eur !== null || v.effective_eur !== null) {
    run.prices.push({ date: d.now.toISOString(), source: c.source, key: c.key, watch: lw.id, item, asking_eur: v.asking_eur, effective_eur: effective });
  }
  if (!v.fits) return run.pass(lw.id, c, 'not_fit', reason);
  if (v.kind === 'junk' || v.kind === 'bait') return run.pass(lw.id, c, v.kind, reason);
  if (effective !== null && effective > lw.watch.max_eur) return run.pass(lw.id, c, 'over_limit', `${euro(effective)} > ${euro(lw.watch.max_eur)}`);
  const chat = d.chats[lw.watch.owner];
  if (!chat || !run.claim(`alert:${c.key}:${lw.id}`)) return;
  const text = alertText(c, lw.watch, v, effective, item, reason);
  const alertId = String(state.nextAlertId++);
  const opts = { silent: isQuietHour(d.now), keyboard: markedKeyboard(c.url, alertId) };
  const messageId = await run.send('alert', async () => {
    if (c.picture) {
      try {
        return await d.bot.sendPhoto(chat, c.picture, text.slice(0, CAPTION_MAX), opts);
      } catch {
        // Telegram could not fetch or use the picture; the text alone still goes.
      }
    }
    return d.bot.sendMessage(chat, text, opts);
  });
  if (messageId === undefined) return;
  state.alerts[alertId] = { owner: lw.watch.owner, chatId: chat, messageId, key: c.key, watch: lw.id, title: c.title, url: c.url, item, asking_eur: v.asking_eur, effective_eur: effective, at: d.now.toISOString() };
  count(state, lw.id, run.week, 'alerted');
  d.persist(state);
}

async function overview(run: Run): Promise<void> {
  const prices = [...run.d.input.prices, ...run.prices];
  for (const owner of OWNERS) {
    const chat = run.d.chats[owner];
    const list = run.own(owner);
    if (chat && list.length) await run.reply(`overview:${run.week}:${owner}`, chat, overviewText(list, prices, run.state, run.week));
  }
  run.state.lastOverviewWeek = run.week;
}

/** One price write per run and one per feedback file. */
async function writeLines(run: Run): Promise<void> {
  const writes: [string, unknown[], string, string][] = [
    [`prices/${tallinn(run.d.now).date.slice(0, 7)}.jsonl`, run.prices, 'Prices from the judge run', 'price write'],
    ...[...run.feedback].map(([w, lines]): [string, unknown[], string, string] => [`feedback/${w}.jsonl`, lines, `Feedback on ${w}`, 'feedback write']),
  ];
  for (const [path, lines, message, label] of writes) {
    try {
      await appendLines(run.d.repo, path, lines, message);
    } catch (e) {
      run.d.log(`${label} failed: ${safeError(e)}`);
      run.failed.push(label);
    }
  }
}

/** The failure alert, to the operator at most once a day. */
export async function runFailure(now: Date, state: State, operatorChat: string | undefined, runUrl: string, bot: Bot): Promise<boolean> {
  if (!operatorChat) return false;
  if (state.lastFailureAlert && now.getTime() - new Date(state.lastFailureAlert).getTime() < FAILURE_GAP_MS) return false;
  state.lastFailureAlert = now.toISOString();
  await bot.sendMessage(operatorChat, T.failure(runUrl));
  return true;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, failure: { type: 'string' } } });
  const dry = Boolean(values['dry-run']);
  // Logs in Actions are public: a dry run there prints counts only.
  const publicLog = process.env.GITHUB_ACTIONS === 'true';
  let printed = 0;
  const print = (s: string) => (publicLog ? printed++ : console.log(s));
  const key = keyFromEnv();
  const chats = parseChats(process.env.TELEGRAM_CHATS);
  const now = new Date();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!dry && !token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const bot = dry ? dryBot(print) : telegramBot(token as string);

  if (values.failure !== undefined) {
    const state = loadState(PATHS.state, key) ?? emptyState();
    const sent = await runFailure(now, state, chats.operator, values.failure, bot);
    if (!dry) saveState(PATHS.state, state, key);
    console.log(sent ? 'failure alert sent' : 'failure alert skipped (one a day)');
    return;
  }

  const state = loadState(PATHS.state, key);
  const input = readSealedJson<ActInput>(PATHS.act, key);
  if (!state || !input) throw new Error('no state or act input: collect did not run');
  const writeToken = process.env.WATCHES_WRITE_TOKEN;
  if (!dry && !writeToken) throw new Error('WATCHES_WRITE_TOKEN is not set');
  // The scan tools are fetched only when a model wrote something; without them a scan fails closed.
  const rules = process.env.PII_RULES;
  const scan: Scanner = rules
    ? gitleaksScanner(rules, process.env.GITLEAKS ?? 'gitleaks')
    : async (texts) => {
        if (dry || !texts.length) return texts.map(() => false);
        throw new Error('PII_RULES is not set');
      };

  const answers: Partial<Record<Owner, string | null>> = {};
  for (const o of input.talkSenders) answers[o] = readSealedText(PATHS.answersSealed(o), key);
  const verdicts: Partial<Record<Owner, string | null>> = {};
  for (const o of input.judges) verdicts[o] = readSealedText(PATHS.verdictsSealed(o), key);
  const logs: string[] = [];
  const r = await runAct({
    now,
    state,
    input,
    verdicts,
    answers,
    chats,
    bot,
    repo: dry ? dryRepo(print) : githubRepo(writeToken as string),
    scan,
    persist: dry ? () => undefined : (s) => saveState(PATHS.state, s, key),
    log: (l) => logs.push(l),
  });
  for (const l of logs) console.log(l);
  if (publicLog && dry) console.log(`dry run: ${printed} message(s) and write(s) not shown`);
  console.log(`${input.events.length} events, ${input.judged.length} judged, ${state.pending.length} pending`);
  if (r.failed.length) throw new Error(`failed: ${[...new Set(r.failed)].join(', ')}`);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`act failed: ${safeError(e)}`);
    process.exit(1);
  });
}
