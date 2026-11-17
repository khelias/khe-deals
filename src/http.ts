// Requests to a source's hosts: spaced, capped, with our User-Agent.
import { USER_AGENT, type Fetch } from './sources/source.ts';

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

/** `redirect: 'error'` keeps a request on the host its URL was checked for. */
export async function httpText(url: string, redirect: 'follow' | 'error' = 'follow'): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}
