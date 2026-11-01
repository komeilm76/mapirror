/** Read-only, filtered admin audit log endpoint (`P5-ADM-03`).
 *
 * @module modules/admin/audit-route
 */

import {
  AuditListQuerySchema,
  AuditListResponseSchema,
  buildPageMeta,
  parsePagination,
  type AuditEntry,
  type AuditListQuery,
} from '@mapirror/shared';
import { sql, type SelectQueryBuilder } from 'kysely';
import type { FastifyRequest } from 'fastify';

import type { AuditLogs, Database, JsonValue, SelectRow } from '../../db/schema';

const DEFAULT_AUDIT_PAGE_SIZE = 25;
const MAX_AUDIT_PAGE_SIZE = 100;
const SENSITIVE_METADATA_KEYS = new Set([
  'ip',
  'password',
  'passwd',
  'credential',
  'credentials',
  'token',
  'secret',
  'authorization',
  'cookie',
  'cookies',
  'hash',
  'salt',
]);
const SENSITIVE_METADATA_COMPOUNDS = new Set([
  'ipaddress',
  'remoteaddress',
  'useragent',
  'apikey',
  'privatekey',
  'accesskey',
  'forwardedfor',
]);

/** Explicit allow-list: in particular, `ip` and `actor_id` are never read for the API response. */
const AUDIT_COLUMNS = [
  'id',
  'actor_name',
  'action',
  'target_type',
  'target_id',
  'metadata',
  'created_at',
] as const;

type AuditListRow = Pick<SelectRow<AuditLogs>, (typeof AUDIT_COLUMNS)[number]>;
type JsonObject = { [key: string]: JsonValue };

/** List handler for route registration; wraps the endpoint's page metadata with its data. */
export async function listAuditLog(request: FastifyRequest) {
  const parsed = AuditListQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;
  const query = parsed.data;
  const pagination = parsePagination(query, {
    defaultLimit: DEFAULT_AUDIT_PAGE_SIZE,
    maxLimit: MAX_AUDIT_PAGE_SIZE,
  });

  const snapshot = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const rowsQuery = filterAuditRows(trx.selectFrom('audit_logs').select(AUDIT_COLUMNS), query)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(pagination.limit)
        .offset(pagination.offset);
      const countQuery = filterAuditRows(
        trx.selectFrom('audit_logs').select(sql<string>`count(*)::text`.as('total')),
        query,
      );
      const [rows, count] = await Promise.all([
        rowsQuery.execute(),
        countQuery.executeTakeFirstOrThrow(),
      ]);
      return { rows, total: safeCount(count.total) };
    });

  return AuditListResponseSchema.parse({
    data: snapshot.rows.map(toAuditEntry),
    meta: buildPageMeta(pagination.page, pagination.limit, snapshot.total),
  });
}

function filterAuditRows<Output>(
  query: SelectQueryBuilder<Database, 'audit_logs', Output>,
  filters: Pick<AuditListQuery, 'action'>,
): SelectQueryBuilder<Database, 'audit_logs', Output> {
  return filters.action === undefined ? query : query.where('action', '=', filters.action);
}

function toAuditEntry(row: AuditListRow): AuditEntry {
  return {
    id: row.id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: sanitizeMetadata(row.metadata),
    createdAt: row.created_at.toISOString(),
  };
}

/** Removes sensitive data keys at every nesting level; the IP column is omitted separately by the select allow-list. */
function sanitizeMetadata(value: JsonValue): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return {};
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    result[key] = sanitizeJsonValue(child);
  }
  return result;
}

function sanitizeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    result[key] = sanitizeJsonValue(child);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
  const parts = normalized.split(/[^a-z0-9]+/u);
  return (
    parts.some((part) => SENSITIVE_METADATA_KEYS.has(part)) ||
    SENSITIVE_METADATA_COMPOUNDS.has(parts.join(''))
  );
}

function safeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('audit row count is not a non-negative decimal integer');
  }
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('audit row count exceeds the JSON safe integer range');
  }
  return Number(count);
}
