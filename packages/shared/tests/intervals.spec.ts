import { describe, expect, it } from 'vitest';

import {
  IntervalCreateBodySchema,
  IntervalDeleteQuerySchema,
  IntervalUpdateBodySchema,
} from '../src';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';

describe('interval request contracts', () => {
  it('parses a create body while leaving cross-field semantics to the API', () => {
    expect(
      IntervalCreateBodySchema.parse({
        name: ' Nightly ',
        frequency: 'daily',
        weekday: 1,
        countryIds: [COUNTRY_ID],
      }),
    ).toEqual({ name: 'Nightly', frequency: 'daily', weekday: 1, countryIds: [COUNTRY_ID] });
  });

  it('bounds memberships and rejects duplicate, malformed or unknown fields', () => {
    expect(
      IntervalCreateBodySchema.safeParse({
        name: 'Daily',
        frequency: 'daily',
        countryIds: [COUNTRY_ID, COUNTRY_ID],
      }).success,
    ).toBe(false);
    expect(
      IntervalCreateBodySchema.safeParse({ name: 'Daily', frequency: 'daily', countryIds: [] })
        .success,
    ).toBe(true); // Empty membership is a semantic 422, not a shape-level 400.
    expect(
      IntervalCreateBodySchema.safeParse({
        name: 'Daily',
        frequency: 'daily',
        countryIds: ['not-a-uuid'],
      }).success,
    ).toBe(false);
    expect(
      IntervalCreateBodySchema.safeParse({
        name: 'Daily',
        frequency: 'daily',
        countryIds: [COUNTRY_ID],
        cron: '* * * * *',
      }).success,
    ).toBe(false);
  });

  it('requires at least one update field and limits confirmation to an explicit boolean', () => {
    expect(IntervalUpdateBodySchema.safeParse({}).success).toBe(false);
    expect(IntervalUpdateBodySchema.safeParse({ enabled: false, confirm: true }).success).toBe(
      true,
    );
    expect(IntervalUpdateBodySchema.safeParse({ enabled: false, confirm: 'yes' }).success).toBe(
      false,
    );
  });

  it('accepts only documented force query values', () => {
    expect(IntervalDeleteQuerySchema.safeParse({ force: 'true' }).success).toBe(true);
    expect(IntervalDeleteQuerySchema.safeParse({ force: '1' }).success).toBe(false);
    expect(IntervalDeleteQuerySchema.safeParse({ unexpected: 'true' }).success).toBe(false);
  });
});
