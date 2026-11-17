// The Hinnavaatlus forum as a guest: its SmartFeed (one RSS request for all
// watched forums: new topics with their first post) and each forum's first
// list page (full titles with their M:/O: prefix, which the feed cuts at
// about 100 characters, and the sticky markers); and the hinnavaatlus.ee
// price search for reference prices. Findings of the source spike are in
// the deal alerts plan's Outcome.
import type { Item, ReferencePrice, Source } from './source.ts';

export const FORUM_HOST = 'foorum.hinnavaatlus.ee';
export const WWW_HOST = 'www.hinnavaatlus.ee';

/** The sale forums a watch may read: id, the name the feed puts before the first " :: " of a title, and what it holds. */
export const FORUMS = [
  { id: 3, name: 'Arvutitehnika ja tarkvara müük/vahetus', about: 'computer parts and software' },
  { id: 31, name: 'Mobiiltelefonide, kantavate nutiseadmete ja lisaseadmete ost/müük/vahetus', about: 'phones and wearables' },
  { id: 59, name: 'Süle- ja tahvelarvutite müük/vahetus', about: 'laptops and tablets' },
  { id: 60, name: 'Ära Anda ehk kollektsionääride nurgake', about: 'free to a good home, collectibles' },
  { id: 70, name: 'Varia ja muu tehnika (sh helitehnika ja fototehnika) ost/müük/vahetus', about: 'other electronics, audio and photo' },
  { id: 81, name: 'Mängukonsoolide, lisaseadmete ja mängude ost/müük/vahetus', about: 'game consoles and games' },
  { id: 91, name: 'Apple toodete ost/müük/vahetus', about: 'Apple products' },
] as const;

const FORUM_BY_NAME = new Map<string, number>(FORUMS.map((f) => [f.name, f.id]));

/** Items posted longer ago than this are skipped: the feed window is a day, so only a bumped sticky could be older. */
export const MAX_AGE_MS = 26 * 3600 * 1000;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  if (!m) return '';
  const body = m[1] ?? '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(body);
  return cdata ? (cdata[1] ?? '') : decodeEntities(body);
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Image hosts the forum's sellers use. Telegram fetches an alert's picture when it is sent, so a seller's own server would learn the listing passed. */
const PICTURE_HOSTS = ['upload.ee', 'imgur.com', 'ibb.co', 'postimg.cc', 'postimages.org', FORUM_HOST];

function pictureHostAllowed(host: string): boolean {
  return PICTURE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function firstPicture(html: string): string | undefined {
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    const src = decodeEntities(m[1] ?? '');
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.hostname === FORUM_HOST && url.pathname.startsWith('/images/')) continue; // smileys and icons
    if (!pictureHostAllowed(url.hostname)) continue;
    return url.href;
  }
  return undefined;
}

export function feedUrl(forums: number[]): string {
  const f = [...new Set(forums)].sort((a, b) => a - b).map((n) => `&forum=${n}`).join('');
  return `https://${FORUM_HOST}/smartfeed.php?feed_type=RSS2.0&limit=1%20DAY&sort_by=postdate_desc&topicsonly=1&firstpostonly=1${f}&max_word_size=All`;
}

export function topicUrl(id: string): string {
  return `https://${FORUM_HOST}/viewtopic.php?t=${id}`;
}

/** Items of a SmartFeed RSS document, oldest first; error items and unknown forums are dropped. */
export function parseFeed(xml: string): Item[] {
  const items: Item[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1] ?? '';
    const id = /[?&;]t=(\d+)/.exec(tag(body, 'comments'))?.[1];
    if (!id) continue;
    // The topic title arrives entity-encoded twice ("&amp;amp;").
    const parts = decodeEntities(tag(body, 'title')).split(' :: ');
    if (parts.length < 2) continue;
    const forum = FORUM_BY_NAME.get(parts[0] ?? '');
    if (forum === undefined) continue;
    // The whole title is cut at about 100 characters, "Posted by" included,
    // so its last part may be the poster, a cut-off "Posted b..." or "...".
    const last = parts[parts.length - 1] ?? '';
    const cut = last.endsWith('...') && 'Posted by'.startsWith(last.slice(0, -3).trim());
    const rest = last.startsWith('Posted by ') || cut ? parts.slice(1, -1) : parts.slice(1);
    const title = rest.join(' :: ').replace(/\s*\.\.\.$/, '').trim();
    const html = tag(body, 'description');
    const posted = new Date(tag(body, 'pubDate'));
    if (Number.isNaN(posted.getTime())) continue;
    const picture = firstPicture(html);
    items.push({
      source: 'hv',
      id,
      key: `hv:${id}`,
      title,
      url: topicUrl(id),
      text: htmlToText(html),
      forum,
      posted: posted.toISOString(),
      ...(picture ? { picture } : {}),
    });
  }
  return items.sort((a, b) => a.posted.localeCompare(b.posted));
}

export const TOPIC_TEXT_MAX = 8000;

/**
 * A topic page's posts as text, oldest first, each headed by its date and
 * whether the topic's first poster wrote it; usernames are left out. Cut at
 * `TOPIC_TEXT_MAX` characters.
 */
export function parseTopicPage(html: string): string {
  let seller: string | undefined;
  const posts: string[] = [];
  for (const chunk of html.split('<span class="name"><a name="').slice(1)) {
    const author = /class="name">([^<]*)<\/a>/.exec(chunk)?.[1] ?? '';
    // The post's body is followed by its (usually empty) signature span.
    const body = /<td colspan="2"><span class="postbody">([\s\S]*?)<span class="postbody">/.exec(chunk)?.[1];
    if (body === undefined) continue;
    seller ??= author;
    const date = /<span class="postdetails">(\d\d\.\d\d\.\d{4} \d\d:\d\d)/.exec(chunk)?.[1] ?? '';
    posts.push(`[${date}, ${author === seller ? 'seller' : 'someone else'}]\n${htmlToText(body)}`);
  }
  return posts.join('\n\n').slice(0, TOPIC_TEXT_MAX);
}

export function forumUrl(forum: number): string {
  return `https://${FORUM_HOST}/viewforum.php?f=${forum}`;
}

export interface ForumPage {
  titles: Map<string, string>;
  stickies: Set<string>;
}

/** Full topic titles and sticky or announcement topics on a forum list page. */
export function parseForumPage(html: string): ForumPage {
  const titles = new Map<string, string>();
  const stickies = new Set<string>();
  for (const row of html.split(/<tr\b/i)) {
    const m = /<a href="viewtopic\.php\?t=(\d+)" class="topictitle"[^>]*>([\s\S]*?)<\/a>/.exec(row);
    if (!m) continue;
    const id = m[1] ?? '';
    const inner = (m[2] ?? '').split('<span class="gensmall">::')[0] ?? '';
    titles.set(id, decodeEntities(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (/folder_(announce|sticky)|<b>(teadaanne|kleebis):<\/b>/i.test(row)) stickies.add(id);
  }
  return { titles, stickies };
}

/** Feed items with the list pages' full titles, stickies dropped. */
export function mergeForumPages(items: Item[], pages: ForumPage[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    if (pages.some((p) => p.stickies.has(item.id))) continue;
    const full = pages.map((p) => p.titles.get(item.id)).find((t) => t);
    out.push(full ? { ...item, title: full } : item);
  }
  return out;
}

export function searchUrl(query: string): string {
  return `https://${WWW_HOST}/search/?query=${encodeURIComponent(query)}`;
}

/** The first `limit` products of a price search page, in its order (popularity). */
export function parseReferencePrices(html: string, limit = 10): ReferencePrice[] {
  const out: ReferencePrice[] = [];
  const re = /class="product-name[^"]*"[^>]*\btitle="([^"]*)"[\s\S]*?class="price(?: [^"]*)?"[^>]*>([^<]*)</g;
  for (const m of html.matchAll(re)) {
    const eur = Number((m[2] ?? '').replace(/[^\d,]/g, '').replace(',', '.'));
    if (!Number.isFinite(eur) || eur <= 0) continue;
    out.push({ name: decodeEntities(m[1] ?? ''), eur });
    if (out.length >= limit) break;
  }
  return out;
}

export const hinnavaatlus: Source = {
  name: 'hv',
  async listNew(forums, fetch, isSeen) {
    // The list pages are needed only for the full titles and sticky markers
    // of unseen items, so a quiet run makes one request.
    const items = parseFeed(await fetch(feedUrl(forums))).filter((i) => !isSeen(i.key));
    const pages: ForumPage[] = [];
    for (const f of [...new Set(items.map((i) => i.forum))].sort((a, b) => a - b)) pages.push(parseForumPage(await fetch(forumUrl(f))));
    return mergeForumPages(items, pages);
  },
  async referencePrices(query, fetch) {
    return parseReferencePrices(await fetch(searchUrl(query)));
  },
};
