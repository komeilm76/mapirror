/**
 * `/_auth/api/*` — authentication routes.
 *
 * Registered by {@link registerRoutes}. Today: one stub at the contract path, so the prefix and the
 * pipeline can be verified before the handlers exist. `P1-AUTH-03` replaces the handler and adds
 * `logout`/`me` (`P1-AUTH-04`); the path itself does not change.
 *
 * @module modules/auth/routes
 */

import type { FastifyPluginCallback } from 'fastify';

import { notImplemented } from '../../routes/not-implemented';

/** `/login`, `/logout`, `/me` land here. */
export const authRoutes: FastifyPluginCallback = (app) => {
  app.post('/login', notImplemented('POST /_auth/api/login'));
};
