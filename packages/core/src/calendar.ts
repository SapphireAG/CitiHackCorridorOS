import { loadYamlFile } from "./config.js";
import { ValidationError } from "./errors.js";

export interface CalendarConfig {
  country: string;
  timezone: string;
  utc_offset_minutes: number;
  weekend_days: number[];
  holidays: { date: string; name: string }[];
  cutoffs: Record<string, { local_time: string; note?: string }>;
}

export type CalendarKey = "in" | "sg" | "us";

const cache = new Map<CalendarKey, CalendarConfig>();

/**
 * Loads config/calendars/<key>.yaml. Simplification: each calendar uses a FIXED UTC offset
 * (no daylight-saving transitions) — acceptable for an illustrative simulation and documented
 * in each calendar file. Business days, holidays and cutoffs below are all evaluated against
 * this fixed local offset.
 */
export function loadCalendar(key: CalendarKey): CalendarConfig {
  const cached = cache.get(key);
  if (cached) return cached;
  const cfg = loadYamlFile<CalendarConfig>(`config/calendars/${key}.yaml`);
  cache.set(key, cfg);
  return cfg;
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun .. 6=Sat
  dateStr: string; // YYYY-MM-DD
  minutesOfDay: number;
}

function localParts(instant: Date, cal: CalendarConfig): LocalParts {
  const shifted = new Date(instant.getTime() + cal.utc_offset_minutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const weekday = shifted.getUTCDay();
  const dateStr = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  return { year, month, day, hour, minute, weekday, dateStr, minutesOfDay: hour * 60 + minute };
}

/** Local midnight (start of the local calendar day containing `instant`), as a UTC Date. */
function startOfLocalDay(instant: Date, cal: CalendarConfig): Date {
  const p = localParts(instant, cal);
  return new Date(instant.getTime() - p.minutesOfDay * 60_000);
}

export function isBusinessDay(instant: Date, cal: CalendarConfig): boolean {
  const p = localParts(instant, cal);
  if (cal.weekend_days.includes(p.weekday)) return false;
  if (cal.holidays.some((h) => h.date === p.dateStr)) return false;
  return true;
}

function parseLocalTimeToMinutes(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new ValidationError(`Invalid cutoff local_time "${hhmm}", expected HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The next local midnight strictly after `instant`. */
function nextLocalDayStart(instant: Date, cal: CalendarConfig): Date {
  const todayStart = startOfLocalDay(instant, cal);
  return new Date(todayStart.getTime() + 24 * 60 * 60_000);
}

/** The next instant, at or after `instant`, that falls on a business day. */
export function nextBusinessDayStart(instant: Date, cal: CalendarConfig): Date {
  let candidate = startOfLocalDay(instant, cal);
  if (instant.getTime() > candidate.getTime()) {
    // instant is mid-day; the earliest a *fresh* business day can start is tomorrow.
    candidate = nextLocalDayStart(instant, cal);
  }
  while (!isBusinessDay(candidate, cal)) {
    candidate = nextLocalDayStart(candidate, cal);
  }
  return candidate;
}

/**
 * Advance `start` through one hop of a route: if `start` is not on a business day, or (when
 * `cutoffKey` is given) is at/after that hop's local cut-off time, the hop cannot begin until
 * the next business day; otherwise it begins immediately. Returns the instant the hop begins
 * processing (before adding `processingMinutes`).
 */
export function hopStartInstant(start: Date, cal: CalendarConfig, cutoffKey: string | null): Date {
  const onBusinessDay = isBusinessDay(start, cal);
  const p = localParts(start, cal);
  const cutoffMinutes = cutoffKey ? parseLocalTimeToMinutes(cal.cutoffs[cutoffKey]?.local_time ?? "23:59") : null;
  const pastCutoff = cutoffMinutes !== null && p.minutesOfDay >= cutoffMinutes;

  if (onBusinessDay && !pastCutoff) return start;
  return nextBusinessDayStart(start, cal);
}

/** hopStartInstant(...) followed by adding processingMinutes. This is the full per-hop advance. */
export function advanceThroughHop(
  start: Date,
  cal: CalendarConfig,
  cutoffKey: string | null,
  processingMinutes: number,
): Date {
  const begin = hopStartInstant(start, cal, cutoffKey);
  return new Date(begin.getTime() + processingMinutes * 60_000);
}
