/** UTC calendar and interval-schedule helpers shared by scheduler and browser preview (`P4-INT-02`, `P4-INT-08`).
 *
 * Schedule times are wall-clock values in UTC, not local times: the next occurrence is strictly after the supplied
 * instant, and all calendar arithmetic uses UTC fields so the host timezone and DST transitions cannot shift a run.
 * Monthly days are constrained to 1–28 by the database, which makes every scheduled date exist without clamping.
 *
 * @module interval-time
 */

import type { IntervalFrequency } from './constants';

/** Schedule fields required to calculate an interval's next occurrence. */
export interface IntervalSchedule {
  readonly frequency: IntervalFrequency;
  /** PostgreSQL `time` text, or the API's `HH:mm` form; no timezone is attached. */
  readonly time_of_day: string;
  /** ISO weekday, Monday = 1 through Sunday = 7; null/undefined for other frequencies. */
  readonly weekday?: number | null;
  /** Day 1–28; null/undefined for other frequencies. */
  readonly day_of_month?: number | null;
}

interface UtcTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * Calculates the first scheduled instant strictly later than `after`.
 *
 * The input uses the schema's ISO weekday and UTC time-of-day. A schedule's own fields are checked here as well as
 * by the eventual API/database constraints, because this pure helper is also used by previews and scheduler code.
 *
 * @param schedule - Frequency, UTC time and its one frequency-specific calendar field.
 * @param after - Inclusive comparison boundary; an occurrence exactly at this instant is considered passed.
 * @returns A new `Date` representing the next occurrence in UTC.
 * @throws {RangeError} If a date, time or schedule shape is invalid, or the next instant exceeds JS Date range.
 */
export function nextRunAt(schedule: IntervalSchedule, after: Date): Date {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) throw new RangeError('after must be a valid Date.');
  const time = parseUtcTime(schedule.time_of_day);
  validateScheduleShape(schedule);

  const year = after.getUTCFullYear();
  const month = after.getUTCMonth();
  const day = after.getUTCDate();

  if (schedule.frequency === 'daily') {
    const today = atUtc(year, month, day, time);
    return today.getTime() > afterMs ? today : atUtc(year, month, day + 1, time);
  }

  if (schedule.frequency === 'weekly') {
    const currentWeekday = after.getUTCDay() || 7;
    const daysUntil = (schedule.weekday! - currentWeekday + 7) % 7;
    const occurrence = atUtc(year, month, day + daysUntil, time);
    return occurrence.getTime() > afterMs
      ? occurrence
      : atUtc(year, month, day + daysUntil + 7, time);
  }

  const occurrence = atUtc(year, month, schedule.day_of_month!, time);
  return occurrence.getTime() > afterMs
    ? occurrence
    : atUtc(year, month + 1, schedule.day_of_month!, time);
}

/** Verifies the same frequency-field exclusivity enforced by `intervals_shape`. */
function validateScheduleShape(schedule: IntervalSchedule): void {
  const hasWeekday = schedule.weekday !== null && schedule.weekday !== undefined;
  const hasMonthDay = schedule.day_of_month !== null && schedule.day_of_month !== undefined;

  if (schedule.frequency === 'daily') {
    if (hasWeekday || hasMonthDay)
      throw new RangeError('Daily schedules cannot set weekday or day_of_month.');
    return;
  }
  if (schedule.frequency === 'weekly') {
    if (
      !Number.isInteger(schedule.weekday) ||
      schedule.weekday! < 1 ||
      schedule.weekday! > 7 ||
      hasMonthDay
    ) {
      throw new RangeError('Weekly schedules require weekday 1–7 and cannot set day_of_month.');
    }
    return;
  }
  if (schedule.frequency === 'monthly') {
    if (
      hasWeekday ||
      !Number.isInteger(schedule.day_of_month) ||
      schedule.day_of_month! < 1 ||
      schedule.day_of_month! > 28
    ) {
      throw new RangeError('Monthly schedules require day_of_month 1–28 and cannot set weekday.');
    }
    return;
  }
  throw new RangeError('frequency must be daily, weekly, or monthly.');
}

/** Parses a UTC clock value without applying the machine's local timezone. */
function parseUtcTime(value: string): UtcTime {
  const match = /^(\d{2}):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?$/.exec(value);
  if (match === null) throw new RangeError('time_of_day must be HH:mm or HH:mm:ss[.ffffff] UTC.');

  const hour = Number(match[1]);
  if (hour > 23) throw new RangeError('time_of_day hour must be between 00 and 23.');
  const fraction = match[4] ?? '';
  return {
    hour,
    minute: Number(match[2]),
    second: Number(match[3] ?? 0),
    // JS Date has millisecond precision; round fractional PostgreSQL microseconds up so this never fires early.
    millisecond: Math.ceil(Number(fraction.padEnd(6, '0')) / 1_000),
  };
}

/** Builds a UTC instant from possibly overflowing calendar fields, without the Date.UTC 0–99 year remapping. */
function atUtc(year: number, month: number, day: number, time: UtcTime): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, month, day);
  result.setUTCHours(time.hour, time.minute, time.second, time.millisecond);
  if (!Number.isFinite(result.getTime()))
    throw new RangeError('The next schedule date is outside the supported Date range.');
  return result;
}
