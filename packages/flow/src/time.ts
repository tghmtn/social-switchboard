// Small time-zone helpers built on Intl, so the engine needs no date library.

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): Parts & { second: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

/** Offset (ms) of `timeZone` from UTC at `date`. */
function offsetAt(date: Date, timeZone: string) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant when the wall clock in `timeZone` reads the given date and time. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(new Date(guess), timeZone);
  // Re-check once in case the guess and the answer fall on different sides of a DST change.
  return new Date(guess - offsetAt(new Date(first), timeZone));
}

/** Next instant strictly after `now` when the clock reads HH:MM, optionally limited to weekdays. */
export function nextTimeOfDay(now: Date, time: string, days: number[], timeZone: string): Date {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const today = zonedParts(now, timeZone);
  for (let offset = 0; offset <= 7; offset++) {
    // Step through calendar days using a UTC noon anchor, which never lands on a DST gap.
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + offset, 12));
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + 1;
    const d = anchor.getUTCDate();
    const candidate = zonedToUtc(y, m, d, hour, minute, timeZone);
    const weekday = zonedParts(candidate, timeZone).weekday;
    if (candidate > now && (days.length === 0 || days.includes(weekday))) return candidate;
  }
  throw new Error(`no matching time for ${time} on days ${days.join(',')}`);
}
