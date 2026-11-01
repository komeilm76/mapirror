/** Display and CSV helpers for the admin audit screen (`P5-ADM-04`).
 *
 * @module audit/presentation
 */

import { AUDIT_ACTIONS, type AuditAction, type AuditEntry } from '@mapirror/shared';

const ACTION_LABELS: Record<AuditAction, string> = {
  [AUDIT_ACTIONS.login]: 'Admin signed in',
  [AUDIT_ACTIONS.loginFailed]: 'Sign-in failed',
  [AUDIT_ACTIONS.logout]: 'Admin signed out',
  [AUDIT_ACTIONS.adminCreated]: 'Admin account created',
  [AUDIT_ACTIONS.passwordReset]: 'Admin password reset',
  [AUDIT_ACTIONS.catalogSync]: 'Catalog synchronized',
  [AUDIT_ACTIONS.cacheDeleteCountry]: 'Cache deleted',
  [AUDIT_ACTIONS.cachePublish]: 'Country published',
  [AUDIT_ACTIONS.cacheUnpublish]: 'Country unpublished',
  [AUDIT_ACTIONS.versionDelete]: 'Cached version deleted',
  [AUDIT_ACTIONS.versionPrune]: 'Old versions pruned',
  [AUDIT_ACTIONS.intervalCreate]: 'Interval created',
  [AUDIT_ACTIONS.intervalUpdate]: 'Interval updated',
  [AUDIT_ACTIONS.intervalDelete]: 'Interval deleted',
  [AUDIT_ACTIONS.intervalRun]: 'Interval run started',
  [AUDIT_ACTIONS.settingsUpdate]: 'Settings updated',
};

const CSV_HEADERS = ['ID', 'Time (UTC)', 'Actor', 'Action', 'Target type', 'Target ID', 'Metadata'];

/** Turns a known dotted action into readable copy and leaves future server actions intact. */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action as AuditAction] ?? action;
}

/** Formats an ISO timestamp in UTC, with the time zone named explicitly. */
export function formatAuditDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(date);
  return `${formatted} UTC`;
}

/** Pretty-prints already-safe metadata for a native disclosure control. */
export function formatAuditMetadata(metadata: AuditEntry['metadata']): string {
  return JSON.stringify(metadata, null, 2) ?? '{}';
}

/** Serializes only the safe fields in the current page to RFC-4180-compatible CSV. */
export function auditEntriesToCsv(entries: readonly AuditEntry[]): string {
  const rows = [
    CSV_HEADERS,
    ...entries.map((entry) => [
      entry.id,
      entry.createdAt,
      entry.actorName,
      auditActionLabel(entry.action),
      entry.targetType ?? '',
      entry.targetId ?? '',
      JSON.stringify(entry.metadata),
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** Downloads the currently visible page; server-projected entries contain neither IPs nor credentials. */
export function downloadAuditCsv(entries: readonly AuditEntry[], page: number): void {
  const blob = new Blob([`\uFEFF${auditEntriesToCsv(entries)}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mapirror-audit-page-${page}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value: string): string {
  // Spreadsheet applications execute formula-like cells. Prefix the original value with a literal apostrophe when its
  // first non-whitespace character is an operator, before applying ordinary CSV quoting and quote doubling.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
