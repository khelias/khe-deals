// What collect hands to the model jobs and to act, and where it lives.
// Everything under work/ and state/ is sealed except the model jobs' own
// plain input and output, which exist only inside their runner; deals.yml
// opens and seals them at these paths too.
import type { Alert, Candidate, Mark } from './state.ts';
import type { ReferencePrice } from './sources/source.ts';
import type { Event, Unknown } from './telegram.ts';
import type { LoadedWatch, Owner, Watch } from './watches.ts';

export const PATHS = {
  state: 'state/state.sealed',
  act: 'work/act.sealed',
  judge: (owner: Owner) => `work/judge-${owner}.sealed`,
  talk: (owner: Owner) => `work/talk-${owner}.sealed`,
  verdictsSealed: (owner: Owner) => `work/verdicts-${owner}.sealed`,
  answersSealed: (owner: Owner) => `work/answers-${owner}.sealed`,
  judgeInput: 'work/judge-input.json',
  verdicts: 'work/verdicts.json',
  talkInput: (owner: Owner) => `work/${owner}/input.json`,
  answers: (owner: Owner) => `work/${owner}/answers.json`,
};

export const BATCH = 40; // candidates per judge call

export interface PriceLine {
  date: string;
  source: string;
  key: string;
  watch: string;
  item: string;
  asking_eur: number | null;
  effective_eur: number | null;
}

export interface FeedbackLine {
  date: string;
  key: string;
  title: string;
  mark: Mark;
  effective_eur: number | null;
}

export interface JudgeInput {
  listings: { id: string; title: string; url: string; forum: number; posted: string; text: string; watches: string[] }[];
  watches: { id: string; name: string; max_eur: number; bundles: boolean; brief: string; marks: { mark: string; title: string; effective_eur: number | null }[] }[];
  reference: Record<string, ReferencePrice[]>;
}

export type AlertRef = Pick<Alert, 'title' | 'url' | 'item' | 'asking_eur' | 'effective_eur'>;

export interface TalkInput {
  owner: Owner;
  messages: { update_id: number; text: string; reply_to_alert?: AlertRef }[];
  watches: { number: number; slug: string; watch: Watch }[];
  forums: Record<string, string>; // forum id to what it holds
}

export interface ActInput {
  events: Event[];
  unknown: Unknown[];
  judged: Candidate[]; // the batch the judge was given, empty when it did not run
  judges: Owner[]; // owners whose judge job ran
  talkSenders: Owner[];
  watches: LoadedWatch[];
  prices: PriceLine[]; // the last 15 days, for the overview
}
