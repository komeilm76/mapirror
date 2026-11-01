/**
 * Shared safe read contract for the append-only admin audit log (`P5-ADM-03`).
 *
 * IP addresses and actor database ids are intentionally absent. Metadata remains structured, but the API applies a
 * sensitive-key projection before it is validated against this contract.
 *
 * @module audit
 */

import { z } from 'zod';

/** Action is an open string so a newer server can add an action without breaking older clients. */
export const AuditActionFilterSchema = z.string().trim().min(1).max(128);

/** List filters for `GET /_admin/api/audit`; pagination is normalized by the shared pagination helper. */
export const AuditListQuerySchema = z
  .object({
    action: AuditActionFilterSchema.optional(),
    page: z.unknown().optional(),
    limit: z.unknown().optional(),
  })
  .strict();

/** Safe audit row projection. It deliberately has no IP or actor-id field. */
export const AuditEntrySchema = z
  .object({
    id: z.string().regex(/^(?:0|[1-9]\d*)$/u),
    actorName: z.string(),
    action: z.string().min(1),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    metadata: z.record(z.string(), z.json()),
    createdAt: z.iso.datetime(),
  })
  .strict();

/** Paginated response contract for the admin audit list. */
export const AuditListResponseSchema = z
  .object({
    data: z.array(AuditEntrySchema),
    meta: z
      .object({
        page: z.number().int().positive(),
        limit: z.number().int().positive(),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;
