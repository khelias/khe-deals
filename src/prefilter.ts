// Keyword prefilter: case-insensitive, a keyword matches at the start of a
// word ("ddr5" matches "DDR5-6000", "12400" matches "i5-12400F"). Plain
// string search, so nothing a watch holds can make it slow (no regexes).
// An exclude entry "ddr4 unless ddr5" excludes only when ddr5 is absent.
import type { Watch } from './watches.ts';

export type PrefilterResult = { pass: false; keyword: string } | { pass: true; code: 'excluded' | 'no_keyword'; keyword: string };

const WORD = /[\p{L}\p{N}]/u;

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

export function hasKeyword(text: string, keyword: string): boolean {
  const k = normalize(keyword).trim();
  if (!k) return false;
  let i = text.indexOf(k);
  while (i !== -1) {
    if (i === 0 || !WORD.test(text[i - 1] ?? '')) return true;
    i = text.indexOf(k, i + 1);
  }
  return false;
}

function excludes(text: string, entry: string): boolean {
  const [word, unless] = entry.split(/\s+unless\s+/i);
  if (!word || !hasKeyword(text, word)) return false;
  return unless === undefined || !hasKeyword(text, unless);
}

/** `pass: true` means the watch lets the listing pass, with the keyword that decided it. */
export function prefilter(watch: Pick<Watch, 'include' | 'exclude'>, title: string, body: string): PrefilterResult {
  const text = normalize(`${title}\n${body}`);
  for (const entry of watch.exclude) if (excludes(text, entry)) return { pass: true, code: 'excluded', keyword: entry };
  const hit = watch.include.find((k) => hasKeyword(text, k));
  if (hit === undefined) return { pass: true, code: 'no_keyword', keyword: '' };
  return { pass: false, keyword: hit };
}
