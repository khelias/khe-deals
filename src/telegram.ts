// The Telegram Bot API, the few methods the bot uses, and the updates it
// reads turned into events. Errors never carry the token or message text.
import type { Owner } from './watches.ts';
import { OWNERS } from './watches.ts';

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}
export type Keyboard = InlineButton[][];

export interface SendOptions {
  replyTo?: number;
  silent?: boolean;
  keyboard?: Keyboard;
}

export interface Bot {
  getUpdates(offset: number): Promise<RawUpdate[]>;
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<number>;
  sendPhoto(chatId: string, photo: string, caption: string, opts?: SendOptions): Promise<number>;
  editKeyboard(chatId: string, messageId: number, keyboard: Keyboard): Promise<void>;
  answerCallback(queryId: string): Promise<void>;
}


export function telegramBot(token: string, fetchImpl: typeof fetch = fetch): Bot {
  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T };
    if (!res.ok || !body.ok) throw new Error(`Telegram ${method} failed with ${res.status}`);
    return body.result as T;
  }
  const extra = (o: SendOptions = {}) => ({
    ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    ...(o.silent ? { disable_notification: true } : {}),
    ...(o.keyboard ? { reply_markup: { inline_keyboard: o.keyboard } } : {}),
    link_preview_options: { is_disabled: true },
  });
  return {
    getUpdates: (offset) => call('getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] }),
    sendMessage: async (chatId, text, o) => (await call<{ message_id: number }>('sendMessage', { chat_id: chatId, text, ...extra(o) })).message_id,
    sendPhoto: async (chatId, photo, caption, o) => {
      const { link_preview_options: _unused, ...rest } = extra(o);
      return (await call<{ message_id: number }>('sendPhoto', { chat_id: chatId, photo, caption, ...rest })).message_id;
    },
    editKeyboard: async (chatId, messageId, keyboard) => {
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    },
    answerCallback: async (queryId) => {
      await call('answerCallbackQuery', { callback_query_id: queryId });
    },
  };
}

/** A bot that prints what it would send, for --dry-run. */
export function dryBot(print: (s: string) => void): Bot {
  let id = 1000;
  return {
    getUpdates: async () => [],
    sendMessage: async (chat, text) => (print(`-> ${chat}: ${text}`), id++),
    sendPhoto: async (chat, photo, caption) => (print(`-> ${chat} [${photo}]: ${caption}`), id++),
    editKeyboard: async (chat, messageId, kb) => print(`edit ${chat}/${messageId}: ${JSON.stringify(kb)}`),
    answerCallback: async () => undefined,
  };
}

/** The part of a Bot API Update the bot reads. */
export interface RawUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

export type Event =
  | { kind: 'command'; updateId: number; owner: Owner; chatId: string; messageId: number; command: string; arg: string }
  | { kind: 'text'; updateId: number; owner: Owner; chatId: string; messageId: number; text: string; replyTo?: number }
  | { kind: 'callback'; updateId: number; owner: Owner; chatId: string; queryId: string; data: string };

export interface Unknown {
  userId: string;
  name: string;
}

/** TELEGRAM_CHATS: `{"operator": "<chat id>", "partner": "<chat id>"}`; in a private chat the chat id is the user id. */
export function parseChats(raw: string | undefined): Partial<Record<Owner, string>> {
  if (!raw) throw new Error('TELEGRAM_CHATS is not set');
  const value = JSON.parse(raw) as Record<string, unknown>;
  const out: Partial<Record<Owner, string>> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!OWNERS.includes(k as Owner) || !/^\d{1,20}$/.test(String(v))) throw new Error('TELEGRAM_CHATS has an unknown owner or a bad id');
    out[k as Owner] = String(v);
  }
  return out;
}

export function ownerOf(chats: Partial<Record<Owner, string>>, userId: number): Owner | undefined {
  return OWNERS.find((o) => chats[o] === String(userId));
}

/** Updates as events from allowed users in private chats, and the unknown users who wrote. */
export function toEvents(updates: RawUpdate[], chats: Partial<Record<Owner, string>>): { events: Event[]; unknown: Unknown[] } {
  const events: Event[] = [];
  const unknown: Unknown[] = [];
  for (const u of updates) {
    const m = u.message;
    if (m) {
      if (m.chat.type !== 'private' || !m.from) continue;
      const owner = ownerOf(chats, m.from.id);
      if (!owner) {
        const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') + (m.from.username ? ` (@${m.from.username})` : '');
        unknown.push({ userId: String(m.from.id), name: name.slice(0, 100) });
        continue;
      }
      const text = (m.text ?? '').trim();
      if (!text) continue;
      const chatId = String(m.chat.id);
      const cmd = /^\/([\p{L}\d_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/u.exec(text);
      if (cmd) {
        events.push({ kind: 'command', updateId: u.update_id, owner, chatId, messageId: m.message_id, command: (cmd[1] ?? '').toLowerCase(), arg: (cmd[2] ?? '').trim() });
      } else {
        events.push({
          kind: 'text',
          updateId: u.update_id,
          owner,
          chatId,
          messageId: m.message_id,
          text: text.slice(0, 2000),
          ...(m.reply_to_message ? { replyTo: m.reply_to_message.message_id } : {}),
        });
      }
      continue;
    }
    const q = u.callback_query;
    if (q) {
      const owner = ownerOf(chats, q.from.id);
      if (!owner || !q.data) continue;
      events.push({
        kind: 'callback',
        updateId: u.update_id,
        owner,
        chatId: String(q.message?.chat.id ?? q.from.id),
        queryId: q.id,
        data: q.data.slice(0, 64),
      });
    }
  }
  return { events, unknown };
}
