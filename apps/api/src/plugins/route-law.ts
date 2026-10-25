/**
 * L1 at boot time (task `P1-API-01`).
 *
 * The law tests (`P1-API-08`) walk the route table after the fact. This makes the same rule a precondition
 * for serving at all: a route the API is not allowed to serve stops the boot with a message naming it, so a
 * mis-placed route cannot reach production and wait for a test someone may have skipped.
 *
 * **The hook collects; the caller enforces.** Throwing from an `onRoute` hook is not an option, and both
 * alternatives were measured against Fastify 5.12 + avvio 9.3:
 *
 * - `throw` inside the hook: `app.ready()` **never settles** — avvio's boot queue stalls, so `buildApp()`
 *   hangs. In a container that is a process that never starts and never exits (measured: `timeout 12` killed
 *   it, no output, no exit code).
 * - returning a rejected promise: `ready()` **resolves** and the illegal route is registered — the violation
 *   disappears silently.
 *
 * Collecting and asserting after the boot is the only variant that fails deterministically: every offending
 * route is reported in one message, and the process exits 1.
 *
 * @module plugins/route-law
 */

import { isApiPath, isProbePath } from '@mapirror/shared';
import type { FastifyInstance } from 'fastify';

/** The rule, in the words a developer sees when they break it. */
export const ROUTE_LAW_MESSAGE =
  'violates L1: the API may only serve /_auth/api/*, /_admin/api/*, /_public/api/*, /healthz and /readyz ' +
  '(see 04-api.md §0)';

/** Handle returned by {@link installRouteLawHook}. */
export interface RouteLawCheck {
  /** Offending routes, in registration order; empty when the route table is legal. */
  readonly violations: string[];
}

/**
 * Installs the `onRoute` hook that records routes outside the API namespaces.
 *
 * @param app - Instance to guard. The hook is global, so it covers every plugin registered afterwards.
 * @returns A handle whose `violations` fills as routes are registered.
 */
export function installRouteLawHook(app: FastifyInstance): RouteLawCheck {
  // Keyed by URL, because Fastify reports each HTTP method separately: registering one `GET` route fires the
  // hook twice (`GET` and the implicit `HEAD`), and a method array fires it once more. Reporting that as two
  // or three violations for one mistake is noise in the message an operator sees at boot.
  const offenders = new Map<string, string[]>();

  app.addHook('onRoute', (route: { url: string; method: string | string[] }) => {
    if (isApiPath(route.url) || isProbePath(route.url)) return;
    // `typeof`, not `Array.isArray`: narrowing a `string | string[]` with `Array.isArray` yields `any[]`,
    // which silently re-introduces `any` into the one check that must stay typed.
    const methods = typeof route.method === 'string' ? [route.method] : route.method;
    const known = offenders.get(route.url) ?? [];
    offenders.set(route.url, [...new Set([...known, ...methods])]);
  });

  return {
    get violations(): string[] {
      return [...offenders].map(
        ([url, methods]) => `Route ${methods.join(',')} ${url} ${ROUTE_LAW_MESSAGE}.`,
      );
    },
  };
}

/**
 * Throws if the route table broke the law.
 *
 * Called after the pipeline has booted, so the message can list every offending route at once instead of
 * failing on the first one and hiding the rest.
 *
 * @param violations - Collected by {@link installRouteLawHook}.
 * @throws When at least one route is outside the legal namespaces.
 */
export function assertRouteLaw(violations: readonly string[]): void {
  if (violations.length === 0) return;
  const heading =
    violations.length === 1
      ? 'One route violates the route law:'
      : `${violations.length} routes violate the route law:`;
  throw new Error(`${heading}\n  ${violations.join('\n  ')}`);
}
