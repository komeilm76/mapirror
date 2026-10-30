import { describe, expect, it } from 'vitest';

import { previewNextRuns } from '../src/intervals/preview';

describe('interval schedule preview', () => {
  it('shows five daily UTC runs strictly after the comparison instant', () => {
    const runs = previewNextRuns(
      { frequency: 'daily', timeOfDay: '03:00', weekday: 1, dayOfMonth: 1 },
      new Date('2026-12-31T03:00:00.000Z'),
    );

    expect(runs.map((run) => run.toISOString())).toEqual([
      '2027-01-01T03:00:00.000Z',
      '2027-01-02T03:00:00.000Z',
      '2027-01-03T03:00:00.000Z',
      '2027-01-04T03:00:00.000Z',
      '2027-01-05T03:00:00.000Z',
    ]);
  });

  it('previews consecutive weekly ISO weekdays across the year boundary', () => {
    const runs = previewNextRuns(
      { frequency: 'weekly', timeOfDay: '04:15', weekday: 1, dayOfMonth: 1 },
      new Date('2026-12-27T12:00:00.000Z'),
    );

    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-12-28T04:15:00.000Z',
      '2027-01-04T04:15:00.000Z',
      '2027-01-11T04:15:00.000Z',
      '2027-01-18T04:15:00.000Z',
      '2027-01-25T04:15:00.000Z',
    ]);
  });

  it('previews monthly days 1–28 without end-of-month clamping', () => {
    const runs = previewNextRuns(
      { frequency: 'monthly', timeOfDay: '03:00', weekday: 1, dayOfMonth: 28 },
      new Date('2026-01-29T00:00:00.000Z'),
    );

    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-02-28T03:00:00.000Z',
      '2026-03-28T03:00:00.000Z',
      '2026-04-28T03:00:00.000Z',
      '2026-05-28T03:00:00.000Z',
      '2026-06-28T03:00:00.000Z',
    ]);
  });

  it('returns no misleading dates for an incomplete schedule', () => {
    expect(
      previewNextRuns(
        { frequency: 'weekly', timeOfDay: '03:00', weekday: null, dayOfMonth: 1 },
        new Date('2026-03-25T00:00:00.000Z'),
      ),
    ).toEqual([]);
  });
});
