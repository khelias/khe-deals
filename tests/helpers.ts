import { readFileSync } from 'node:fs';
import type { Bot, Keyboard, RawUpdate, SendOptions } from '../src/telegram.ts';
import { StaleError, type DataRepo } from '../src/watchrepo.ts';
import { blobSha, formatWatch, type LoadedWatch, type Owner, type Watch } from '../src/watches.ts';

export const FIXTURES = new URL('./fixtures/', import.meta.url);
export const fixture = (path: string) => readFileSync(new URL(path, FIXTURES), 'utf8');
export const update = (path: string) => JSON.parse(fixture(`telegram/${path}`)) as RawUpdate | RawUpdate[];

export const CHATS: Partial<Record<Owner, string>> = { operator: '1001', partner: '1002' };

// The first watch's keyword lists with a made-up name and brief; the real
// watch is private.
export const DDR5_WATCH = JSON.parse(fixture('watches/operator-ddr5.json')) as Watch;

export function watch(overrides: Partial<Watch> = {}): Watch {
  return {
    name: 'Test',
    owner: 'operator',
    active: true,
    forums: [3],
    include: ['ddr5'],
    exclude: [],
    max_eur: 300,
    bundles: true,
    brief: 'Test brief.',
    ...overrides,
  };
}

export function loaded(id: string, w: Watch): LoadedWatch {
  return { id, watch: w, sha: blobSha(formatWatch(w)) };
}

export interface Sent {
  method: string;
  chatId?: string;
  text?: string;
  photo?: string;
  opts?: SendOptions;
  keyboard?: Keyboard;
  messageId?: number;
}

export function fakeBot(opts: { failPhoto?: boolean; failAnswer?: boolean; failSend?: boolean } = {}): Bot & { sent: Sent[] } {
  const sent: Sent[] = [];
  let id = 500;
  return {
    sent,
    getUpdates: async () => [],
    async sendMessage(chatId, text, o) {
      if (opts.failSend) throw new Error('send failed');
      sent.push({ method: 'sendMessage', chatId, text, opts: o, messageId: ++id });
      return id;
    },
    async sendPhoto(chatId, photo, caption, o) {
      if (opts.failPhoto) throw new Error('photo refused');
      sent.push({ method: 'sendPhoto', chatId, text: caption, photo, opts: o, messageId: ++id });
      return id;
    },
    async editKeyboard(chatId, messageId, keyboard) {
      sent.push({ method: 'editKeyboard', chatId, messageId, keyboard });
    },
    async answerCallback() {
      sent.push({ method: 'answerCallback' });
      if (opts.failAnswer) throw new Error('query is too old');
    },
  };
}

/** An in-memory khe-deals-watches with the Contents API's sha rules. */
export function fakeRepo(files: Record<string, string> = {}): DataRepo & { files: Map<string, string>; writes: string[] } {
  const store = new Map(Object.entries(files));
  const writes: string[] = [];
  return {
    files: store,
    writes,
    async get(path) {
      const text = store.get(path);
      return text === undefined ? null : { text, sha: blobSha(text) };
    },
    async put(path, text, _message, sha) {
      const current = store.get(path);
      if (current === undefined ? sha !== null : sha !== blobSha(current)) throw new StaleError('stale');
      store.set(path, text);
      writes.push(path);
      return blobSha(text);
    },
    async remove(path, _message, sha) {
      const current = store.get(path);
      if (current === undefined || sha !== blobSha(current)) throw new StaleError('stale');
      store.delete(path);
      writes.push(`delete ${path}`);
    },
  };
}
