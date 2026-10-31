import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatEta,
  formatSpeed,
  isJobActive,
  jobActivityLabel,
  jobPhaseLabel,
  jobProgressLabel,
  jobRateLabel,
  jobTypeLabel,
  progressPercent,
  updateCheckResultLabel,
} from '../src/jobs/presentation';

describe('job progress presentation', () => {
  it('formats byte counts and rates without losing bigint precision', () => {
    expect(formatBytes('9007199254740993')).toBe('8 PB');
    expect(formatBytes(1_048_576)).toBe('1 MB');
    expect(formatBytes(null)).toBe('—');
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(null)).toBe('—');
  });

  it('formats ETA and known job labels', () => {
    expect(formatEta(null)).toBe('Calculating…');
    expect(formatEta(45)).toBe('45 sec');
    expect(formatEta(3_600)).toBe('1 hr');
    expect(formatEta(90_000)).toBe('1 d 1 hr');
    expect(jobTypeLabel('catalog_sync')).toBe('Catalog sync');
    expect(jobPhaseLabel('verifying')).toBe('Verifying file');
    expect(jobPhaseLabel(null)).toBe('Waiting for worker');
    expect(isJobActive('queued')).toBe(true);
    expect(isJobActive('succeeded')).toBe(false);
  });

  it('presents update-check work in countries and shows only safe aggregate counts', () => {
    const updateJob = {
      type: 'update_check' as const,
      status: 'running' as const,
      phase: null,
      progressBytes: 2,
      totalBytes: 4,
      speedBps: 1,
    };
    expect(jobActivityLabel(updateJob)).toBe('Checking updates');
    expect(jobProgressLabel(updateJob)).toBe('2 of 4 countries checked · 50%');
    expect(jobRateLabel(updateJob)).toBe('1 country/s');
    expect(
      updateCheckResultLabel({
        total: 4,
        checked: 3,
        updateAvailable: 1,
        upToDate: 1,
        unknown: 1,
        skipped: 1,
      }),
    ).toBe('3 checked · 1 update · 1 current · 1 unknown · 1 skipped');
  });

  it('computes determinate progress safely for large integers and clamps out-of-range values', () => {
    expect(progressPercent({ progressBytes: '50', totalBytes: '200' })).toBe(25);
    expect(
      progressPercent({ progressBytes: '9007199254740992', totalBytes: '9007199254740993' }),
    ).toBe(99.99);
    expect(progressPercent({ progressBytes: '500', totalBytes: '0' })).toBeNull();
    expect(progressPercent({ progressBytes: '500', totalBytes: '100' })).toBe(100);
  });
});
