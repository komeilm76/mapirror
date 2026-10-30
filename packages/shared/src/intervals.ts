/** Shared contracts for interval schedule CRUD (`P4-INT-04`).
 *
 * @module intervals
 */

import { z } from 'zod';

import { INTERVAL_FREQUENCIES } from './constants';

const IntervalNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !value.includes('\u0000'), 'NUL characters are not allowed');
/** Maximum country memberships allowed for one interval. */
export const MAX_INTERVAL_COUNTRIES = 200;

const CountryIdsSchema = z
  .array(z.uuid())
  .max(MAX_INTERVAL_COUNTRIES)
  .refine((values) => new Set(values).size === values.length, 'Country ids must be unique.');
const TimeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

/** UUID path contract for one interval. */
export const IntervalParamsSchema = z.object({ id: z.uuid() }).strict();

/** Path params for interval detail, update, and delete routes. */
export type IntervalParams = z.infer<typeof IntervalParamsSchema>;

/** Create contract; frequency-specific field relationships are reported as HTTP 422 semantic errors by the route. */
export const IntervalCreateBodySchema = z
  .object({
    name: IntervalNameSchema,
    frequency: z.enum(INTERVAL_FREQUENCIES),
    timeOfDay: TimeOfDaySchema.optional(),
    weekday: z.int().min(1).max(7).optional(),
    dayOfMonth: z.int().min(1).max(28).optional(),
    countryIds: CountryIdsSchema,
    keepVersions: z.int().min(1).max(10).optional(),
    onlyIfChanged: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Request body for creating an interval. */
export type IntervalCreateBody = z.infer<typeof IntervalCreateBodySchema>;

/** Partial update contract. Cross-field consistency is checked against the locked stored schedule in the route. */
export const IntervalUpdateBodySchema = z
  .object({
    name: IntervalNameSchema.optional(),
    frequency: z.enum(INTERVAL_FREQUENCIES).optional(),
    timeOfDay: TimeOfDaySchema.optional(),
    weekday: z.int().min(1).max(7).optional(),
    dayOfMonth: z.int().min(1).max(28).optional(),
    countryIds: CountryIdsSchema.optional(),
    keepVersions: z.int().min(1).max(10).optional(),
    onlyIfChanged: z.boolean().optional(),
    enabled: z.boolean().optional(),
    /** Required to pause an interval while a run is active (`10-laws.md` L10). */
    confirm: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'confirm'), {
    message: 'At least one interval field must be supplied.',
  });

/** Request body for partially updating an interval. */
export type IntervalUpdateBody = z.infer<typeof IntervalUpdateBodySchema>;

/** Query contract for force-deleting an interval with an active run. */
export const IntervalDeleteQuerySchema = z
  .object({ force: z.enum(['true', 'false']).optional() })
  .strict();

/** Country identity attached to an interval response. */
export const IntervalCountrySchema = z
  .object({ countryId: z.uuid(), name: z.string().min(1), slug: z.string().min(1) })
  .strict();

/** Most recent durable run summary included in the interval list. */
export const IntervalLastRunSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['running', 'succeeded', 'partial', 'failed']),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .strict();

/** Serialized interval schedule with its memberships, UTC timing, and most recent run summary. */
export const IntervalViewSchema = z
  .object({
    id: z.uuid(),
    name: IntervalNameSchema,
    frequency: z.enum(INTERVAL_FREQUENCIES),
    timeOfDay: TimeOfDaySchema,
    weekday: z.int().min(1).max(7).nullable(),
    dayOfMonth: z.int().min(1).max(28).nullable(),
    countries: z.array(IntervalCountrySchema),
    keepVersions: z.int().min(1).max(10),
    onlyIfChanged: z.boolean(),
    enabled: z.boolean(),
    nextRunAt: z.iso.datetime(),
    lastRun: IntervalLastRunSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

/** Serialized interval schedule. */
export type IntervalView = z.infer<typeof IntervalViewSchema>;

/** Successful `GET /_admin/api/intervals` response. */
export const IntervalListResponseSchema = z.object({ data: z.array(IntervalViewSchema) }).strict();

/** Successful interval list response. */
export type IntervalListResponse = z.infer<typeof IntervalListResponseSchema>;

/** Successful create or update response. */
export const IntervalMutationResponseSchema = z.object({ interval: IntervalViewSchema }).strict();

/** Successful create or update response. */
export type IntervalMutationResponse = z.infer<typeof IntervalMutationResponseSchema>;

/** Request contract for force-deleting an interval. */
export type IntervalDeleteQuery = z.infer<typeof IntervalDeleteQuerySchema>;
