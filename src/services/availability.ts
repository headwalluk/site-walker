import type { AvailabilityConfig, AvailabilitySchedule, Chatbot } from './chatbots.js';

/**
 * M21: per-chatbot operational-hours gating.
 *
 * Pure functions — no DB, no clock, no globals. The chat path passes
 * `new Date()` in; tests pass a fixed instant. Designed to be called
 * only on session-mint paths (POST /sessions, GET /sessions/can-start),
 * mirroring the 0.16.1 daily-cap precedent.
 *
 * Per dev-notes/14-availability-and-admin-mode.md.
 */

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type DayKey = (typeof DAY_KEYS)[number];

/**
 * Validate an IANA timezone string. Uses the runtime's own ICU data via
 * `Intl.DateTimeFormat` — any tz the runtime recognises is accepted; any
 * tz it doesn't is rejected. Throws `Error` on invalid input.
 */
export function assertValidTimezone(tz: string): void {
  try {
    // The constructor throws RangeError for unknown timezones.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA timezone: "${tz}".`);
  }
}

/** Returns the chatbot's effective timezone — UTC if unset. */
export function effectiveTimezone(chatbot: Pick<Chatbot, 'timezone'>): string {
  return chatbot.timezone ?? 'UTC';
}

interface ParsedWindow {
  /** Minutes since midnight, 0..1440 inclusive of the 24:00 marker. */
  openMinutes: number;
  /** Minutes since midnight, 1..1440. Strictly greater than openMinutes. */
  closeMinutes: number;
}

/**
 * Parse a single "HH:MM-HH:MM" window into minute offsets. Tolerates
 * whitespace around the dash. Accepts `24:00` as the close marker only.
 * Throws on malformed input or non-strictly-increasing windows.
 */
export function parseWindow(raw: string): ParsedWindow {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(raw);
  if (!m) {
    throw new Error(`Malformed availability window: "${raw}". Expected "HH:MM-HH:MM".`);
  }
  const [, oh, om, ch, cm] = m;
  const openMinutes = Number(oh) * 60 + Number(om);
  const closeMinutes = Number(ch) * 60 + Number(cm);
  if (
    Number(oh) > 23 ||
    Number(om) > 59 ||
    !(Number(ch) <= 24 && Number(cm) <= 59) ||
    (Number(ch) === 24 && Number(cm) !== 0)
  ) {
    throw new Error(
      `Out-of-range time in availability window: "${raw}". Hours 0-23, minutes 0-59; "24:00" allowed only as close-of-day.`,
    );
  }
  if (closeMinutes <= openMinutes) {
    throw new Error(
      `Availability window close must be strictly after open: "${raw}". Use two windows for overnight ranges (e.g. "00:00-02:00" + "22:00-24:00").`,
    );
  }
  return { openMinutes, closeMinutes };
}

/**
 * Validate an entire schedule. Iterates every day's windows, throwing on
 * the first malformed entry. Also enforces day-key whitelist.
 */
export function assertValidSchedule(config: AvailabilityConfig): void {
  if (config === null || typeof config !== 'object' || !config.schedule) {
    throw new Error('Availability config must be { "schedule": { ... } }.');
  }
  for (const [day, windows] of Object.entries(config.schedule)) {
    if (!(DAY_KEYS as readonly string[]).includes(day)) {
      throw new Error(
        `Unknown day key "${day}" in availability schedule. Valid keys: ${DAY_KEYS.join(', ')}.`,
      );
    }
    if (!Array.isArray(windows)) {
      throw new Error(`Day "${day}" must be an array of "HH:MM-HH:MM" strings.`);
    }
    for (const raw of windows) {
      if (typeof raw !== 'string') {
        throw new Error(`Day "${day}" contains a non-string entry: ${JSON.stringify(raw)}.`);
      }
      parseWindow(raw); // throws on malformed
    }
  }
}

/**
 * Extract the (day-of-week, minutes-since-midnight) pair for `at` in
 * the given IANA timezone. We use `Intl.DateTimeFormat` with the
 * en-GB locale because en-GB's weekday short names line up with the
 * three-letter keys our schedule uses (Mon, Tue, …). Both are
 * deterministic across runtimes.
 */
function localTimeParts(at: Date, tz: string): { day: DayKey; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const weekdayPart = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const minutePart = parts.find((p) => p.type === 'minute')?.value ?? '0';
  // Intl returns "Mon", "Tue", etc. — lowercase the first 3 chars to match
  // our schedule's keys. en-GB returns short weekday in these forms.
  const day = weekdayPart.slice(0, 3).toLowerCase() as DayKey;
  // hour12: false can render midnight as "24" depending on runtime; normalise.
  const hour = Number(hourPart) % 24;
  const minutes = hour * 60 + Number(minutePart);
  return { day, minutes };
}

export interface OpenNowResult {
  open: boolean;
  /**
   * When `open` is false, the next instant the chatbot opens. ISO-string
   * roundtrip-safe. NULL only if the schedule is entirely empty (every
   * day closed) — in which case the chatbot is never open and the route
   * should still refuse with 503.
   */
  nextOpenAt: Date | null;
}

/**
 * Returns `{ open, nextOpenAt }` for the chatbot at the given instant.
 *
 * - NULL `availability` (no schedule configured) → always open.
 * - Empty/all-closed schedule → always closed; `nextOpenAt` = null.
 * - Otherwise, scan up to 8 days ahead from `at` to find the next opening.
 */
export function isOpenNow(
  chatbot: Pick<Chatbot, 'timezone' | 'availability'>,
  at: Date,
): OpenNowResult {
  if (chatbot.availability === null) {
    return { open: true, nextOpenAt: null };
  }
  const tz = effectiveTimezone(chatbot);
  const schedule = chatbot.availability.schedule;
  const { day, minutes } = localTimeParts(at, tz);

  // Is the current instant inside any of today's windows?
  for (const raw of schedule[day] ?? []) {
    const { openMinutes, closeMinutes } = parseWindow(raw);
    if (minutes >= openMinutes && minutes < closeMinutes) {
      return { open: true, nextOpenAt: null };
    }
  }

  // Not currently open. Find the next window over the next 8 days (loop
  // bounds the worst case: schedule entirely empty).
  return { open: false, nextOpenAt: findNextOpenAt(schedule, at, tz) };
}

function findNextOpenAt(schedule: AvailabilitySchedule, at: Date, tz: string): Date | null {
  const { day: today, minutes: nowMinutes } = localTimeParts(at, tz);
  const todayIndex = DAY_KEYS.indexOf(today);

  for (let offset = 0; offset < 8; offset += 1) {
    const dayKey = DAY_KEYS[(todayIndex + offset) % 7];
    const windows = (schedule[dayKey] ?? [])
      .map(parseWindow)
      .sort((a, b) => a.openMinutes - b.openMinutes);
    for (const w of windows) {
      // For "today", skip windows that have already closed.
      if (offset === 0 && w.openMinutes <= nowMinutes) continue;
      return minutesToInstant(at, tz, offset, w.openMinutes);
    }
  }
  return null;
}

/**
 * Compute the absolute Date corresponding to "`offset` days from now, at
 * `minutes` past local midnight in `tz`". Done by binary-searching candidate
 * UTC instants until the localised wall-clock matches — handles DST cleanly
 * without bringing in a third-party timezone library.
 */
function minutesToInstant(at: Date, tz: string, offset: number, minutes: number): Date {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  // Start from the date-shifted instant and tune.
  const targetDay = new Date(at.getTime() + offset * 86_400_000);
  // Get the local date parts (year/month/day) for the target.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(targetDay).map((p) => [p.type, p.value]));
  // Construct an ISO string for the target wall-clock and parse it as if
  // it were UTC; then nudge by the tz offset at that point.
  const naiveUtc = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
  // Refine: compare the naive UTC's local-time-in-tz with our target wall
  // clock, and shift by the diff. One iteration is enough for non-DST tz;
  // do two for DST safety.
  let candidate = naiveUtc;
  for (let i = 0; i < 2; i += 1) {
    const local = localTimeParts(candidate, tz);
    const localDay = DAY_KEYS.indexOf(local.day);
    const targetDayIndex = DAY_KEYS.indexOf(
      localTimeParts(new Date(at.getTime() + offset * 86_400_000), tz).day,
    );
    const dayDelta = (targetDayIndex - localDay + 7) % 7;
    const adjust = (dayDelta * 1440 + minutes - local.minutes) * 60_000;
    if (adjust === 0) break;
    candidate = new Date(candidate.getTime() + adjust);
  }
  return candidate;
}
