/**
 * Bounded exponential retry policy shared by worker failures and lost-worker recovery.
 *
 * @module modules/jobs/retry
 */

/** First retry delay; subsequent delays double up to {@link MAX_JOB_RETRY_DELAY_MS}. */
export const BASE_JOB_RETRY_DELAY_MS = 1_000;
/** Cap retry delays so a transient failure cannot defer work indefinitely. */
export const MAX_JOB_RETRY_DELAY_MS = 5 * 60_000;

/**
 * Calculates the delay before the next attempt, based on the number of attempts already started.
 *
 * The first failed attempt waits one base interval; later failures double it. Invalid attempt counts are rejected rather
 * than silently producing `NaN` or an unbounded database interval.
 *
 * @param attempts - Number of attempts already claimed, including the failed attempt.
 * @param baseDelayMs - Initial delay in milliseconds.
 * @param maxDelayMs - Maximum delay in milliseconds.
 * @returns A bounded delay in milliseconds.
 */
export function jobRetryDelayMs(
  attempts: number,
  baseDelayMs = BASE_JOB_RETRY_DELAY_MS,
  maxDelayMs = MAX_JOB_RETRY_DELAY_MS,
): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError('job attempts must be a positive safe integer');
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1) {
    throw new RangeError('retry base delay must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new RangeError(
      'retry maximum delay must be a safe integer at least as large as the base delay',
    );
  }

  let delayMs = baseDelayMs;
  for (let attempt = 1; attempt < attempts && delayMs < maxDelayMs; attempt += 1) {
    delayMs = Math.min(maxDelayMs, delayMs * 2);
  }
  return delayMs;
}
