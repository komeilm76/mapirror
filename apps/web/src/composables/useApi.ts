/**
 * `useApi()` — the client a screen talks through (`P1-WEB-04`).
 *
 * A thin `inject`, on purpose. The interesting decisions live where they are testable without a component:
 * `api/client.ts` decides when a credential is attached and turns every failure into an `ApiError`, and `api/index.ts`
 * decides what a dead session does. This function is the one line that connects a component to both, and the one place
 * where "there is no client" is turned into a sentence someone can act on.
 *
 * It does **not** return a wrapper object with `loading`/`error` refs. Those are per-call state — two requests in one
 * component would overwrite each other's flags — and `P5-UX-01` covers loading and empty states screen by screen. A
 * store that owns a piece of data (`P1-WEB-05` onwards) keeps its own `pending`/`error` refs beside it.
 *
 * @module composables/useApi
 */

import { inject } from 'vue';

import { API_CLIENT_KEY } from '@/api';
import type { ApiClient } from '@/api/client';

/** What `useApi()` says when the app was built without a client. Named so the test can assert on it. */
export const MISSING_CLIENT_MESSAGE =
  'useApi() found no API client: call provideApiClient() in bootstrap.ts (see apps/web/src/api/index.ts).';

/**
 * The API client of the app this component was mounted in.
 *
 * @returns The client.
 * @throws {Error} When there is none — the app was assembled by hand, or a component was mounted outside it. A silent
 * `undefined` would surface as a screen that renders nothing and logs nothing, which is the failure to avoid.
 */
export function useApi(): ApiClient {
  // No default argument, and the check is `undefined`: Vue returns `undefined` both when the key was never provided and
  // when `inject()` is called outside a component's setup. An earlier version passed `null` as the default and tested
  // for `null` — which is wrong on both counts, and returned `undefined` to the caller, i.e. exactly the silent failure
  // this function exists to prevent (found by `tests/use-api.spec.ts`).
  const client = inject(API_CLIENT_KEY);
  if (client === undefined) throw new Error(MISSING_CLIENT_MESSAGE);
  return client;
}
