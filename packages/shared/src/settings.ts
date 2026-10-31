/**
 * Admin-editable settings contracts (`P5-ADM-01`).
 *
 * The public response is a deliberate projection of five editable values. Runtime secrets and system-owned settings are
 * not represented here, so a caller cannot ask the API to echo them by supplying a key or query parameter.
 *
 * @module settings
 */

import { z } from 'zod';

export const AdminSettingDisplayNameSchema = z.string().trim().min(1).max(100);
export const AdminSettingKeepVersionsSchema = z.number().int().min(1).max(10);
export const AdminSettingDiskReserveBytesSchema = z.number().int().nonnegative().safe();
export const AdminSettingDownloadsPerMinuteSchema = z.number().int().positive().safe();
export const AdminSettingCatalogTtlMinutesSchema = z.number().int().positive().safe();

/** The complete set of user-editable values returned by `GET /_admin/api/settings`. */
export const AdminSettingsValuesSchema = z
  .object({
    branding: z.object({ displayName: AdminSettingDisplayNameSchema }).strict(),
    cache: z
      .object({
        keepVersions: AdminSettingKeepVersionsSchema,
        diskReserveBytes: AdminSettingDiskReserveBytesSchema,
      })
      .strict(),
    public: z.object({ downloadsPerMinute: AdminSettingDownloadsPerMinuteSchema }).strict(),
    source: z.object({ catalogTtlMinutes: AdminSettingCatalogTtlMinutesSchema }).strict(),
  })
  .strict();

/** Empty query shape for `GET /_admin/api/settings`; unknown keys are rejected. */
export const AdminSettingsQuerySchema = z.object({}).strict();

/** Response shape for both settings endpoints. */
export const AdminSettingsResponseSchema = z
  .object({ settings: AdminSettingsValuesSchema })
  .strict();

const AdminSettingsUpdateFieldsSchema = z
  .object({
    branding: z
      .object({ displayName: AdminSettingDisplayNameSchema })
      .strict()
      .partial()
      .optional(),
    cache: z
      .object({
        keepVersions: AdminSettingKeepVersionsSchema,
        diskReserveBytes: AdminSettingDiskReserveBytesSchema,
      })
      .strict()
      .partial()
      .optional(),
    public: z
      .object({ downloadsPerMinute: AdminSettingDownloadsPerMinuteSchema })
      .strict()
      .partial()
      .optional(),
    source: z
      .object({ catalogTtlMinutes: AdminSettingCatalogTtlMinutesSchema })
      .strict()
      .partial()
      .optional(),
  })
  .strict();

/** Partial update body for `PATCH /_admin/api/settings`; every supplied section must contain a value. */
export const AdminSettingsUpdateSchema = AdminSettingsUpdateFieldsSchema.refine(
  (value) =>
    Object.values(value).some(
      (section) => section !== undefined && Object.keys(section).length > 0,
    ),
  { message: 'Provide at least one editable setting.' },
);

/** Type inferred from {@link AdminSettingsValuesSchema}. */
export type AdminSettingsValues = z.infer<typeof AdminSettingsValuesSchema>;
/** Type inferred from {@link AdminSettingsUpdateSchema}. */
export type AdminSettingsUpdate = z.infer<typeof AdminSettingsUpdateSchema>;
