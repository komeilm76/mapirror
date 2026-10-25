import { connect } from 'node:net';

import { ERROR_STATUS } from '@mapirror/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AppError,
  clientErrorHandler,
  installErrorHandlers,
  installRequestContext,
  INTERNAL_MESSAGE,
  toErrorEnvelope,
  type PluginSlot,
} from '../src/index';
import { buildTestApp } from './helpers/test-app';

/**
 * The task's gate is "every handler error maps to a documented code", so these tests cover three layers:
 *
 * 1. the pure mapping (`toErrorEnvelope`) for every code in the vocabulary;
 * 2. real HTTP failures a client can cause — malformed JSON, wrong media type, oversized body, unknown path;
 * 3. a deliberate `AppError` and an unexpected exception, injected through the *real* pipeline.
 *
 * The last layer uses the `slots` override so the errors stage is exercised exactly as `buildApp` installs it,
 * with test routes after it. A route that cannot be reached otherwise is the only way to prove that the stage
 * wraps handlers rather than merely existing.
 */

/** Routes the tests need, registered after the error stage in the same pipeline. */
function testRoutes(app: FastifyInstance): void {
  app.get('/_public/api/duplicate', () => {
    throw new AppError('VERSION_DUPLICATE', 'Version 260101 already exists for this country.', {
      version: '260101',
    });
  });

  app.get('/_public/api/boom', () => {
    throw new Error('connect ECONNREFUSED postgres://mapirror:hunter2@db:5432/mapirror');
  });

  app.post('/_public/api/validated', (request) => {
    // A handler that validates its body with Zod and lets the failure propagate — the shape every real
    // endpoint will have (L5).
    const body = z.object({ username: z.string().min(3) }).parse(request.body);
    return body;
  });
}

/**
 * The pipeline a test app uses: request ids (so the envelope's `requestId` has a header to match), the error
 * stage, then the test routes. Replacing the slots replaces the whole pipeline, which is exactly why the id
 * stage is listed here rather than assumed.
 */
const TEST_SLOTS: readonly PluginSlot[] = [
  { id: 'request-context', rationale: 'test', task: null, install: installRequestContext },
  { id: 'errors', rationale: 'test', task: null, install: installErrorHandlers },
  { id: 'routes', rationale: 'test', task: null, install: testRoutes },
];

/** Builds an app with the error stage and the test routes. */
const appWithTestRoutes = () => buildTestApp({ slots: TEST_SLOTS });

describe('toErrorEnvelope maps every documented code', () => {
  it('returns the documented status for all of them', () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      const mapped = toErrorEnvelope(new AppError(code as keyof typeof ERROR_STATUS, 'x'), 'req-1');

      expect(mapped.status, code).toBe(status);
      expect(mapped.body.error.code).toBe(code);
      expect(mapped.body.error.requestId).toBe('req-1');
    }
  });

  it('maps an unmapped Fastify 4xx to BAD_REQUEST and an unmapped 5xx to INTERNAL_ERROR', () => {
    // The rule for errors Fastify raises that this module has never seen: a 4xx is still the client's mistake,
    // a 5xx is ours. Encoding both sides keeps a future Fastify code from silently becoming a 500 for clients.
    const clientFault = Object.assign(new Error('teapot'), {
      code: 'FST_ERR_UNKNOWN',
      statusCode: 418,
    });
    const serverFault = Object.assign(new Error('upstream died'), {
      code: 'FST_ERR_UNKNOWN',
      statusCode: 503,
    });

    expect(toErrorEnvelope(clientFault, 'r').body.error.code).toBe('BAD_REQUEST');
    expect(toErrorEnvelope(serverFault, 'r').body.error.code).toBe('INTERNAL_ERROR');
    expect(toErrorEnvelope(clientFault, 'r').status).toBe(400);
  });

  it('keeps details when a handler supplied them and omits the key when it did not', () => {
    const withDetails = toErrorEnvelope(
      new AppError('DISK_FULL', 'Disk is full.', { freeBytes: 0 }),
      'r',
    );
    const withoutDetails = toErrorEnvelope(new AppError('DISK_FULL', 'Disk is full.'), 'r');

    expect(withDetails.body.error.details).toEqual({ freeBytes: 0 });
    expect(Object.hasOwn(withoutDetails.body.error, 'details')).toBe(false);
  });
});

describe('the error stage wraps a real pipeline', () => {
  it('sends an AppError as its documented code, status and details', async () => {
    const instance = await appWithTestRoutes();

    const response = await instance.inject({ method: 'GET', url: '/_public/api/duplicate' });
    const body = response.json<{ error: { code: string; details: { version: string } } }>();

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(body.error.code).toBe('VERSION_DUPLICATE');
    expect(body.error.details).toEqual({ version: '260101' });
    expect(response.headers['x-request-id']).toBe(
      response.json<{ error: { requestId: string } }>().error.requestId,
    );
    await instance.close();
  });

  it('turns an unexpected exception into INTERNAL_ERROR without describing it', async () => {
    const instance = await appWithTestRoutes();

    const response = await instance.inject({ method: 'GET', url: '/_public/api/boom' });
    const body = response.json<{ error: { code: string; message: string } }>();

    expect(response.statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(INTERNAL_MESSAGE);
    // The exception's text named the DSN and the password in it. None of that may reach the client.
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toContain('stack');
    await instance.close();
  });

  it('logs the exception for a 500 but not for a 4xx', async () => {
    // The counterpart to the test above: the detail has to live somewhere, and that somewhere is the log.
    const lines: string[] = [];
    const stream = {
      write(chunk: string) {
        lines.push(chunk);
        return true;
      },
    };
    const instance = await buildTestApp({ logger: { level: 'info', stream }, slots: TEST_SLOTS });

    await instance.inject({ method: 'GET', url: '/_public/api/boom' });
    await instance.inject({ method: 'GET', url: '/_public/api/duplicate' });
    await instance.close();

    const output = lines.join('');
    expect(output).toContain('request failed');
    expect(output).toContain('ECONNREFUSED');
    expect(output).toContain('request rejected');
    // …and the log must not become the leak the response was protected from: the exception's text carried a
    // DSN with a password in it.
    expect(output).not.toContain('hunter2');
  });

  it('turns a Zod failure into VALIDATION_ERROR with the failing field', async () => {
    const instance = await appWithTestRoutes();

    const response = await instance.inject({
      method: 'POST',
      url: '/_public/api/validated',
      payload: { username: 'ab' },
    });
    const body = response.json<{
      error: { code: string; details: { issues: { path: string }[] } };
    }>();

    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.issues[0]?.path).toBe('username');
    await instance.close();
  });

  it('answers an unknown path with the documented envelope, not Fastify’s default', async () => {
    const instance = await buildTestApp();

    const response = await instance.inject({ method: 'GET', url: '/no-such-route' });
    const body = response.json<{ error: { code: string; requestId: string } }>();

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
    // Fastify's default 404 says `{"message":"Route GET:/no-such-route not found","error":"Not Found"}`,
    // which is a second response shape and a route-table hint.
    expect(response.body).not.toContain('Route GET');
    await instance.close();
  });

  it('answers a wrong method with 404 — the contract has no 405', async () => {
    const instance = await buildTestApp();

    const response = await instance.inject({ method: 'DELETE', url: '/_public/api/countries' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    await instance.close();
  });

  it('keeps the 503 stubs working under the new handler', async () => {
    // The stubs throw nothing today, but they must not be shadowed by the 404 handler.
    const instance = await buildTestApp();

    const response = await instance.inject({ method: 'POST', url: '/_auth/api/login' });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_READY');
    await instance.close();
  });
});

describe('client-caused failures map to their documented codes', () => {
  /** A bare instance with the handler installed and a body limit small enough to exceed in a test. */
  async function handlerOnlyApp(bodyLimit = 1024) {
    const instance = Fastify({ logger: false, bodyLimit });
    installErrorHandlers(instance);
    instance.post('/_public/api/echo', (request) => ({ received: request.body }));
    await instance.ready();
    return instance;
  }

  it('maps malformed JSON to BAD_REQUEST', async () => {
    const instance = await handlerOnlyApp();

    const response = await instance.inject({
      method: 'POST',
      url: '/_public/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    await instance.close();
  });

  it('maps an empty JSON body to BAD_REQUEST', async () => {
    const instance = await handlerOnlyApp();

    const response = await instance.inject({
      method: 'POST',
      url: '/_public/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    await instance.close();
  });

  it('maps an unsupported media type to UNSUPPORTED_FORMAT', async () => {
    const instance = await handlerOnlyApp();

    const response = await instance.inject({
      method: 'POST',
      url: '/_public/api/echo',
      headers: { 'content-type': 'text/csv' },
      payload: 'a,b',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNSUPPORTED_FORMAT');
    await instance.close();
  });

  it('maps an oversized body to FILE_TOO_LARGE', async () => {
    const instance = await handlerOnlyApp(64);

    const response = await instance.inject({
      method: 'POST',
      url: '/_public/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: { a: 'x'.repeat(500) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('FILE_TOO_LARGE');
    await instance.close();
  });
});

describe('clientErrorHandler leaves an unwritable socket alone', () => {
  /** A socket double that records anything written to it. */
  function fakeSocket(overrides: { destroyed?: boolean; writable?: boolean } = {}) {
    const written: string[] = [];
    return {
      written,
      socket: {
        destroyed: overrides.destroyed ?? false,
        writable: overrides.writable ?? true,
        write: (chunk: string) => written.push(chunk),
        destroy: () => undefined,
      },
    };
  }

  /** The `this` the handler is bound to: only `log` is used. */
  const fakeApp = { log: { warn: () => undefined } };

  it.each([
    ['a reset connection', { code: 'ECONNRESET' }, {}],
    ['a destroyed socket', { code: 'HPE_INVALID_METHOD' }, { destroyed: true }],
    ['a read-only socket', { code: 'HPE_INVALID_METHOD' }, { writable: false }],
  ])('does not write to %s', (_label, errorOverrides, socketOverrides) => {
    // Writing to a destroyed socket throws from inside a Node event handler, where nothing catches it and the
    // process dies. The guard is one branch and it is the difference between a 400 and a crash.
    const { written, socket } = fakeSocket(socketOverrides);
    const error = Object.assign(new Error('boom'), errorOverrides);

    clientErrorHandler.call(fakeApp as never, error, socket as never);

    expect(written).toEqual([]);
  });
});

describe('a request that is not valid HTTP still gets the envelope', () => {
  /**
   * Writes raw bytes and collects the reply.
   *
   * A real socket is required: `inject()` builds a request object, so it cannot exercise the path where Node
   * gives up on the byte stream — which is the path this test exists for.
   *
   * @param port - Listening port.
   * @param payload - Bytes to write.
   * @returns The raw response text.
   */
  function rawRequest(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      const socket = connect(port, '127.0.0.1', () => socket.write(payload));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('close', () => resolve(chunks.join('')));
      socket.on('error', reject);
    });
  }

  it('answers a garbage request line with the documented envelope and a request id', async () => {
    const instance = await buildTestApp();
    const address = await instance.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(address).port);
    try {
      const raw = await rawRequest(port, 'GARBAGE\r\n\r\n');

      // Fastify's default here is `{"error":"Bad Request","message":"Client Error","statusCode":400}`.
      expect(raw).toContain('HTTP/1.1 400');
      const [head = '', body = ''] = raw.split('\r\n\r\n');
      const parsed = JSON.parse(body) as {
        error: { code: string; message: string; requestId: string };
      };

      expect(parsed.error.code).toBe('BAD_REQUEST');
      expect(parsed.error.message).toBe('The request could not be read.');
      expect(parsed.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
      // The id in the header is the id in the body, so the two can be matched.
      expect(head.toLowerCase()).toContain(`x-request-id: ${parsed.error.requestId}`);
      expect(head.toLowerCase()).toContain('x-content-type-options: nosniff');
      expect(head.toLowerCase()).toContain('connection: close');
    } finally {
      await instance.close();
    }
  }, 15_000);

  it('answers an oversized header the same way, and closes the connection', async () => {
    const instance = await buildTestApp();
    const address = await instance.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(address).port);
    try {
      const raw = await rawRequest(
        port,
        `GET /_public/api/countries HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`,
      );
      const body = raw.split('\r\n\r\n')[1] ?? '';
      expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    } finally {
      await instance.close();
    }
  }, 15_000);
});
