import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  installErrorHandlers,
  installRequestContext,
  parseEnv,
  type AppConfig,
  type PluginSlot,
} from '../src/index';
import { buildTestApp } from './helpers/test-app';

/**
 * `request.ip` decides two documented behaviours: the per-IP rate limits in `14-security.md` §7 and the hashed
 * download IPs. Behind the reverse proxy the deployment mandates, the socket address belongs to the proxy, so
 * without `trustProxy` every client shares one identity — one global rate-limit bucket, and identical hashes.
 *
 * **These tests use a real socket on purpose.** `app.inject()` does not go through Node's proxy-address
 * resolution: measured while writing this, `inject({ remoteAddress, headers: { 'x-forwarded-for': … } })`
 * reported the `remoteAddress` for every `trustProxy` setting, which would have made every test below pass
 * whatever the code did. A test that cannot fail is not a test.
 */

/** A config with a chosen `TRUST_PROXY` value. */
function configWithTrust(trustProxy: string | false): AppConfig {
  return { ...parseEnv({}), trustProxy };
}

/**
 * Starts an app on an ephemeral port, runs `probe`, then always closes it.
 *
 * @param trustProxy - Value to hand Fastify.
 * @param probe - Receives the base URL.
 */
async function withServer(
  trustProxy: string | false,
  probe: (app: FastifyInstance, baseUrl: string) => Promise<void>,
): Promise<void> {
  // The route goes through the pipeline seam, not `app.get` afterwards: a built app is frozen on purpose, and
  // the seam is what `buildApp` documents for exactly this.
  const slots: readonly PluginSlot[] = [
    { id: 'request-context', rationale: 'test', task: null, install: installRequestContext },
    { id: 'errors', rationale: 'test', task: null, install: installErrorHandlers },
    {
      id: 'routes',
      rationale: 'test',
      task: null,
      install: (app) => {
        app.get('/_public/api/whoami', (request) => ({ ip: request.ip, ips: request.ips }));
      },
    },
  ];

  const app = await buildTestApp({ config: configWithTrust(trustProxy), slots });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    await probe(app, address);
  } finally {
    await app.close();
  }
}

/**
 * Asks the server who it thinks the client is.
 *
 * @param baseUrl - Listening address.
 * @param forwardedFor - Value for `X-Forwarded-For`, when the test wants one.
 * @returns The reported address.
 */
async function whoami(baseUrl: string, forwardedFor?: string): Promise<string> {
  const response = await fetch(`${baseUrl}/_public/api/whoami`, {
    ...(forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } }),
  });
  const body = (await response.json()) as { ip: string };
  return body.ip;
}

describe('the client address behind the proxy', () => {
  it('is the proxy without trust — the defect this setting exists for', async () => {
    await withServer(false, async (_app, baseUrl) => {
      // The peer is 127.0.0.1 in this test, exactly as a same-host proxy is. Untrusted, `X-Forwarded-For` is
      // ignored and every client would be recorded as the proxy itself.
      expect(await whoami(baseUrl, '203.0.113.7')).toBe('127.0.0.1');
    });
  });

  it('is the forwarded client when the peer is trusted (the default)', async () => {
    await withServer('loopback', async (_app, baseUrl) => {
      expect(await whoami(baseUrl, '203.0.113.7')).toBe('203.0.113.7');
    });
  });

  it('ignores a spoofed hop prepended by the client', async () => {
    // `nginx $proxy_add_x_forwarded_for` appends the real client to whatever the client sent. Trusting the
    // proxy must still identify the real client, not the value the client invented.
    await withServer('loopback', async (_app, baseUrl) => {
      expect(await whoami(baseUrl, '1.2.3.4, 203.0.113.7')).toBe('203.0.113.7');
    });
  });

  it('is the socket address when the peer is outside the trusted ranges', async () => {
    // A container subnet that does not include this test's loopback peer: the header must be ignored, because a
    // direct client is not a proxy just for saying so.
    await withServer('172.16.0.0/12', async (_app, baseUrl) => {
      expect(await whoami(baseUrl, '203.0.113.7')).toBe('127.0.0.1');
    });
  });

  it('defaults to trusting loopback, which is what the documented proxy needs', () => {
    // The documented deployment is a same-host Caddy/Nginx proxying to 127.0.0.1 (`12-deployment.md` §3).
    expect(parseEnv({}).trustProxy).toBe('loopback');
  });
});

describe('parseEnv TRUST_PROXY', () => {
  it('accepts the presets Fastify knows', () => {
    for (const preset of ['loopback', 'linklocal', 'uniquelocal']) {
      expect(parseEnv({ TRUST_PROXY: preset }).trustProxy, preset).toBe(preset);
    }
  });

  it('accepts addresses, CIDR blocks and a comma-separated list', () => {
    expect(parseEnv({ TRUST_PROXY: '127.0.0.1' }).trustProxy).toBe('127.0.0.1');
    expect(parseEnv({ TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toBe('10.0.0.0/8');
    expect(parseEnv({ TRUST_PROXY: 'loopback, 172.16.0.0/12' }).trustProxy).toBe(
      'loopback,172.16.0.0/12',
    );
    expect(parseEnv({ TRUST_PROXY: 'fd00::/8' }).trustProxy).toBe('fd00::/8');
  });

  it('disables trust for `none` and `false`', () => {
    expect(parseEnv({ TRUST_PROXY: 'none' }).trustProxy).toBe(false);
    expect(parseEnv({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('refuses a hop count, because Fastify silently trusts nothing for one', () => {
    // The measured trap: `trustProxy: 1` returns a trust function that is always false — no error, no warning,
    // and the operator believes the proxy is configured. Refusing it is the only way the mistake is visible.
    expect(() => parseEnv({ TRUST_PROXY: '1' })).toThrow(/hop count is not supported/);
    expect(() => parseEnv({ TRUST_PROXY: '2' })).toThrow(/172\.16\.0\.0\/12/);
  });

  it('refuses `true` and `*`, which trust every peer', () => {
    expect(() => parseEnv({ TRUST_PROXY: 'true' })).toThrow(/every peer/);
    expect(() => parseEnv({ TRUST_PROXY: '*' })).toThrow(/every peer/);
  });

  it('refuses a malformed address or prefix', () => {
    for (const bad of ['not-an-ip', '10.0.0.0/33', '::1/129', '10.0.0.0/8/8']) {
      expect(() => parseEnv({ TRUST_PROXY: bad }), bad).toThrow(/expected an address/);
    }
  });
});
