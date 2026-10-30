import { describe, expect, it } from 'vitest';

import { nextRunAt, type IntervalSchedule } from '../../src/lib/time';

const schedule = (frequency: IntervalSchedule['frequency'], time = '03:00'): IntervalSchedule => ({
  frequency,
  time_of_day: time,
});

describe('nextRunAt', () => {
  it.each([
    {
      label: 'daily before today’s UTC time',
      schedule: schedule('daily', '03:00'),
      after: '2026-03-25T02:59:59.999Z',
      expected: '2026-03-25T03:00:00.000Z',
    },
    {
      label: 'daily exactly at the scheduled instant',
      schedule: schedule('daily', '03:00'),
      after: '2026-03-25T03:00:00.000Z',
      expected: '2026-03-26T03:00:00.000Z',
    },
    {
      label: 'daily across the UTC year boundary',
      schedule: schedule('daily', '00:00'),
      after: '2026-12-31T23:59:59.999Z',
      expected: '2027-01-01T00:00:00.000Z',
    },
    {
      label: 'daily from an instant written with a non-UTC offset',
      schedule: schedule('daily', '03:00'),
      after: '2026-01-01T23:30:00-05:00',
      expected: '2026-01-03T03:00:00.000Z',
    },
    {
      label: 'weekly to the next Monday from Sunday (ISO weekday 1)',
      schedule: schedule('weekly', '04:15'),
      after: '2026-03-22T12:00:00.000Z',
      expected: '2026-03-23T04:15:00.000Z',
      weekday: 1,
    },
    {
      label: 'weekly to Sunday (ISO weekday 7)',
      schedule: schedule('weekly', '04:15'),
      after: '2026-03-22T03:00:00.000Z',
      expected: '2026-03-22T04:15:00.000Z',
      weekday: 7,
    },
    {
      label: 'weekly exactly at the selected weekday and time',
      schedule: schedule('weekly', '04:15'),
      after: '2026-03-23T04:15:00.000Z',
      expected: '2026-03-30T04:15:00.000Z',
      weekday: 1,
    },
    {
      label: 'monthly on February 28 in a common year',
      schedule: schedule('monthly', '03:00'),
      after: '2025-02-27T03:00:00.000Z',
      expected: '2025-02-28T03:00:00.000Z',
      day_of_month: 28,
    },
    {
      label: 'monthly on February 28 in a leap year',
      schedule: schedule('monthly', '03:00'),
      after: '2024-02-27T03:00:00.000Z',
      expected: '2024-02-28T03:00:00.000Z',
      day_of_month: 28,
    },
    {
      label: 'monthly advances from leap day without clamping',
      schedule: schedule('monthly', '03:00'),
      after: '2024-02-29T03:00:00.000Z',
      expected: '2024-03-28T03:00:00.000Z',
      day_of_month: 28,
    },
    {
      label: 'monthly exactly on its scheduled date and time',
      schedule: schedule('monthly', '03:00'),
      after: '2026-05-28T03:00:00.000Z',
      expected: '2026-06-28T03:00:00.000Z',
      day_of_month: 28,
    },
    {
      label: 'monthly crosses December into the next year',
      schedule: schedule('monthly', '00:00'),
      after: '2026-12-28T00:00:00.001Z',
      expected: '2027-01-28T00:00:00.000Z',
      day_of_month: 28,
    },
    {
      label: 'uses seconds and millisecond precision when present',
      schedule: schedule('daily', '03:04:05.123'),
      after: '2026-03-25T03:04:05.122Z',
      expected: '2026-03-25T03:04:05.123Z',
    },
    {
      label: 'rounds PostgreSQL sub-millisecond time precision forward, never early',
      schedule: schedule('daily', '03:04:05.123456'),
      after: '2026-03-25T03:04:05.123Z',
      expected: '2026-03-25T03:04:05.124Z',
    },
  ])('calculates $label', ({ schedule: input, after, expected, weekday, day_of_month }) => {
    const result = nextRunAt(
      {
        ...input,
        ...(weekday === undefined ? {} : { weekday }),
        ...(day_of_month === undefined ? {} : { day_of_month }),
      },
      new Date(after),
    );

    expect(result.toISOString()).toBe(expected);
  });

  it.each([
    ['invalid time syntax', { ...schedule('daily'), time_of_day: '3:00' }],
    ['out-of-range hour', { ...schedule('daily'), time_of_day: '24:00' }],
    ['out-of-range minute', { ...schedule('daily'), time_of_day: '03:60' }],
    ['daily schedule with a weekday', { ...schedule('daily'), weekday: 1 }],
    ['weekly schedule without a weekday', schedule('weekly')],
    ['weekly schedule with Sunday outside the ISO range', { ...schedule('weekly'), weekday: 0 }],
    ['weekly schedule with a day of month', { ...schedule('weekly'), weekday: 1, day_of_month: 1 }],
    ['monthly schedule without a day', schedule('monthly')],
    ['monthly schedule with day zero', { ...schedule('monthly'), day_of_month: 0 }],
    ['monthly schedule with day 29', { ...schedule('monthly'), day_of_month: 29 }],
    ['monthly schedule with a weekday', { ...schedule('monthly'), day_of_month: 1, weekday: 1 }],
  ] as const)('rejects %s', (_label, input) => {
    expect(() => nextRunAt(input, new Date('2026-03-25T00:00:00.000Z'))).toThrow(RangeError);
  });

  it('rejects an invalid comparison date', () => {
    expect(() => nextRunAt(schedule('daily'), new Date(Number.NaN))).toThrow(RangeError);
  });
});
