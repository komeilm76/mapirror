/**
 * Compares Geofabrik's current source identity with ready cached versions and persists the result (`P4-UPD-01`).
 *
 * `unknown` is a real result: source errors and incomplete comparisons never become `up_to_date`. Source region detail
 * is memoized for ten minutes per region, while each check still compares that identity against current ready versions
 * and writes the resulting state to `country_cache`.
 *
 * @module modules/updates/update-check
 */

import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import type { MapSource, SourceRegionDetail } from '../geofabrik/source';

/** Persisted update-check states, shared with the `country_cache.update_state` constraint. */
export type UpdateCheckState = 'unknown' | 'up_to_date' | 'update_available';

/** Source identity for one ready Geofabrik version already stored locally. */
export interface CachedSourceIdentity {
  /** Immutable stored version label; dated snapshots match the source's six-digit version directly. */
  readonly version: string;
  /** Stored OSM data-freshness instant, when it was provided by Geofabrik. */
  readonly dataTimestamp: Date | null;
  /** Verified installed file size. */
  readonly sizeBytes: string | number | bigint;
}

/** Comparison result and the source facts suitable for persistence and later API projection. */
export interface UpdateCheckResult {
  /** Honest comparison state; `unknown` is never treated as up to date. */
  readonly state: UpdateCheckState;
  /** Source version to download when an update is available; null when the source did not identify one. */
  readonly availableVersion: string | null;
  /** Advertised source size, or null when unavailable. */
  readonly availableSizeBytes: number | null;
  /** Source data-freshness timestamp, or null when unavailable. */
  readonly availableAt: Date | null;
  /** Safe explanation when the state is unknown; never contains raw exception text. */
  readonly reason: string | null;
  /** Newest ready cached Geofabrik version used in the comparison. */
  readonly cached: {
    readonly version: string | null;
    readonly dataTimestamp: Date | null;
    readonly sizeBytes: string | number | bigint | null;
  };
  /** Current source facts when safely available; null after a source failure. */
  readonly source: {
    readonly version: string | null;
    readonly dataTimestamp: Date | null;
    readonly sizeBytes: number | null;
  } | null;
  /** Time the state was persisted. */
  readonly checkedAt: Date;
}

/** Log surface used to retain source failures without returning raw errors to an API caller. */
export interface UpdateCheckLog {
  /** Records a source failure for diagnosis; callers must not expose the error to the browser. */
  readonly warn: (context: object, message: string) => void;
}

/** Dependencies and bounded in-memory source-detail cache for one API process. */
export interface UpdateChecker {
  /** Check one cached country; workers may supply their pinned database session. */
  check(countryId: string, database?: Kysely<Database>): Promise<UpdateCheckResult>;
}

export interface UpdateCheckerOptions {
  /** Database used to read countries/ready versions and persist cache state. */
  readonly database: Kysely<Database>;
  /** Configured source used to read current region details. */
  readonly source: Pick<MapSource, 'id' | 'getRegionDetail'>;
  /** Clock used for check timestamps and source-detail cache expiry. */
  readonly now?: () => Date;
  /** Source-detail TTL; defaults to ten minutes and is capped at ten minutes. */
  readonly sourceDetailTtlMs?: number;
  /** Optional process logger for source failures. */
  readonly log?: UpdateCheckLog;
}

/** Per-country source-page HTTP budget shared by inline and bulk update checks. */
export const UPDATE_CHECK_SOURCE_TIMEOUT_MS = 5_000;
/** One in-memory Geofabrik page identity is shared across row and bulk checks for ten minutes. */
const DEFAULT_SOURCE_DETAIL_TTL_MS = 10 * 60 * 1_000;
const MAX_SOURCE_DETAIL_TTL_MS = DEFAULT_SOURCE_DETAIL_TTL_MS;

/** Source versions are Geofabrik dated snapshots (`YYMMDD`). */
const SOURCE_VERSION_PATTERN = /^\d{6}$/u;

/** Thrown when a check is requested for a country without a cache row. */
export class UpdateCheckNotCachedError extends Error {
  /** The local country identifier that no longer has cache state. */
  readonly countryId: string;

  constructor(countryId: string) {
    super('The requested country does not have a cache entry.');
    this.name = 'UpdateCheckNotCachedError';
    this.countryId = countryId;
  }
}

/** Create a reusable checker; source reads are memoized, but cached versions and state are read on every check. */
export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const now = options.now ?? (() => new Date());
  const sourceDetailTtlMs = options.sourceDetailTtlMs ?? DEFAULT_SOURCE_DETAIL_TTL_MS;
  if (
    !Number.isSafeInteger(sourceDetailTtlMs) ||
    sourceDetailTtlMs < 1 ||
    sourceDetailTtlMs > MAX_SOURCE_DETAIL_TTL_MS
  ) {
    throw new RangeError(
      `sourceDetailTtlMs must be an integer from 1 to ${MAX_SOURCE_DETAIL_TTL_MS}`,
    );
  }

  const detailsByRegion = new Map<string, { detail: SourceRegionDetail; expiresAt: number }>();
  const inFlightByRegion = new Map<string, Promise<SourceRegionDetail>>();

  return {
    /** Check one cached country and persist its update state; source failures persist `unknown`. */
    async check(
      countryId: string,
      database: Kysely<Database> = options.database,
    ): Promise<UpdateCheckResult> {
      const identity = await database
        .selectFrom('countries')
        .innerJoin('country_cache', 'country_cache.country_id', 'countries.id')
        .select(['countries.source', 'countries.source_id'])
        .where('countries.id', '=', countryId)
        .executeTakeFirst();
      if (identity === undefined) throw new UpdateCheckNotCachedError(countryId);

      let sourceDetail: SourceRegionDetail | null = null;
      let sourceFailure = false;
      if (identity.source !== options.source.id) {
        sourceFailure = true;
        options.log?.warn(
          { countryId, source: identity.source },
          'Update check country source does not match the configured provider',
        );
      } else {
        try {
          sourceDetail = await getSourceDetail(identity.source_id);
        } catch (error) {
          sourceFailure = true;
          options.log?.warn(
            { countryId, sourceErrorName: error instanceof Error ? error.name : 'UnknownError' },
            'Update check could not read source details',
          );
        }
      }

      const checkedAt = validClockDate(now());
      return withTransaction(database, async (trx) => {
        const cache = await trx
          .selectFrom('country_cache')
          .select('country_id')
          .where('country_id', '=', countryId)
          .forUpdate()
          .executeTakeFirst();
        if (cache === undefined) throw new UpdateCheckNotCachedError(countryId);

        const cachedVersions = await trx
          .selectFrom('map_versions')
          .select(['version', 'data_timestamp', 'file_size_bytes'])
          .where('country_id', '=', countryId)
          .where('origin', 'in', ['geofabrik_snapshot', 'geofabrik_latest'])
          .where('status', '=', 'ready')
          .where('ready_at', 'is not', null)
          .orderBy(sql`data_timestamp DESC NULLS LAST`)
          .orderBy('ready_at', 'desc')
          .execute();

        const compared = sourceFailure
          ? unknownResult('The map source could not be checked.')
          : compareSourceToCache(
              sourceDetail,
              cachedVersions.map(({ version, data_timestamp, file_size_bytes }) => ({
                version,
                dataTimestamp: data_timestamp,
                sizeBytes: file_size_bytes,
              })),
            );
        await trx
          .updateTable('country_cache')
          .set({
            update_state: compared.state,
            available_version: compared.availableVersion,
            available_size_bytes: compared.availableSizeBytes,
            available_at: compared.availableAt,
            update_checked_at: checkedAt,
            updated_at: checkedAt,
          })
          .where('country_id', '=', countryId)
          .execute();

        const newestCached = cachedVersions[0];
        return {
          ...compared,
          cached: {
            version: newestCached?.version ?? null,
            dataTimestamp: newestCached?.data_timestamp ?? null,
            sizeBytes: newestCached?.file_size_bytes ?? null,
          },
          source: safeSourceIdentity(sourceFailure ? null : sourceDetail),
          checkedAt,
        };
      });
    },
  };

  async function getSourceDetail(regionId: string): Promise<SourceRegionDetail> {
    const instant = validClockDate(now()).getTime();
    for (const [cachedKey, entry] of detailsByRegion) {
      if (entry.expiresAt <= instant) detailsByRegion.delete(cachedKey);
    }
    const key = `${options.source.id}:${regionId}`;
    const cached = detailsByRegion.get(key);
    if (cached !== undefined && cached.expiresAt > instant) return cloneSourceDetail(cached.detail);
    if (cached !== undefined) detailsByRegion.delete(key);

    const existing = inFlightByRegion.get(key);
    if (existing !== undefined) return cloneSourceDetail(await existing);

    const request = options.source.getRegionDetail(regionId);
    inFlightByRegion.set(key, request);
    try {
      const detail = await request;
      const expiresAt = validClockDate(now()).getTime() + sourceDetailTtlMs;
      detailsByRegion.set(key, { detail: cloneSourceDetail(detail), expiresAt });
      return cloneSourceDetail(detail);
    } finally {
      if (inFlightByRegion.get(key) === request) inFlightByRegion.delete(key);
    }
  }
}

/** Compare the current source facts with versions ordered newest data timestamp first. */
function safeSourceIdentity(source: SourceRegionDetail | null): UpdateCheckResult['source'] {
  if (source === null) return null;
  return {
    version:
      source.version !== null && SOURCE_VERSION_PATTERN.test(source.version)
        ? source.version
        : null,
    dataTimestamp:
      source.dataTimestamp !== null && Number.isFinite(source.dataTimestamp.getTime())
        ? source.dataTimestamp
        : null,
    sizeBytes:
      source.sizeBytes !== null && Number.isSafeInteger(source.sizeBytes) && source.sizeBytes >= 0
        ? source.sizeBytes
        : null,
  };
}

export function compareSourceToCache(
  source: SourceRegionDetail | null,
  cachedVersions: readonly CachedSourceIdentity[],
): Omit<UpdateCheckResult, 'checkedAt' | 'cached' | 'source'> {
  if (source === null) return unknownResult('The map source could not be checked.');
  if (
    (source.version !== null && !SOURCE_VERSION_PATTERN.test(source.version)) ||
    (source.dataTimestamp !== null && !Number.isFinite(source.dataTimestamp.getTime())) ||
    (source.sizeBytes !== null && (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0))
  ) {
    return unknownResult('The map source returned incomplete version details.');
  }

  const exactVersionIsCached =
    source.version !== null && cachedVersions.some(({ version }) => version === source.version);
  if (exactVersionIsCached) return stateResult('up_to_date');
  const newestCached = cachedVersions[0];
  if (newestCached === undefined) {
    return unknownResult('No ready source version is available for comparison.');
  }

  const cachedTimestamp = validCachedTimestamp(newestCached.dataTimestamp);
  if (source.dataTimestamp !== null && cachedTimestamp !== null) {
    if (source.dataTimestamp.getTime() > cachedTimestamp.getTime()) {
      return availableResult(source);
    }
    if (source.dataTimestamp.getTime() < cachedTimestamp.getTime()) {
      return stateResult('up_to_date');
    }
    if (
      source.sizeBytes !== null &&
      BigInt(source.sizeBytes) !== nonNegativeBigint(newestCached.sizeBytes)
    ) {
      return availableResult(source);
    }
    return stateResult('up_to_date');
  }

  if (
    source.sizeBytes !== null &&
    BigInt(source.sizeBytes) !== nonNegativeBigint(newestCached.sizeBytes)
  ) {
    return availableResult(source);
  }
  if (source.dataTimestamp === null && source.version === null) {
    return unknownResult('The map source did not provide a comparable version identity.');
  }
  return unknownResult('The cached source version does not contain enough metadata to compare.');
}

/** Return a detached source-detail copy so callers cannot mutate the in-memory cache. */
function cloneSourceDetail(detail: SourceRegionDetail): SourceRegionDetail {
  return {
    ...detail,
    dataTimestamp: detail.dataTimestamp === null ? null : new Date(detail.dataTimestamp),
    lastModified: detail.lastModified === null ? null : new Date(detail.lastModified),
  };
}

function availableResult(
  source: SourceRegionDetail,
): Omit<UpdateCheckResult, 'checkedAt' | 'cached' | 'source'> {
  return {
    state: 'update_available',
    availableVersion: source.version,
    availableSizeBytes: source.sizeBytes,
    availableAt: source.dataTimestamp,
    reason: null,
  };
}

function stateResult(
  state: Exclude<UpdateCheckState, 'unknown'>,
): Omit<UpdateCheckResult, 'checkedAt' | 'cached' | 'source'> {
  return {
    state,
    availableVersion: null,
    availableSizeBytes: null,
    availableAt: null,
    reason: null,
  };
}

function unknownResult(reason: string): Omit<UpdateCheckResult, 'checkedAt' | 'cached' | 'source'> {
  return {
    state: 'unknown',
    availableVersion: null,
    availableSizeBytes: null,
    availableAt: null,
    reason,
  };
}

function validCachedTimestamp(value: Date | null): Date | null {
  if (value === null) return null;
  return Number.isFinite(value.getTime()) ? value : null;
}

function nonNegativeBigint(value: string | number | bigint): bigint {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : -1n;
  } catch {
    return -1n;
  }
}

function validClockDate(value: Date): Date {
  if (!Number.isFinite(value.getTime()))
    throw new RangeError('update-check clock returned an invalid date');
  return value;
}
