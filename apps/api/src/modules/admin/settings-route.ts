/** Admin-editable application settings endpoints (`P5-ADM-01`).
 *
 * @module modules/admin/settings-route
 */

import {
  AdminSettingCatalogTtlMinutesSchema,
  AdminSettingDiskReserveBytesSchema,
  AdminSettingDisplayNameSchema,
  AdminSettingDownloadsPerMinuteSchema,
  AdminSettingKeepVersionsSchema,
  AdminSettingsQuerySchema,
  AdminSettingsResponseSchema,
  AdminSettingsUpdateSchema,
  type AdminSettingsUpdate,
  type AdminSettingsValues,
} from '@mapirror/shared';
import { sql } from 'kysely';
import type { FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env';
import type { Setting } from '../../db/schema';
import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import { withTransaction } from '../../db/transaction';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';

/** Database keys the settings API is allowed to read or write. All other keys are outside this response surface. */
export const ADMIN_EDITABLE_SETTING_KEYS = {
  displayName: 'branding.displayName',
  keepVersions: 'cache.keepVersions',
  diskReserveBytes: 'cache.diskReserveBytes',
  downloadsPerMinute: 'public.downloadsPerMinute',
  catalogTtlMinutes: 'source.catalogTtlMinutes',
} as const;

const ALLOWED_SETTING_KEYS = Object.values(ADMIN_EDITABLE_SETTING_KEYS);
type SettingsRow = Pick<Setting, 'key' | 'value'>;
type SettingsFallbacks = Pick<
  AppConfig,
  'brandingDisplayName' | 'diskReserveBytes' | 'publicDownloadsPerMinute' | 'catalogTtlMinutes'
>;

/**
 * Projects database rows onto the five public values, applying environment defaults where no valid override exists.
 *
 * Unknown, secret and system-owned rows are ignored. A malformed legacy value falls back to the safe configured value
 * and is reported through `onInvalid`; it can never make the serializer echo arbitrary JSON to the client.
 *
 * @param rows - Rows selected from the allow-listed settings keys.
 * @param fallbacks - Validated process defaults.
 * @param onInvalid - Optional warning callback for a malformed persisted value.
 * @returns A strict settings response payload.
 */
export function serializeAdminSettings(
  rows: readonly SettingsRow[],
  fallbacks: SettingsFallbacks,
  onInvalid?: (key: string) => void,
): AdminSettingsValues {
  const stored = new Map(rows.map(({ key, value }) => [key, value]));
  const read = <T>(
    key: string,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    fallback: T,
  ): T => {
    const value = stored.get(key);
    if (value === undefined) return fallback;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    onInvalid?.(key);
    return fallback;
  };

  return AdminSettingsResponseSchema.shape.settings.parse({
    branding: {
      displayName: read(
        ADMIN_EDITABLE_SETTING_KEYS.displayName,
        AdminSettingDisplayNameSchema,
        fallbacks.brandingDisplayName,
      ),
    },
    cache: {
      keepVersions: read(
        ADMIN_EDITABLE_SETTING_KEYS.keepVersions,
        AdminSettingKeepVersionsSchema,
        3,
      ),
      diskReserveBytes: read(
        ADMIN_EDITABLE_SETTING_KEYS.diskReserveBytes,
        AdminSettingDiskReserveBytesSchema,
        fallbacks.diskReserveBytes,
      ),
    },
    public: {
      downloadsPerMinute: read(
        ADMIN_EDITABLE_SETTING_KEYS.downloadsPerMinute,
        AdminSettingDownloadsPerMinuteSchema,
        fallbacks.publicDownloadsPerMinute,
      ),
    },
    source: {
      catalogTtlMinutes: read(
        ADMIN_EDITABLE_SETTING_KEYS.catalogTtlMinutes,
        AdminSettingCatalogTtlMinutesSchema,
        fallbacks.catalogTtlMinutes,
      ),
    },
  });
}

/** Reads the configured defaults plus persisted editable values; the SQL projection is itself an allow-list. */
export async function getAdminSettings(request: FastifyRequest, config: AppConfig) {
  const query = AdminSettingsQuerySchema.safeParse(request.query);
  if (!query.success) throw query.error;

  const rows = await request.server.db.db
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('key', 'in', [...ALLOWED_SETTING_KEYS])
    .execute();
  const settings = serializeAdminSettings(rows, config, (key) =>
    request.log.warn({ key }, 'Ignoring invalid persisted admin setting.'),
  );
  return AdminSettingsResponseSchema.parse({ settings });
}

/** Persists a strict partial update and its audit row atomically, then returns the complete safe projection. */
export async function patchAdminSettings(request: FastifyRequest, config: AppConfig) {
  const parsed = AdminSettingsUpdateSchema.safeParse(request.body);
  if (!parsed.success) throw parsed.error;
  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const changes = toDatabaseChanges(parsed.data);
  const settings = await withTransaction(request.server.db.db, async (trx) => {
    for (const { key, value } of changes) {
      await trx
        .insertInto('settings')
        .values({ key, value: JSON.stringify(value) })
        .onConflict((conflict) =>
          conflict
            .column('key')
            .doUpdateSet({ value: JSON.stringify(value), updated_at: sql<Date>`now()` }),
        )
        .execute();
    }

    await insertAuditLog(trx, {
      actorId: admin.id,
      actorName: admin.username,
      action: AUDIT_ACTIONS.settingsUpdate,
      targetType: 'settings',
      targetId: null,
      ip: normaliseIp(request.ip),
      metadata: { keys: changes.map(({ key }) => key) },
    });

    const rows = await trx
      .selectFrom('settings')
      .select(['key', 'value'])
      .where('key', 'in', [...ALLOWED_SETTING_KEYS])
      .execute();
    return serializeAdminSettings(rows, config, (key) =>
      request.log.warn({ key }, 'Ignoring invalid persisted admin setting.'),
    );
  });

  return AdminSettingsResponseSchema.parse({ settings });
}

interface DatabaseSettingChange {
  readonly key: (typeof ALLOWED_SETTING_KEYS)[number];
  readonly value: string | number;
}

/** Maps the API's grouped partial body to only the corresponding allow-listed database keys. */
function toDatabaseChanges(update: AdminSettingsUpdate): DatabaseSettingChange[] {
  const changes: DatabaseSettingChange[] = [];
  if (update.branding?.displayName !== undefined)
    changes.push({
      key: ADMIN_EDITABLE_SETTING_KEYS.displayName,
      value: update.branding.displayName,
    });
  if (update.cache?.keepVersions !== undefined)
    changes.push({
      key: ADMIN_EDITABLE_SETTING_KEYS.keepVersions,
      value: update.cache.keepVersions,
    });
  if (update.cache?.diskReserveBytes !== undefined)
    changes.push({
      key: ADMIN_EDITABLE_SETTING_KEYS.diskReserveBytes,
      value: update.cache.diskReserveBytes,
    });
  if (update.public?.downloadsPerMinute !== undefined)
    changes.push({
      key: ADMIN_EDITABLE_SETTING_KEYS.downloadsPerMinute,
      value: update.public.downloadsPerMinute,
    });
  if (update.source?.catalogTtlMinutes !== undefined)
    changes.push({
      key: ADMIN_EDITABLE_SETTING_KEYS.catalogTtlMinutes,
      value: update.source.catalogTtlMinutes,
    });
  return changes;
}
