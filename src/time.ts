// Tallinn wall-clock rules: collection hours, judge slots, quiet hours and
// the overview week. Intl does the DST arithmetic; nothing here assumes an
// offset.

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Tallinn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface LocalTime {
  date: string; // YYYY-MM-DD
  hour: number;
  weekday: number; // 1 = Monday ... 7 = Sunday
}

export function tallinn(d: Date): LocalTime {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    weekday: WEEKDAYS.indexOf(p.weekday ?? '') + 1,
  };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Collection runs 06:00-22:59 Tallinn. */
export function isCollectHour(d: Date): boolean {
  const { hour } = tallinn(d);
  return hour >= 6 && hour < 23;
}

/** Alerts are sent without sound 22:00-07:59 Tallinn. */
export function isQuietHour(d: Date): boolean {
  const { hour } = tallinn(d);
  return hour >= 22 || hour < 8;
}

export const JUDGE_HOURS = [7, 12, 17, 21];

/** The judge slot `d` falls in, e.g. "2026-11-17T12"; before 07 it is the previous day's 21. */
export function judgeSlot(d: Date): string {
  const t = tallinn(d);
  const hour = [...JUDGE_HOURS].reverse().find((h) => h <= t.hour);
  if (hour === undefined) return `${addDays(t.date, -1)}T21`;
  return `${t.date}T${String(hour).padStart(2, '0')}`;
}

/** The Monday (YYYY-MM-DD, Tallinn) of the week `d` falls in. */
export function weekOf(d: Date): string {
  const t = tallinn(d);
  return addDays(t.date, 1 - t.weekday);
}

/** The overview goes out at the first run from Sunday 18:00 Tallinn, once a week. */
export function overviewDue(d: Date, lastOverviewWeek: string | null): boolean {
  const t = tallinn(d);
  return t.weekday === 7 && t.hour >= 18 && lastOverviewWeek !== weekOf(d);
}
