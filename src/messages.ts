// Every text the bot sends, and the overview arithmetic. Plain text: alerts
// are sent without parse_mode.
import type { Candidate, Mark, PassCode, State } from './state.ts';
import type { Keyboard } from './telegram.ts';
import { addDays, weekOf } from './time.ts';
import type { Verdict } from './verdicts.ts';
import { MAX_WATCHES_PER_OWNER, type LoadedWatch, type Watch } from './watches.ts';
import type { PriceLine } from './work.ts';

export const HELP = [
  'Saadan teate, kui foorumisse tuleb müügiteema, mis sobib mõne sinu otsinguga. Teate all olevad nupud: Ava avab teema, Huvitav ja Ei sobi õpetavad otsingut, Ostsin peatab otsingu.',
  '',
  'Kirjuta tavalise lausega, mida otsid ("otsi beebikäru alla 150 eur"), ja ma pakun välja uue otsingu. Vasta teatele küsimusega ("kas tasub?"), ja ma vastan selle kuulutuse kohta.',
  '',
  '/otsingud - sinu otsingud numbritega',
  '/peata <n>, /jätka <n> - peatab või jätkab otsingu',
  '/kustuta <n> - kustutab otsingu',
  '/kinnita - salvestab viimase väljapakutud otsingu',
  '/miks [n] - viimased kümme kuulutust, mille otsing kõrvale jättis, ja miks',
  '/abi - see tekst',
  '',
  'Vastan umbes kümne minuti jooksul.',
].join('\n');

export const T = {
  noWatches: 'Sul ei ole veel otsinguid. Kirjuta, mida otsid, ja ma pakun ühe välja.',
  pickNumber: (command: string) => `Anna otsingu number, näiteks /${command} 1. Numbrid näitab /otsingud.`,
  unknownCommand: 'Sellist käsku ei ole. /abi näitab käske.',
  noPasses: 'Viimasel ajal ei ole otsing ühtegi kuulutust kõrvale jätnud.',
  noProposal: 'Kinnitamist ootavat ettepanekut ei ole.',
  proposalExpired: 'Ettepanek on aegunud. Kirjuta uuesti, mida otsid.',
  proposalBroken: 'Ettepanek oli vigane. Kirjuta uuesti.',
  tooMany: `Sul on juba ${MAX_WATCHES_PER_OWNER} otsingut. Kustuta enne üks.`,
  stale: 'Otsingut muudeti vahepeal. Vaata /otsingud ja proovi uuesti.',
  saveFailed: 'Salvestamine ei õnnestunud. Proovi hiljem uuesti.',
  noAnswer: 'Ei saanud praegu vastata. Proovi hiljem uuesti.',
  noSuchWatch: 'Sellist otsingut ei ole. /otsingud näitab sinu otsinguid.',
  exists: (name: string) => `Otsing "${name}" on juba olemas. Muutmiseks kirjuta, mida selles muuta.`,
  invalid: (error: string) => `Ettepanek ei sobinud: ${error}. Kirjuta, mida muuta.`,
  saved: (name: string) => `Salvestatud: ${name}.`,
  deleted: (name: string) => `Otsing "${name}" on kustutatud.`,
  already: (name: string, active: boolean) => `Otsing "${name}" on juba ${active ? 'käimas' : 'peatatud'}.`,
  switched: (name: string, active: boolean) => `Otsing "${name}" on ${active ? 'jälle käimas' : 'peatatud'}.`,
  bought: (name: string, n: number) => `Otsing "${name}" on peatatud. /jätka ${n} paneb selle uuesti käima.`,
  dropped: (c: Candidate) => `Ei suutnud hinnata, jätsin kõrvale: ${c.title}\n${c.url}`,
  unknownUser: (name: string, id: string) => `Botile kirjutas tundmatu kasutaja ${name || '(nimeta)'}, id ${id}. Lubamiseks lisa see id TELEGRAM_CHATS-i.`,
  failure: (runUrl: string) => `khe-deals: töö ebaõnnestus. ${runUrl}`,
};

export const euro = (n: number | null) => (n === null ? '?' : `${Math.round(n)} €`);

export const MARKS: Record<string, { mark: Mark; label: string }> = {
  h: { mark: 'huvitav', label: 'Huvitav' },
  e: { mark: 'ei_sobi', label: 'Ei sobi' },
  o: { mark: 'ostsin', label: 'Ostsin' },
};

export function markedKeyboard(url: string, alertId: string, mark?: Mark): Keyboard {
  const open = [{ text: 'Ava', url }];
  if (mark) {
    const label = Object.values(MARKS).find((m) => m.mark === mark)?.label ?? mark;
    return [open, [{ text: `Märgitud: ${label}`, callback_data: `x:${alertId}` }]];
  }
  return [open, Object.entries(MARKS).map(([code, m]) => ({ text: m.label, callback_data: `${code}:${alertId}` }))];
}

export function passText(code: PassCode, detail: string): string {
  switch (code) {
    case 'excluded':
      return `välistatud: ${detail.replace(/\s+unless\s+/i, ', kui pole ')}`;
    case 'no_keyword':
      return 'ükski märksõna ei sobinud';
    case 'over_limit':
      return `üle piiri: ${detail}`;
    case 'not_fit':
      return `ei sobi: ${detail}`;
    case 'junk':
      return `pole see asi: ${detail}`;
    case 'bait':
      return `edasimüüja: ${detail}`;
    case 'judge_failed':
      return 'hindamine ebaõnnestus';
  }
}

export function watchList(list: LoadedWatch[]): string {
  if (!list.length) return T.noWatches;
  return list.map((w, i) => `${i + 1}. ${w.watch.name}, kuni ${euro(w.watch.max_eur)}${w.watch.active ? '' : ' (peatatud)'}`).join('\n');
}

/** An alert's text; `item` and `reason` are the cleaned model texts, `effective` the price act computed. */
export function alertText(c: Candidate, w: Watch, v: Verdict, effective: number | null, item: string, reason: string): string {
  const prefix = [v.kind === 'suspicious' ? 'Kahtlane' : '', v.confidence === 'low' ? 'Ebakindel' : ''].filter(Boolean).join(', ');
  let price = 'Hind puudub';
  if (v.asking_eur !== null) {
    price = `Hind ${euro(v.asking_eur)}`;
    if (w.bundles && v.rest_value_eur && effective !== null) price += `, ülejäänu ~${euro(v.rest_value_eur)}, efektiivne ${euro(effective)}`;
  }
  return [`${prefix ? `${prefix}: ` : ''}${c.title}`, item, price, reason, `Otsing: ${w.name}`].join('\n');
}

export function proposalText(summary: string, watch: Watch | null, deleting?: Watch): string {
  const lines = [summary, ''];
  if (watch) {
    lines.push(
      `Nimi: ${watch.name}`,
      `Hind kuni: ${euro(watch.max_eur)}${watch.bundles ? ' (ka komplekti sees, ülejäänu müüdav)' : ''}`,
      `Märksõnad: ${watch.include.join(', ')}`,
      ...(watch.exclude.length ? [`Välja jäetud: ${watch.exclude.join(', ')}`] : []),
      `Foorumid: ${watch.forums.join(', ')}`,
      `Kirjeldus: ${watch.brief}`,
    );
  } else {
    lines.push(`Kustutan otsingu "${deleting?.name}".`);
  }
  lines.push('', '/kinnita salvestab.');
  return lines.join('\n');
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(d)}.${Number(m)}.`;
}

/** The Sunday overview of one owner's watches, from the week's counters and price lines. */
export function overviewText(list: LoadedWatch[], prices: PriceLine[], state: State, week: string): string {
  const prev = addDays(week, -7);
  const lines = [`Nädala ülevaade alates ${shortDate(week)}`];
  const nums = (ps: PriceLine[], f: 'asking_eur' | 'effective_eur') => ps.map((p) => p[f]).filter((n): n is number => n !== null);
  const m = (ps: PriceLine[], f: 'asking_eur' | 'effective_eur') => euro(median(nums(ps, f)));
  for (const w of list) {
    const c = state.weekly[w.id]?.find((e) => e.week === week) ?? { seen: 0, judged: 0, alerted: 0 };
    const mine = prices.filter((p) => p.watch === w.id);
    const inWeek = (wk: string) => mine.filter((p) => weekOf(new Date(p.date)) === wk);
    const now = inWeek(week);
    const before = inWeek(prev);
    lines.push('', `${w.watch.name}: nähtud ${c.seen}, hinnatud ${c.judged}, teavitusi ${c.alerted}.`);
    if (!nums(now, 'asking_eur').length) {
      lines.push('Hindu sel nädalal ei olnud.');
      continue;
    }
    lines.push(`Mediaan: küsitud ${m(now, 'asking_eur')} (nädal varem ${m(before, 'asking_eur')}), efektiivne ${m(now, 'effective_eur')} (${m(before, 'effective_eur')}).`);
    const best = now.filter((p) => p.effective_eur !== null).sort((a, b) => (a.effective_eur as number) - (b.effective_eur as number))[0];
    if (best) lines.push(`Parim leid: ${best.item}, ${euro(best.effective_eur)}.`);
  }
  return lines.join('\n');
}
