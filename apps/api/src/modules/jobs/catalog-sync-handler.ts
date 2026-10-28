/**
 * Idempotent catalog synchronization and TTL decision for Geofabrik (`P2-SRC-06`, GEO-1).
 *
 * The handler fetches and validates the complete source index before opening a transaction, then preserves assigned
 * slugs, upserts only current source records, leaves removed records and their cache untouched, and appends one audit
 * row in the same transaction. A transaction-scoped advisory lock serializes overlapping syncs so each derives slugs
 * from the catalog state left by the previous committed sync.
 *
 * @module modules/jobs/catalog-sync-handler
 */

import { z } from 'zod';
import { sql, type Kysely, type Transaction } from 'kysely';

import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import { CATALOG_SYNCED_AT_SETTING, upsertCatalogCountry } from '../../db/repositories/catalog';
import { withTransaction } from '../../db/transaction';
import type { Database, JsonValue } from '../../db/schema';
import { baseGeofabrikSlug, deriveGeofabrikSlugs } from '../geofabrik/slug';
import type { MapSource, SourceRegion } from '../geofabrik/source';
import type { JobHandler } from './worker';

const CatalogSyncPayloadSchema = z
  .object({
    source: z.literal('geofabrik').optional().default('geofabrik'),
  })
  .strict();

/** The source capability this handler uses; a full `MapSource` structurally satisfies it. */
export type CatalogIndexSource = Pick<MapSource, 'id' | 'listRegions'>;

/** Dependencies for one catalog sync handler. */
export interface CatalogSyncHandlerOptions {
  /** The configured source used to fetch the catalog index. */
  readonly source: CatalogIndexSource;
  /** Clock for the shared country catalog timestamp. */
  readonly now?: () => Date;
}

/**
 * Creates the durable `catalog_sync` job handler.
 *
 * The handler always performs the requested sync; TTL is a *trigger policy* exposed by
 * {@link isCatalogSyncDue}, not a reason to ignore an explicit/manual job. P2-API-02 wires the handler to the configured
 * index source and queue trigger. The source request, lock wait and row writes are cancellation-aware. No row is deleted
 * when the upstream index omits it.
 *
 * @param options - Source and optional clock.
 * @returns A worker-compatible catalog handler.
 */
export function createCatalogSyncHandler(options: CatalogSyncHandlerOptions): JobHandler {
  const now = options.now ?? (() => new Date());

  return async (job, context): Promise<JsonValue> => {
    if (job.type !== 'catalog_sync')
      throw new TypeError('catalog sync handler received a non-catalog job');
    const payload = CatalogSyncPayloadSchema.parse(job.payload);
    if (payload.source !== options.source.id)
      throw new TypeError('catalog sync source does not match its handler');
    throwIfAborted(context.signal);

    // The index client applies both a deadline and this signal to the fetch and complete JSON body read.
    const regions = await options.source.listRegions(context.signal);
    throwIfAborted(context.signal);
    const syncedAt = now();
    if (!Number.isFinite(syncedAt.getTime()))
      throw new RangeError('catalog sync clock returned an invalid date');

    const syncedCount = await withTransaction(context.database, async (trx) => {
      // Multiple workers may claim distinct catalog_sync jobs. Try-lock polling keeps lock contention cancelable.
      await acquireCatalogSyncLock(trx, options.source.id, context.signal);

      const existing = await trx
        .selectFrom('countries')
        .select(['source_id', 'slug'])
        .where('source', '=', options.source.id)
        .execute();
      const existingSlugs = new Map(existing.map((country) => [country.source_id, country.slug]));
      const slugs = deriveGeofabrikSlugs(regions, existingSlugs);
      const orderedRegions = [...regions].sort(compareSourceId);
      const slugResolutions = orderedRegions.flatMap((region) => {
        const slug = slugs.get(region.id);
        return slug !== undefined && slug !== baseGeofabrikSlug(region)
          ? [{ sourceId: region.id, slug }]
          : [];
      });

      for (const region of orderedRegions) {
        throwIfAborted(context.signal);
        const slug = slugs.get(region.id);
        if (slug === undefined)
          throw new Error('catalog sync did not derive a slug for a source record');
        await upsertCatalogCountry(
          trx,
          {
            source: options.source.id,
            sourceId: region.id,
            parentId: region.parentId,
            slug,
            name: region.name,
            isoAlpha2: region.isoAlpha2,
            isoOther: region.isoOther,
            sourcePbfUrl: region.pbfUrl,
            sourceSizeHintBytes: null,
          },
          syncedAt,
        );
      }

      throwIfAborted(context.signal);
      const syncedAtValue = syncedAt.toISOString();
      await trx
        .insertInto('settings')
        .values({
          key: CATALOG_SYNCED_AT_SETTING,
          value: JSON.stringify(syncedAtValue),
          updated_at: syncedAt,
        })
        .onConflict((conflict) =>
          conflict
            .column('key')
            .doUpdateSet({ value: JSON.stringify(syncedAtValue), updated_at: syncedAt }),
        )
        .execute();

      const creator =
        job.created_by === null
          ? undefined
          : await trx
              .selectFrom('admins')
              .select('username')
              .where('id', '=', job.created_by)
              .executeTakeFirst();
      await insertAuditLog(trx, {
        actorId: creator === undefined ? null : job.created_by,
        actorName: creator?.username ?? 'system',
        action: AUDIT_ACTIONS.catalogSync,
        targetType: 'catalog',
        targetId: options.source.id,
        metadata: {
          source: options.source.id,
          regionCount: orderedRegions.length,
          slugResolutions,
        },
      });
      return orderedRegions.length;
    });

    return { source: options.source.id, syncedCount };
  };
}

/**
 * Returns whether the configured catalog freshness window has elapsed since the last committed catalog transaction.
 *
 * An empty upstream catalog is still a successful sync, so freshness is recorded in the system-owned
 * `source.catalogSyncedAt` setting in the same transaction as the country upserts and audit. It survives job-history
 * pruning and is absent when an audit/upsert transaction rolls back. An already queued/running sync suppresses another
 * trigger while the existing job is responsible for refreshing it. This read is not an enqueue reservation; concurrent
 * trigger callers still use the idempotent queue operation so only one active job is created.
 *
 * @param database - Database used to read the durable catalog timestamp.
 * @param ttlMinutes - Positive, safe whole number from `CATALOG_TTL_MINUTES`.
 * @param now - Clock used for the comparison; defaults to the current time.
 * @returns `true` when a sync should be triggered, including when no valid sync timestamp exists.
 */
export async function isCatalogSyncDue(
  database: Kysely<Database>,
  ttlMinutes: number,
  now: Date = new Date(),
): Promise<boolean> {
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1) {
    throw new RangeError('catalog TTL must be a positive safe whole number of minutes');
  }
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('catalog TTL clock returned an invalid date');

  const active = await database
    .selectFrom('jobs')
    .select('id')
    .where('type', '=', 'catalog_sync')
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirst();
  if (active !== undefined) return false;

  const marker = await database
    .selectFrom('settings')
    .select('value')
    .where('key', '=', CATALOG_SYNCED_AT_SETTING)
    .executeTakeFirst();
  const markerValue = marker?.value;
  if (typeof markerValue !== 'string') return true;
  const syncedAt = new Date(markerValue);
  if (!Number.isFinite(syncedAt.getTime()) || syncedAt.toISOString() !== markerValue) return true;

  const ageMs = BigInt(now.getTime()) - BigInt(syncedAt.getTime());
  const ttlMs = BigInt(ttlMinutes) * 60_000n;
  return ageMs >= ttlMs;
}

/** Takes the per-source transaction lock without leaving cancellation stuck behind a blocking advisory-lock call. */
async function acquireCatalogSyncLock(
  trx: Transaction<Database>,
  sourceId: string,
  signal: AbortSignal,
): Promise<void> {
  const lockKey = `mapirror.catalog_sync:${sourceId}`;
  while (true) {
    throwIfAborted(signal);
    const result = await sql<{ acquired: boolean }>`
      select pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) as acquired
    `.execute(trx);
    if (result.rows[0]?.acquired === true) return;
    await waitForAbortableDelay(signal, 25);
  }
}

/** Waits briefly before retrying the advisory lock, resolving immediately when the worker cancels. */
function waitForAbortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('catalog sync was canceled'));
    };
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Deterministic source-id ordering prevents lock-order changes across otherwise identical syncs. */
function compareSourceId(left: SourceRegion, right: SourceRegion): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** Throws the original cancellation reason so the worker can mark the durable job canceled after this handler settles. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('catalog sync was canceled');
}
