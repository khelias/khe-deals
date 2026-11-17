// A marketplace behind one interface, so a second source is a new module.

export interface Item {
  source: string;
  id: string; // the source's own id
  key: string; // "<source>:<id>", unique across sources
  title: string;
  url: string;
  text: string;
  forum: number;
  posted: string; // ISO time
  picture?: string; // http(s) only
}

export interface ReferencePrice {
  name: string;
  eur: number;
}

export const USER_AGENT = 'khe-deals/0.1';

/** Fetches a URL's body as text; the caller spaces and counts requests. */
export type Fetch = (url: string) => Promise<string>;

export interface Source {
  name: string;
  /** Unseen items in the given forums, oldest first. */
  listNew(forums: number[], fetch: Fetch, isSeen: (key: string) => boolean): Promise<Item[]>;
  /** Retail prices for a search query; one request per call. */
  referencePrices(query: string, fetch: Fetch): Promise<ReferencePrice[]>;
}
