// khe-deals-watches through the GitHub Contents API, with the write token
// limited to that repo. A write names the sha it read, so a file changed in
// between is refused (StaleError) instead of overwritten. Errors name no
// path: a watch's file name says what someone searches for.

import { USER_AGENT } from './sources/source.ts';

export const WATCH_REPO = 'khelias/khe-deals-watches';

export class StaleError extends Error {}

export interface DataRepo {
  get(path: string): Promise<{ text: string; sha: string } | null>;
  /** Creates (sha null) or replaces a file; returns the new blob sha. */
  put(path: string, text: string, message: string, sha: string | null): Promise<string>;
  remove(path: string, message: string, sha: string): Promise<void>;
}

export function githubRepo(token: string, repo = WATCH_REPO, fetchImpl: typeof fetch = fetch): DataRepo {
  const base = `https://api.github.com/repos/${repo}/contents/`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
  const url = (path: string) => base + path.split('/').map(encodeURIComponent).join('/');
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetchImpl(url(path), {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 409 || res.status === 422) throw new StaleError(`GitHub ${method}: the file changed or exists`);
    return res;
  }
  return {
    async get(path) {
      const res = await send('GET', path);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub GET failed with ${res.status}`);
      const body = (await res.json()) as { content: string; sha: string };
      return { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
    },
    async put(path, text, message, sha) {
      const res = await send('PUT', path, { message, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) });
      if (!res.ok) throw new Error(`GitHub PUT failed with ${res.status}`);
      return ((await res.json()) as { content: { sha: string } }).content.sha;
    },
    async remove(path, message, sha) {
      const res = await send('DELETE', path, { message, sha });
      if (!res.ok) throw new Error(`GitHub DELETE failed with ${res.status}`);
    },
  };
}

/** A repo that prints what it would write, for --dry-run. */
export function dryRepo(print: (s: string) => void): DataRepo {
  return {
    get: async () => null,
    put: async (path, text) => (print(`write ${path}:\n${text}`), 'dry-run'),
    remove: async (path) => print(`delete ${path}`),
  };
}

/** The lines of a JSONL file that parse; a broken line is skipped. */
export function parseJsonl<T>(text: string): T[] {
  return text.split('\n').flatMap((l) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l) as T];
    } catch {
      return [];
    }
  });
}

/** Appends lines to a JSONL file, creating it; retries once if it changed in between. */
export async function appendLines(repo: DataRepo, path: string, lines: unknown[], message: string): Promise<void> {
  if (!lines.length) return;
  const add = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  for (let attempt = 0; ; attempt++) {
    const current = await repo.get(path);
    const text = current ? (current.text.endsWith('\n') || !current.text ? current.text : `${current.text}\n`) + add : add;
    try {
      await repo.put(path, text, message, current?.sha ?? null);
      return;
    } catch (e) {
      if (!(e instanceof StaleError) || attempt > 0) throw e;
    }
  }
}
