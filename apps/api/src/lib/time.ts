/** UTC recurrence calculation, re-exported here to preserve the API module boundary.
 *
 * The implementation lives in `@mapirror/shared` so the admin preview and scheduler use identical UTC arithmetic.
 *
 * @module lib/time
 */

export { nextRunAt } from '@mapirror/shared';
export type { IntervalSchedule } from '@mapirror/shared';
