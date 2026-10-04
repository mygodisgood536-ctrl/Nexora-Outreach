/**
 * Timezone-aware scheduling helpers (spec §10).
 *
 * Windows are stored as local wall-clock minutes for a mission's timezone.
 * All conversions go through Intl so behaviour matches the user's real clock
 * regardless of where the server runs.
 */

/** Minutes since midnight in `tz` for a given instant. */
export function minutesInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = Number(get('hour')) % 24; // Intl can emit "24" for midnight
  const minute = Number(get('minute'));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = weekdayMap[get('weekday')] ?? 0;
  return { minutes: hour * 60 + minute, dayOfWeek: day };
}

export function formatMinutes(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}`;
}

/** Parse "HH:MM" or "H:MM AM/PM" into minutes since midnight. */
export function parseTimeToMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return ((value % 1440) + 1440) % 1440;
  const s = String(value || '').trim();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return Math.min(1439, Number(m[1]) * 60 + Number(m[2]));
  m = s.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (/pm/i.test(m[2])) h += 12;
    return h * 60;
  }
  m = s.match(/^(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)$/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (/pm/i.test(m[3])) h += 12;
    return Math.min(1439, h * 60 + Number(m[2]));
  }
  return null;
}

/** True when `now` falls inside one of the mission's windows. */
export function isWithinWindows(windows, now, tz) {
  if (!windows || windows.length === 0) return false;
  const { minutes, dayOfWeek } = minutesInTz(now, tz);
  const prevDay = (dayOfWeek + 6) % 7;
  return windows.some((w) => {
    const start = w.start_min;
    const end = w.end_min;

    // Window that wraps past midnight (e.g. 22:00 -> 02:00).
    if (end <= start) {
      if (w.day_of_week === dayOfWeek && minutes >= start) return true;   // start side
      if (w.day_of_week === prevDay && minutes < end) return true;        // tail side, next day
      return false;
    }

    if (w.day_of_week !== dayOfWeek) return false;
    return minutes >= start && minutes < end;
  });
}

/**
 * Next moment the mission becomes eligible, searching forward minute by minute
 * but stepping in coarse jumps across closed periods (bounded to 14 days).
 */
export function nextWindowStart(windows, from, tz) {
  if (!windows || windows.length === 0) return null;
  const start = from instanceof Date ? from : new Date(from);
  for (let i = 0; i <= 14 * 24 * 60; i++) {
    const at = new Date(start.getTime() + i * 60000);
    if (isWithinWindows(windows, at, tz)) return at;
  }
  return null;
}

/** ISO-8601 UTC timestamp N days from now — used for follow-up due dates. */
export function addDays(date, days) {
  return new Date((date instanceof Date ? date : new Date(date)).getTime() + days * 86400000);
}

export function sqliteUtc(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function parseSqliteUtc(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function nowSqlite() {
  return sqliteUtc(new Date());
}