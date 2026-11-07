/** Admin outbound-proxy configuration and diagnostics (`P6-OPS-04`).
 *
 * @module modules/admin/proxy-route
 */

import {
  ProxyApplyRequestSchema,
  ProxyApplyResponseSchema,
  ProxyConfigurationSchema,
  ProxyTestRequestSchema,
} from '@mapirror/shared';
import { sql } from 'kysely';
import type { FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env';
import { AUDIT_ACTIONS, insertAuditLog } from '../../db/repositories/audit-logs';
import { withTransaction } from '../../db/transaction';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';
import { createOutboundTransport, type OutboundProxy } from '../network/outbound-proxy';
import { checkGeofabrikProxy } from '../network/proxy-health';

/** One setting row; URL credentials are rejected by the shared endpoint contract. */
export const OUTBOUND_PROXY_SETTING_KEY = 'network.outboundProxy';

/** Safe current proxy status, never including credentials. */
export function getProxyConfiguration(proxy: OutboundProxy) {
  return ProxyConfigurationSchema.parse({
    configured: proxy.endpoint !== null,
    endpoint: proxy.endpoint,
  });
}

/** Tests the supplied endpoint or current routing without persisting or activating a draft. */
export async function testProxy(request: FastifyRequest, config: AppConfig, proxy: OutboundProxy) {
  const parsed = ProxyTestRequestSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw parsed.error;

  if (parsed.data.endpoint === undefined) {
    return proxy.serializeChange(() =>
      checkGeofabrikProxy({
        baseUrl: config.geofabrikBaseUrl,
        proxyEndpoint: proxy.endpoint,
        fetch: proxy.fetch,
      }),
    );
  }

  const transport = createOutboundTransport(parsed.data.endpoint);
  try {
    return await checkGeofabrikProxy({
      baseUrl: config.geofabrikBaseUrl,
      proxyEndpoint: transport.endpoint,
      fetch: transport.fetch,
    });
  } finally {
    await transport.close();
  }
}

/** Persists/activates the selected endpoint, then checks every source operation through that live transport. */
export async function applyProxy(request: FastifyRequest, config: AppConfig, proxy: OutboundProxy) {
  const parsed = ProxyApplyRequestSchema.safeParse(request.body);
  if (!parsed.success) throw parsed.error;
  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const transport = createOutboundTransport(parsed.data.endpoint);
  let activated = false;
  try {
    return await proxy.serializeChange(async () => {
      await withTransaction(request.server.db.db, async (trx) => {
        await trx
          .insertInto('settings')
          .values({
            key: OUTBOUND_PROXY_SETTING_KEY,
            value: JSON.stringify(transport.endpoint),
          })
          .onConflict((conflict) =>
            conflict.column('key').doUpdateSet({
              value: JSON.stringify(transport.endpoint),
              updated_at: sql<Date>`now()`,
            }),
          )
          .execute();

        await insertAuditLog(trx, {
          actorId: admin.id,
          actorName: admin.username,
          action: AUDIT_ACTIONS.settingsUpdate,
          targetType: 'settings',
          targetId: null,
          ip: normaliseIp(request.ip),
          metadata: { keys: [OUTBOUND_PROXY_SETTING_KEY] },
        });
      });

      proxy.activate(transport);
      activated = true;
      const health = await checkGeofabrikProxy({
        baseUrl: config.geofabrikBaseUrl,
        proxyEndpoint: transport.endpoint,
        fetch: transport.fetch,
      });
      return ProxyApplyResponseSchema.parse({
        applied: true,
        configuration: getProxyConfiguration(proxy),
        health,
      });
    });
  } catch (error) {
    if (!activated) await transport.close();
    throw error;
  }
}

/** Removes the persisted endpoint and immediately routes new external requests directly. */
export async function removeProxy(request: FastifyRequest, proxy: OutboundProxy) {
  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  return proxy.serializeChange(async () => {
    await withTransaction(request.server.db.db, async (trx) => {
      const existing = await trx
        .selectFrom('settings')
        .select('key')
        .where('key', '=', OUTBOUND_PROXY_SETTING_KEY)
        .executeTakeFirst();
      if (existing === undefined) return;

      await trx.deleteFrom('settings').where('key', '=', OUTBOUND_PROXY_SETTING_KEY).execute();
      await insertAuditLog(trx, {
        actorId: admin.id,
        actorName: admin.username,
        action: AUDIT_ACTIONS.settingsUpdate,
        targetType: 'settings',
        targetId: null,
        ip: normaliseIp(request.ip),
        metadata: { keys: [OUTBOUND_PROXY_SETTING_KEY], removed: true },
      });
    });

    proxy.remove();
    return ProxyConfigurationSchema.parse({ configured: false, endpoint: null });
  });
}
