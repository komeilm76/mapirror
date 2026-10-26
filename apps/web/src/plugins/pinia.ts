/**
 * The Pinia instance the SPA boots with (`P1-WEB-01`).
 *
 * A factory for the same reason as `plugins/vuetify.ts`: one store instance per mounted app, so a test that writes
 * to the auth store cannot decide the outcome of the next one. The stores themselves arrive with the screens that
 * need them — `notifications` in `P1-WEB-04`, `auth` in `P1-WEB-05`, the rest with their API tasks.
 *
 * @module plugins/pinia
 */

import { createPinia, type Pinia } from 'pinia';

/**
 * Builds a Pinia instance.
 *
 * @returns A fresh Pinia plugin, ready for `app.use(...)`.
 */
export function createAppPinia(): Pinia {
  return createPinia();
}
