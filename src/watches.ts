// Watch files in khe-deals-watches: `watches/<owner>-<slug>.json`. This is
// the only check that repo has (ADR-001 point 5), run on every read and
// before every write.
//
//   node src/watches.ts <dir>     validates every watch file in <dir>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORUMS as SOURCE_FORUMS } from './sources/hinnavaatlus.ts';

export const OWNERS = ['operator', 'partner'] as const;
export type Owner = (typeof OWNERS)[number];

/** The Hinnavaatlus sale forum ids a watch may read. */
export const FORUMS: readonly number[] = SOURCE_FORUMS.map((f) => f.id);

export const MAX_WATCHES_PER_OWNER = 10;
const MAX_KEYWORDS = 60;
const KEYWORD_MIN = 2;
const KEYWORD_MAX = 40;

export interface Watch {
  name: string;
  owner: Owner;
  active: boolean;
  forums: number[];
  include: string[];
  exclude: string[];
  max_eur: number;
  bundles: boolean;
  reference_query?: string;
  brief: string;
}

export interface LoadedWatch {
  id: string; // "<owner>-<slug>", the file name without .json
  watch: Watch;
  sha: string; // git blob sha, what the Contents API wants back
}

const REQUIRED = ['name', 'owner', 'active', 'forums', 'include', 'exclude', 'max_eur', 'bundles', 'brief'];
/** Every key a watch file may hold. */
export const KEYS = new Set([...REQUIRED, 'reference_query']);
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 40;
const ID_RE = new RegExp(`^(${OWNERS.join('|')})-(${SLUG_RE.source.slice(1, -1)})$`);

/** A watch's id is `<owner>-<slug>`, its file `watches/<id>.json`. */
export const watchId = (owner: Owner, slug: string) => `${owner}-${slug}`;
export const slugOf = (id: string) => id.slice(id.indexOf('-') + 1);
export const watchPath = (id: string) => `watches/${id}.json`;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function blobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function isStringOf(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.trim().length >= min && v.length <= max && !CONTROL.test(v);
}

function checkKeywords(label: string, v: unknown, minCount: number, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${label} must be a list`);
    return;
  }
  if (v.length < minCount) errors.push(`${label} needs at least ${minCount} keyword`);
  if (v.length > MAX_KEYWORDS) errors.push(`${label} has more than ${MAX_KEYWORDS} keywords`);
  for (const k of v) {
    if (!isStringOf(k, KEYWORD_MIN, KEYWORD_MAX)) errors.push(`${label}: keyword ${JSON.stringify(k)} must be ${KEYWORD_MIN}-${KEYWORD_MAX} characters`);
  }
}

/** Errors in one watch; `id` is the file name without `.json`. Empty when valid. */
export function validateWatch(id: string, value: unknown): string[] {
  const errors: string[] = [];
  const m = ID_RE.exec(id);
  if (!m || (m[2] ?? '').length > SLUG_MAX) errors.push(`file name ${id}.json must be <owner>-<slug>.json`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [...errors, 'not a JSON object'];
  const w = value as Record<string, unknown>;
  for (const k of Object.keys(w)) if (!KEYS.has(k)) errors.push(`unknown key ${k}`);
  for (const k of REQUIRED) if (!(k in w)) errors.push(`missing ${k}`);
  if (!isStringOf(w.name, 1, 80)) errors.push('name must be 1-80 characters');
  if (!OWNERS.includes(w.owner as Owner)) errors.push(`owner must be one of ${OWNERS.join(', ')}`);
  else if (m && m[1] !== w.owner) errors.push(`file name prefix ${m[1]} does not match owner ${String(w.owner)}`);
  if (typeof w.active !== 'boolean') errors.push('active must be true or false');
  if (!Array.isArray(w.forums) || w.forums.length === 0) errors.push('forums must be a non-empty list');
  else for (const f of w.forums) if (!FORUMS.includes(f as number)) errors.push(`forum ${JSON.stringify(f)} is not one of ${FORUMS.join(', ')}`);
  checkKeywords('include', w.include, 1, errors);
  checkKeywords('exclude', w.exclude, 0, errors);
  if (typeof w.max_eur !== 'number' || !Number.isFinite(w.max_eur) || w.max_eur <= 0 || w.max_eur > 100000) errors.push('max_eur must be a number from 1 to 100000');
  if (typeof w.bundles !== 'boolean') errors.push('bundles must be true or false');
  if ('reference_query' in w && !isStringOf(w.reference_query, 2, 100)) errors.push('reference_query must be 2-100 characters');
  if (typeof w.brief !== 'string' || w.brief.trim() === '') errors.push('brief must not be empty');
  else if (w.brief.length > 2000) errors.push('brief must be at most 2000 characters');
  return errors;
}

/** Errors across a set of watches: more than ten per owner. */
export function validateSet(ids: string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const owner = id.split('-')[0] ?? '';
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > MAX_WATCHES_PER_OWNER).map(([o, n]) => `${o} has ${n} watches, at most ${MAX_WATCHES_PER_OWNER}`);
}

export function parseWatch(id: string, content: string): { watch?: Watch; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { errors: ['not valid JSON'] };
  }
  const errors = validateWatch(id, value);
  return errors.length ? { errors } : { watch: value as Watch, errors };
}

export function formatWatch(w: Watch): string {
  return `${JSON.stringify(w, null, 2)}\n`;
}

export function loadWatchDir(dir: string): { watches: LoadedWatch[]; errors: string[] } {
  const watches: LoadedWatch[] = [];
  const errors: string[] = [];
  const files = readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  for (const file of files) {
    if (!file.endsWith('.json')) {
      errors.push(`${file}: not a .json file`);
      continue;
    }
    const id = file.slice(0, -5);
    const content = readFileSync(join(dir, file), 'utf8');
    const parsed = parseWatch(id, content);
    for (const e of parsed.errors) errors.push(`${file}: ${e}`);
    if (parsed.watch) watches.push({ id, watch: parsed.watch, sha: blobSha(content) });
  }
  errors.push(...validateSet(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))));
  return { watches, errors };
}

/** An owner's watches in the order the bot numbers them. */
export function ownWatches(watches: LoadedWatch[], owner: Owner): LoadedWatch[] {
  return watches.filter((w) => w.watch.owner === owner).sort((a, b) => a.id.localeCompare(b.id));
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node src/watches.ts <dir>');
    process.exit(2);
  }
  const { watches, errors } = loadWatchDir(dir);
  for (const e of errors) console.error(e);
  console.log(`${watches.length} valid watch(es), ${errors.length} problem(s)`);
  process.exit(errors.length ? 1 : 0);
}
