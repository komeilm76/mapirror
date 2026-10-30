/** Builds a five-occurrence preview with the exact UTC recurrence helper used by the scheduler. */

import { nextRunAt, type IntervalFrequency } from '@mapirror/shared';

/** Form fields needed to preview a schedule. */
export interface SchedulePreviewInput {
  readonly frequency: IntervalFrequency;
  readonly timeOfDay: string;
  readonly weekday: number | null;
  readonly dayOfMonth: number | null;
}

/**
 * Returns the next five occurrences strictly after `after`.
 *
 * @param schedule - Current form schedule.
 * @param after - Comparison instant, usually the current time.
 * @returns Five UTC instants, or an empty list when the schedule is incomplete/invalid.
 */
export function previewNextRuns(schedule: SchedulePreviewInput, after: Date): Date[] {
  try {
    const result: Date[] = [];
    let cursor = after;
    for (let index = 0; index < 5; index += 1) {
      const next = nextRunAt(
        {
          frequency: schedule.frequency,
          time_of_day: schedule.timeOfDay,
          ...(schedule.frequency === 'weekly' ? { weekday: schedule.weekday } : {}),
          ...(schedule.frequency === 'monthly' ? { day_of_month: schedule.dayOfMonth } : {}),
        },
        cursor,
      );
      result.push(next);
      cursor = next;
    }
    return result;
  } catch {
    return [];
  }
}
