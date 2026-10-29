/** Shared privacy-safe recording for public and administrator map streams.
 *
 * @module modules/download-events
 */

import { createHash, randomBytes } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import type { AppConfig } from '../config/env';
import type { Database } from '../db/schema';
import { normaliseIp } from '../lib/client-ip';

/** The channel recorded for a successful or interrupted response-body transfer. */
export type DownloadEventChannel = 'admin' | 'public';

/** Loads the configured IP salt or creates the persisted default on the first recorded transfer. */
async function downloadIpHashSalt(
  connection: Kysely<Database>,
  config: AppConfig,
): Promise<string> {
  if (config.ipHashSalt !== undefined) return config.ipHashSalt;

  const readSalt = async (): Promise<string | null> => {
    const setting = await connection
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'privacy.ipHashSalt')
      .executeTakeFirst();
    return typeof setting?.value === 'string' && setting.value.length > 0 ? setting.value : null;
  };

  const existing = await readSalt();
  if (existing !== null) return existing;

  const generatedSalt = randomBytes(32).toString('hex');
  await connection
    .insertInto('settings')
    .values({ key: 'privacy.ipHashSalt', value: JSON.stringify(generatedSalt) })
    .onConflict((conflict) => conflict.column('key').doNothing())
    .execute();
  const persisted = await readSalt();
  if (persisted === null) throw new Error('the persisted download IP hash salt is invalid');
  return persisted;
}

/**
 * Records only a salted hash of a normalized client IP (or null for invalid/missing IPs). Errors are logged and
 * deliberately do not turn a completed stream into a failed HTTP response.
 */
export async function recordDownloadEvent(
  connection: Kysely<Database>,
  config: AppConfig,
  request: FastifyRequest,
  options: {
    readonly countryId: string;
    readonly versionId: string;
    readonly bytesSent: bigint;
    readonly channel: DownloadEventChannel;
  },
): Promise<void> {
  const { countryId, versionId, bytesSent, channel } = options;
  try {
    const ip = normaliseIp(request.ip ?? request.raw.socket.remoteAddress);
    const salt = await downloadIpHashSalt(connection, config);
    const ipHash =
      ip === null ? null : createHash('sha256').update(`${ip}${salt}`, 'utf8').digest('hex');
    const userAgent = request.headers['user-agent'];
    await connection
      .insertInto('download_events')
      .values({
        country_id: countryId,
        version_id: versionId,
        channel,
        bytes_sent: bytesSent,
        ip_hash: ipHash,
        user_agent: typeof userAgent === 'string' ? userAgent : null,
      })
      .execute();
  } catch (error) {
    request.log.warn(
      { err: error, countryId, versionId, bytesSent: bytesSent.toString(), channel },
      'could not record map download event',
    );
  }
}
