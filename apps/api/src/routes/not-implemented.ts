/**
 * The bootstrap's machine-checked set of temporary route stubs.
 *
 * All currently implemented routes have graduated from their `503 NOT_READY` placeholders. Keep this explicit empty
 * set so the contract test detects any placeholder route that is accidentally reintroduced.
 *
 * @module routes/not-implemented
 */

/** Every stub route the bootstrap currently registers, with the task that replaces it. */
export const STUB_ROUTES = {} as const;
