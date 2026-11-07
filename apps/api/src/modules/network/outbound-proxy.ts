/**
 * Process-wide outbound HTTP transport, switched atomically by the admin proxy setting (`P6-OPS-04`).
 *
 * Every external Geofabrik request is injected with this transport, including worker downloads. A transport snapshot is
 * captured per request so changing or removing the proxy does not redirect an already-started request mid-flight.
 *
 * @module modules/network/outbound-proxy
 */

import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent } from 'undici/index.js';
import { ProxyEndpointSchema } from '@mapirror/shared';

declare module 'fastify' {
  interface FastifyInstance {
    outboundProxy: OutboundProxy;
  }
}

/** Fetch shape used by the Geofabrik adapters and streamed download worker. */
export type OutboundFetch = (input: URL, init?: RequestInit) => Promise<Response>;

/** One prepared dispatcher and its matching endpoint, not yet necessarily installed as the process transport. */
export interface OutboundTransport {
  /** Canonical endpoint, or null for direct connections. */
  readonly endpoint: string | null;
  /** HTTP client for source requests. */
  readonly fetch: OutboundFetch;
  /** Gracefully drains and closes this transport's sockets. */
  close(): Promise<void>;
}

/** Creates a direct or proxied Undici transport after validating the endpoint. */
export function createOutboundTransport(endpoint: string | null): OutboundTransport {
  const canonicalEndpoint = endpoint === null ? null : ProxyEndpointSchema.parse(endpoint);
  const dispatcher =
    canonicalEndpoint === null
      ? null
      : canonicalEndpoint.startsWith('socks5:')
        ? new Socks5ProxyAgent(canonicalEndpoint)
        : new ProxyAgent(canonicalEndpoint);
  let closed = false;

  return {
    endpoint: canonicalEndpoint,
    fetch(input, init) {
      if (closed) return Promise.reject(new Error('outbound HTTP transport is closed'));
      const requestInit = dispatcher === null ? init : { ...init, dispatcher };
      return undiciFetch(
        input,
        requestInit as Parameters<typeof undiciFetch>[1],
      ) as Promise<Response>;
    },
    async close() {
      if (closed) return;
      closed = true;
      await dispatcher?.close();
    },
  };
}

/** One per API process; shares live changes with HTTP routes and background workers. */
export class OutboundProxy {
  #transport = createOutboundTransport(null);
  #changeQueue: Promise<void> = Promise.resolve();

  /** The configured endpoint, without credentials; null means direct egress. */
  get endpoint(): string | null {
    return this.#transport.endpoint;
  }

  /** Stable function reference shared by sources and workers; it selects the current transport per request. */
  readonly fetch: OutboundFetch = (input, init) => this.#transport.fetch(input, init);

  /** Serializes the database write and matching runtime switch for concurrent apply/remove operations. */
  async serializeChange<T>(change: () => Promise<T>): Promise<T> {
    const previous = this.#changeQueue;
    let release!: () => void;
    this.#changeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await change();
    } finally {
      release();
    }
  }

  /** Makes a prepared transport active, then drains the old one without interrupting in-flight requests. */
  activate(next: OutboundTransport): void {
    const previous = this.#transport;
    this.#transport = next;
    void previous.close().catch(() => undefined);
  }

  /** Switches to direct egress, closing the previous proxy after its in-flight requests finish. */
  remove(): void {
    this.activate(createOutboundTransport(null));
  }

  /** Drains the active dispatcher when the API process closes. */
  close(): Promise<void> {
    return this.#transport.close();
  }
}
