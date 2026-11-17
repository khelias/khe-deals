// Model text on its way to a chat: links off the two Hinnavaatlus hosts are
// removed, then gitleaks (its default rules and the workspace's
// personal-data rules) checks it, and a hit replaces the whole text.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { FORUM_HOST, WWW_HOST } from './sources/hinnavaatlus.ts';

export const ALLOWED_HOSTS = [FORUM_HOST, WWW_HOST];
export const REMOVED_TEXT = '(tekst eemaldatud)';
export const REMOVED_LINK = '(link eemaldatud)';

/** Returns, per text, whether a rule matched it. */
export type Scanner = (texts: string[]) => Promise<boolean[]>;

// Links with a scheme, and bare host names on every two-letter country
// domain and the generic ones a chat app turns into links. Product names
// such as "G.Skill" (no such domain) are left alone.
const SCHEMED = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()]+/gi;
const GENERIC = 'com|net|org|info|biz|xyz|app|dev|link|shop|site|online|top|store|click|live|life|page|win|vip|club|icu|buzz|fun|space|website|tech|pro|mobi|name|asia|bio|cash|deals|today|world|zone|email|cloud|digital|network|ninja|rocks|work|cyou|sbs|lol|bond';
const BARE = new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:[a-z]{2}|${GENERIC})\\b(?:/[^\\s<>"'()]*)?`, 'gi');

function allowed(host: string): boolean {
  return ALLOWED_HOSTS.includes(host.toLowerCase());
}

export function stripLinks(text: string): string {
  const out = text.replace(SCHEMED, (m) => {
    try {
      const u = new URL(m);
      return u.protocol === 'https:' && allowed(u.hostname) ? m : REMOVED_LINK;
    } catch {
      return REMOVED_LINK;
    }
  });
  return out.replace(BARE, (m, offset: number, whole: string) => {
    // Already part of an allowed schemed link.
    if (whole.slice(Math.max(0, offset - 8), offset).endsWith('://')) return m;
    return allowed(m.split('/')[0] ?? '') ? m : REMOVED_LINK;
  });
}

const run = promisify(execFile);

/** gitleaks over each text as its own file, once with the default rules and once with `piiRules`. */
export function gitleaksScanner(piiRules: string, binary = 'gitleaks'): Scanner {
  return async (texts) => {
    const hits = texts.map(() => false);
    if (!texts.length) return hits;
    const dir = mkdtempSync(join(tmpdir(), 'khe-deals-scan-'));
    try {
      const src = join(dir, 'texts');
      mkdirSync(src);
      texts.forEach((t, i) => writeFileSync(join(src, `${i}.txt`), t));
      for (const config of [null, piiRules]) {
        const report = join(dir, 'report.json');
        await run(binary, ['dir', src, '--no-banner', '--log-level', 'error', '--report-format', 'json', '--report-path', report, '--exit-code', '0', ...(config ? ['--config', config] : [])], {
          timeout: 60_000,
        });
        for (const f of JSON.parse(readFileSync(report, 'utf8')) as { File: string }[]) {
          const i = Number(/(\d+)\.txt$/.exec(f.File)?.[1]);
          if (Number.isInteger(i) && i < hits.length) hits[i] = true;
        }
      }
      return hits;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Links stripped, then each text with a scan hit replaced by REMOVED_TEXT. */
export async function cleanTexts(texts: string[], scan: Scanner): Promise<string[]> {
  const stripped = texts.map(stripLinks);
  const hits = await scan(stripped);
  return stripped.map((t, i) => (hits[i] ? REMOVED_TEXT : t));
}
