const TZ = 'Africa/Lagos';

export const lagosTime = (d: Date) =>
  new Intl.DateTimeFormat('en-NG', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d)
    .replace(' ', '')
    .toLowerCase();

export const lagosDay = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);

export const lagosDateTime = (d: Date) => `${lagosDay(d)}, ${lagosTime(d)}`;

/** A YYYY-MM-DD date at a given hour in Lagos (UTC+1, no DST). */
export const lagosAt = (isoDate: string, hour = 10) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`expected YYYY-MM-DD, got "${isoDate}"`);
  return new Date(`${isoDate}T${String(hour).padStart(2, '0')}:00:00+01:00`);
};

export const minutesFrom = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

/** Today's date in Lagos as YYYY-MM-DD. */
export const lagosToday = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);

/** YYYY-MM-DD plus n days (calendar arithmetic, no time zone involved). */
export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** "Sat 31 Oct" for a YYYY-MM-DD date. */
export const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(`${day}T12:00:00Z`),
  );

export const isIsoDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Postgres `date` values arrive as Date (UTC midnight) or string; normalise to YYYY-MM-DD. */
export const isoDay = (v: Date | string | null | undefined) =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
