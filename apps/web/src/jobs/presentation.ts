/** Presentation helpers for the admin job list and progress drawer (`P2-WEB-06`).
 *
 * @module jobs/presentation
 */

import type { JobView } from '@mapirror/shared';

/** Human labels for the finite job and phase vocabularies. */
const JOB_TYPE_LABELS: Record<JobView['type'], string> = {
  download: 'Download',
  import: 'Import',
  update_check: 'Update check',
  catalog_sync: 'Catalog sync',
  prune: 'Prune',
};

const PHASE_LABELS: Record<NonNullable<JobView['phase']>, string> = {
  fetching_index: 'Fetching source index',
  downloading: 'Downloading',
  verifying: 'Verifying file',
  installing: 'Installing',
};

/** Label a job type without exposing internal enum spelling. */
export function jobTypeLabel(type: JobView['type']): string {
  return JOB_TYPE_LABELS[type];
}

/** Label a phase, or a stable neutral state when no phase is currently reported. */
export function jobPhaseLabel(phase: JobView['phase']): string {
  return phase === null ? 'Waiting for worker' : PHASE_LABELS[phase];
}

/** Label update-check work and terminal states without calling country counts bytes. */
export function jobActivityLabel(job: Pick<JobView, 'type' | 'status' | 'phase'>): string {
  if (job.type !== 'update_check') return jobPhaseLabel(job.phase);
  if (job.status === 'queued') return 'Waiting for worker';
  if (job.status === 'running') return 'Checking updates';
  if (job.status === 'succeeded') return 'Update check complete';
  if (job.status === 'failed') return 'Update check failed';
  return 'Update check canceled';
}

/** Whether the job is still eligible for cancellation. */
export function isJobActive(status: JobView['status']): boolean {
  return status === 'queued' || status === 'running';
}

/** Format a non-negative JSON bigint without losing precision. */
export function formatBytes(value: number | string | null): string {
  if (value === null) return '—';
  let bytes: bigint;
  try {
    bytes = BigInt(value);
  } catch {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
  let unit = 0;
  let remainder = bytes;
  while (remainder >= 1024n && unit < units.length - 1) {
    remainder = bytes / 1024n ** BigInt(unit + 1);
    unit += 1;
  }
  if (unit === 0) return `${bytes.toString()} B`;
  const divisor = 1024n ** BigInt(unit);
  const hundredths = (bytes * 100n) / divisor;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/u, '');
  return `${whole.toString()}${fraction === '' ? '' : `.${fraction}`} ${units[unit]}`;
}

/** Format the current transfer rate, when supplied by the worker. */
export function formatSpeed(speedBps: number | string | null): string {
  return speedBps === null ? '—' : `${formatBytes(speedBps)}/s`;
}

/** Format a bounded ETA as a short duration; null means the worker cannot estimate it yet. */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return 'Calculating…';
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24)
    return remainingMinutes === 0 ? `${hours} hr` : `${hours} hr ${remainingMinutes} min`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days} d` : `${days} d ${remainingHours} hr`;
}

/** Progress bar percent, computed with bigint to preserve precision for large files. */
export function progressPercent(job: Pick<JobView, 'progressBytes' | 'totalBytes'>): number | null {
  if (job.totalBytes === null || BigInt(job.totalBytes) === 0n) return null;
  const current = BigInt(job.progressBytes);
  const total = BigInt(job.totalBytes);
  const scaled = Number((current * 10_000n) / total) / 100;
  return Math.min(100, Math.max(0, scaled));
}

/** Human progress text, using country counts for update-check jobs and bytes for transfers. */
export function jobProgressLabel(
  job: Pick<JobView, 'type' | 'progressBytes' | 'totalBytes'>,
): string {
  if (job.type === 'update_check') {
    const checked = BigInt(job.progressBytes).toLocaleString();
    if (job.totalBytes === null) return `${checked} countries checked`;
    const total = BigInt(job.totalBytes).toLocaleString();
    const percent = progressPercent(job);
    return `${checked} of ${total} countries checked${percent === null ? '' : ` · ${percent}%`}`;
  }
  if (job.totalBytes === null) return `${formatBytes(job.progressBytes)} transferred`;
  const percent = progressPercent(job);
  return `${formatBytes(job.progressBytes)} / ${formatBytes(job.totalBytes)}${percent === null ? '' : ` · ${percent}%`}`;
}

/** Rate text for count-based update checks; transfer jobs retain byte units. */
export function jobRateLabel(job: Pick<JobView, 'type' | 'speedBps'>): string {
  if (job.speedBps === null) return '—';
  if (job.type !== 'update_check') return formatSpeed(job.speedBps);
  const count = BigInt(job.speedBps);
  return `${count.toLocaleString()} ${count === 1n ? 'country' : 'countries'}/s`;
}

/** Compact safe aggregate of a completed bulk check. */
export function updateCheckResultLabel(result: JobView['updateCheckResult']): string | null {
  if (result === null) return null;
  const updates = `${result.updateAvailable} update${result.updateAvailable === 1 ? '' : 's'}`;
  return `${result.checked} checked · ${updates} · ${result.upToDate} current · ${result.unknown} unknown · ${result.skipped} skipped`;
}

/** Friendly date in the administrator's current locale. */
export function formatJobDate(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
