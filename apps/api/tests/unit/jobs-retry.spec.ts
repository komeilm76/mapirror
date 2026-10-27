import { describe, expect, it } from 'vitest';

import { jobRetryDelayMs } from '../../src/modules/jobs/retry';

describe('job retry backoff', () => {
  it('doubles the delay for attempts already made', () => {
    expect([1, 2, 3, 4].map((attempts) => jobRetryDelayMs(attempts))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
  });

  it('caps exponential growth at the configured maximum', () => {
    expect(jobRetryDelayMs(20, 250, 1_000)).toBe(1_000);
    expect(jobRetryDelayMs(1, 250, 1_000)).toBe(250);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid attempt count %s',
    (attempts) => {
      expect(() => jobRetryDelayMs(attempts)).toThrow(RangeError);
    },
  );

  it('rejects a maximum smaller than the base delay', () => {
    expect(() => jobRetryDelayMs(1, 2_000, 1_000)).toThrow(RangeError);
  });
});
