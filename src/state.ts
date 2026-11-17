// The job's memory between runs, sealed in the Actions cache. Every list is
// capped, so the state stays small however long the job runs.
import { readSealedJson, writeSealedJson } from './box.ts';
import type { Item } from './sources/source.ts';
import type { ProposalIn } from './verdicts.ts';
import type { Owner, Watch } from './watches.ts';

export const CAPS = { seen: 5000, sent: 3000, passes: 50, alerts: 500, unknown: 100, pending: 200 };

export interface Candidate extends Item {
  watches: string[]; // watch ids whose prefilter kept it
  attempts: number; // judge runs that did not return a verdict for it
}

export type PassCode = 'excluded' | 'no_keyword' | 'over_limit' | 'not_fit' | 'junk' | 'bait' | 'judge_failed';

export interface Pass {
  at: string;
  title: string;
  code: PassCode;
  detail: string;
}

export type Mark = 'huvitav' | 'ei_sobi' | 'ostsin';

export interface Alert {
  owner: Owner;
  chatId: string;
  messageId: number;
  key: string; // the candidate's item key
  watch: string;
  title: string;
  url: string;
  item: string;
  asking_eur: number | null;
  effective_eur: number | null;
  at: string;
  mark?: Mark;
}

export interface Proposal {
  action: ProposalIn['action'];
  id: string; // watch id
  watch: Watch | null; // the full new watch; null for delete
  sha: string | null; // the file's sha when proposed; null for a new file
  at: string;
}

export interface WeekCounts {
  week: string;
  seen: number;
  judged: number;
  alerted: number;
}

export interface State {
  version: 1;
  seeded: boolean; // false until collect has read the forum once
  sourceFailedSince: string | null; // when the forum started failing, null while it answers
  seen: string[];
  pending: Candidate[];
  telegramOffset: number;
  lastJudgedSlot: string | null;
  nextAlertId: number;
  alerts: Record<string, Alert>;
  sent: string[];
  proposals: Partial<Record<Owner, Proposal>>;
  unknownReported: string[];
  lastFailureAlert: string | null;
  passes: Record<string, Pass[]>;
  weekly: Record<string, WeekCounts[]>; // per watch, this week and the one before
  lastOverviewWeek: string | null;
}

export function emptyState(): State {
  return {
    version: 1,
    seeded: false,
    sourceFailedSince: null,
    seen: [],
    pending: [],
    telegramOffset: 0,
    lastJudgedSlot: null,
    nextAlertId: 1,
    alerts: {},
    sent: [],
    proposals: {},
    unknownReported: [],
    lastFailureAlert: null,
    passes: {},
    weekly: {},
    lastOverviewWeek: null,
  };
}

export function loadState(path: string, key: Buffer): State | null {
  const saved = readSealedJson<Partial<State>>(path, key);
  return saved && { ...emptyState(), ...saved };
}

export function saveState(path: string, state: State, key: Buffer): void {
  writeSealedJson(path, trim(state), key);
}

function tail<T>(list: T[], n: number): T[] {
  return list.length > n ? list.slice(list.length - n) : list;
}

export function trim(state: State): State {
  state.seen = tail(state.seen, CAPS.seen);
  state.pending = tail(state.pending, CAPS.pending);
  state.sent = tail(state.sent, CAPS.sent);
  state.unknownReported = tail(state.unknownReported, CAPS.unknown);
  for (const [w, list] of Object.entries(state.passes)) state.passes[w] = tail(list, CAPS.passes);
  const ids = Object.keys(state.alerts).sort((a, b) => Number(a) - Number(b));
  for (const id of ids.slice(0, Math.max(0, ids.length - CAPS.alerts))) delete state.alerts[id];
  return state;
}

export function recordPass(state: State, watch: string, pass: Pass): void {
  (state.passes[watch] ??= []).push(pass);
  state.passes[watch] = tail(state.passes[watch], CAPS.passes);
}

/** Adds to this week's counter of a watch, keeping the week before for the overview. */
export function count(state: State, watch: string, week: string, field: 'seen' | 'judged' | 'alerted', n = 1): void {
  const list = (state.weekly[watch] ??= []);
  let entry = list.find((e) => e.week === week);
  if (!entry) {
    entry = { week, seen: 0, judged: 0, alerted: 0 };
    list.push(entry);
    list.sort((a, b) => a.week.localeCompare(b.week));
  }
  entry[field] += n;
  state.weekly[watch] = tail(list, 2);
}
