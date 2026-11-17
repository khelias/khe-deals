// Schemas of the two files a model writes: the judge's verdicts and a
// sender's answers. Anything else in them is dropped; anything wrong makes
// the file or the entry invalid. Titles and URLs never come from here.
import { SLUG_MAX, SLUG_RE, type Watch } from './watches.ts';

export const MAX_MODEL_FILE = 64 * 1024;
export const KINDS = ['ok', 'bait', 'junk', 'suspicious'] as const;
export type Kind = (typeof KINDS)[number];

export interface Verdict {
  id: string;
  watch: string;
  fits: boolean;
  item: string;
  asking_eur: number | null;
  rest_value_eur: number | null;
  effective_eur: number | null;
  kind: Kind;
  confidence: 'high' | 'low';
  reason_et: string;
}

export interface Reply {
  update_id: number;
  text_et: string;
}

export interface ProposalIn {
  update_id: number;
  action: 'create' | 'update' | 'delete';
  slug: string;
  fields: Partial<Watch>;
  summary_et: string;
}

export interface Answers {
  replies: Reply[];
  proposals: ProposalIn[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const money = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1_000_000);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** The entries that pass `check`; the others' errors go to `errors`. */
function checkAll<T>(list: unknown[], check: (v: unknown) => T | string, label: string, errors: string[]): T[] {
  return list.flatMap((v, i) => {
    const r = check(v);
    if (typeof r !== 'string') return [r];
    errors.push(`${label} ${i}: ${r}`);
    return [];
  });
}

function parseFile(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MODEL_FILE) throw new Error('model file is over 64 KB');
  return JSON.parse(raw);
}

export function checkVerdict(v: unknown): Verdict | string {
  if (!isObj(v)) return 'not an object';
  if (!text(v.id, 100) || !text(v.watch, 100)) return 'id or watch missing';
  if (typeof v.fits !== 'boolean') return 'fits must be true or false';
  if (!text(v.item, 200)) return 'item must be 1-200 characters';
  if (!money(v.asking_eur) || !money(v.rest_value_eur) || !money(v.effective_eur)) return 'prices must be numbers or null';
  if (!KINDS.includes(v.kind as Kind)) return `kind must be one of ${KINDS.join(', ')}`;
  if (v.confidence !== 'high' && v.confidence !== 'low') return 'confidence must be high or low';
  if (!text(v.reason_et, 200)) return 'reason_et must be 1-200 characters';
  return {
    id: v.id,
    watch: v.watch,
    fits: v.fits,
    item: v.item,
    asking_eur: v.asking_eur,
    rest_value_eur: v.rest_value_eur,
    effective_eur: v.effective_eur,
    kind: v.kind as Kind,
    confidence: v.confidence,
    reason_et: v.reason_et,
  };
}

/** The judge's file: `{"verdicts": [...]}`. Throws when the file as a whole is unusable. */
export function parseVerdicts(raw: string): { verdicts: Verdict[]; errors: string[] } {
  const value = parseFile(raw);
  if (!isObj(value) || !Array.isArray(value.verdicts)) throw new Error('verdicts file must be {"verdicts": [...]}');
  const errors: string[] = [];
  return { verdicts: checkAll(value.verdicts, checkVerdict, 'verdict', errors), errors };
}

export function checkReply(v: unknown): Reply | string {
  if (!isObj(v) || !Number.isInteger(v.update_id)) return 'update_id missing';
  if (!text(v.text_et, 800)) return 'text_et must be 1-800 characters';
  return { update_id: v.update_id as number, text_et: v.text_et };
}

export function checkProposal(v: unknown): ProposalIn | string {
  if (!isObj(v) || !Number.isInteger(v.update_id)) return 'update_id missing';
  if (v.action !== 'create' && v.action !== 'update' && v.action !== 'delete') return 'action must be create, update or delete';
  if (typeof v.slug !== 'string' || !SLUG_RE.test(v.slug) || v.slug.length > SLUG_MAX) return 'slug must be lowercase words joined by hyphens';
  if (!isObj(v.fields)) return 'fields must be an object';
  if ('owner' in v.fields) return 'fields must not set owner';
  if (!text(v.summary_et, 400)) return 'summary_et must be 1-400 characters';
  return { update_id: v.update_id as number, action: v.action, slug: v.slug, fields: v.fields as Partial<Watch>, summary_et: v.summary_et };
}

/** A sender's file: `{"replies": [...], "proposals": [...]}`. */
export function parseAnswers(raw: string): { answers: Answers; errors: string[] } {
  const value = parseFile(raw);
  if (!isObj(value) || !Array.isArray(value.replies) || !Array.isArray(value.proposals)) throw new Error('answers file must be {"replies": [...], "proposals": [...]}');
  const errors: string[] = [];
  const answers = { replies: checkAll(value.replies, checkReply, 'reply', errors), proposals: checkAll(value.proposals, checkProposal, 'proposal', errors) };
  return { answers, errors };
}
