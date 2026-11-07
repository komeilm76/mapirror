import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createGeofabrikMapSource } from '../src/modules/geofabrik/map-source';
import { createOutboundTransport, OutboundProxy } from '../src/modules/network/outbound-proxy';

const servers: Server[] = [];
const proxies: OutboundProxy[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe('shared outbound proxy transport', () => {
  it('constructs and closes HTTP, HTTPS, and SOCKS5 dispatchers', async () => {
    for (const endpoint of [
      'http://proxy.example.test:3128',
      'https://proxy.example.test:3128',
      'socks5://proxy.example.test:1080',
    ]) {
      const transport = createOutboundTransport(endpoint);
      expect(transport.endpoint).toBe(endpoint);
      await expect(transport.close()).resolves.toBeUndefined();
    }
  });

  it('routes server-side requests through the active proxy and uses direct egress after removal', async () => {
    const seenByProxy: string[] = [];
    const proxyUrl = await listen(
      createServer((request, response) => {
        seenByProxy.push(request.url ?? '');
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('through proxy');
      }),
    );
    const directTargetUrl = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('direct');
      }),
    );
    const outbound = new OutboundProxy();
    proxies.push(outbound);
    outbound.activate(createOutboundTransport(proxyUrl));

    const proxied = await outbound.fetch(new URL(`${directTargetUrl}/geofabrik/resource`));
    expect(proxied.status).toBe(200);
    await expect(proxied.text()).resolves.toBe('through proxy');
    expect(seenByProxy).toEqual([`${directTargetUrl}/geofabrik/resource`]);
    expect(outbound.endpoint).toBe(proxyUrl);

    outbound.remove();
    const direct = await outbound.fetch(new URL(`${directTargetUrl}/geofabrik/resource`));
    expect(direct.status).toBe(200);
    await expect(direct.text()).resolves.toBe('direct');
    expect(seenByProxy).toHaveLength(1);
    expect(outbound.endpoint).toBeNull();
  });

  it('routes an actual Geofabrik catalog-client request through the same active transport', async () => {
    const requests: string[] = [];
    const proxyUrl = await listen(
      createServer((request, response) => {
        requests.push(request.url ?? '');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'FeatureCollection', features: [] }));
      }),
    );
    const outbound = new OutboundProxy();
    proxies.push(outbound);
    outbound.activate(createOutboundTransport(proxyUrl));

    const source = createGeofabrikMapSource('http://geofabrik.example.test', {
      fetchImpl: outbound.fetch,
    });
    await expect(source.listRegions()).resolves.toEqual([]);
    expect(requests).toEqual(['http://geofabrik.example.test/index-v1-nogeom.json']);
  });

  it('serializes matching persistence/runtime updates in invocation order', async () => {
    const outbound = new OutboundProxy();
    proxies.push(outbound);
    const order: string[] = [];
    await Promise.all([
      outbound.serializeChange(async () => {
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('first-end');
      }),
      outbound.serializeChange(() => {
        order.push('second-start');
        order.push('second-end');
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });
});
