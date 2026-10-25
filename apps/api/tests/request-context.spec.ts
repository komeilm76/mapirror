import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { buildApp, REQUEST_ID_HEADER, resolveRequestId } from '../src/index';

/**
 * The contract is one row of `04-api.md` §0.2 — "returned in `x-request-id`, echoed in every error" — plus
 * `09-development.md` §8, "follow a request: `x-request-id` in the response, same id in logs". Each of those
 * three places is a test here, because a correlation id that appears in only two of them cannot correlate
 * anything.
 */

/** A UUIDv4, the id format `04-api.md` promises. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Captures pino's output so the id in the logs can be compared with the id in the response. */
function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    }),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('x-request-id is returned on every response', () => {
  it('sets a UUIDv4 on a successful response', async () => {
    const instance = await buildApp();

    const response = await instance.inject({ method: 'GET', url: '/_public/api/countries' });
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_V4);
    await instance.close();
  });

  it('sets it on a 404 too, where there is no route to set it', async () => {
    // The not-found path is exactly when a user has nothing else to quote, so a missing header here would
    // make the header useless for the case it exists for.
    const instance = await buildApp();

    const response = await instance.inject({ method: 'GET', url: '/no-such-route' });
    expect(response.statusCode).toBe(404);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(UUID_V4);
    await instance.close();
  });

  it('gives every request its own id', async () => {
    const instance = await buildApp();

    const first = await instance.inject({ method: 'GET', url: '/_public/api/countries' });
    const second = await instance.inject({ method: 'GET', url: '/_public/api/countries' });
    expect(first.headers[REQUEST_ID_HEADER]).not.toBe(second.headers[REQUEST_ID_HEADER]);
    await instance.close();
  });

  it('uses the same id in the header and in the error envelope', async () => {
    const instance = await buildApp();

    const response = await instance.inject({ method: 'POST', url: '/_auth/api/login' });
    const body = response.json<{ error: { requestId: string } }>();

    expect(response.statusCode).toBe(503);
    expect(body.error.requestId).toBe(response.headers[REQUEST_ID_HEADER]);
    await instance.close();
  });

  it('uses the same id in the header and in the logs', async () => {
    const captured = capture();
    const instance = await buildApp({ logger: { level: 'info', stream: captured.stream } });

    const response = await instance.inject({ method: 'GET', url: '/_public/api/countries' });
    await instance.close();

    const id = response.headers[REQUEST_ID_HEADER];
    const requestLine = captured.lines().find((line) => line.msg === 'incoming request');
    expect(requestLine?.reqId).toBe(id);
  });
});

describe('an inbound x-request-id is repeated only when it is safe', () => {
  it('repeats a well-formed id so one identifier can span a proxy hop', async () => {
    const instance = await buildApp();

    const response = await instance.inject({
      method: 'GET',
      url: '/_public/api/countries',
      headers: { [REQUEST_ID_HEADER]: 'proxy-hop-000123' },
    });
    expect(response.headers[REQUEST_ID_HEADER]).toBe('proxy-hop-000123');
    await instance.close();
  });

  it.each([
    ['a newline (log injection)', 'abc12345\n{"level":50,"msg":"fake"}'],
    ['a space', 'not a valid id'],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['quotes and braces', 'abc12345"><script>'],
    ['a path', '../../etc/passwd'],
  ])('replaces an inbound id containing %s', async (_reason, value) => {
    const instance = await buildApp();

    const response = await instance.inject({
      method: 'GET',
      url: '/_public/api/countries',
      headers: { [REQUEST_ID_HEADER]: value },
    });

    const echoed = response.headers[REQUEST_ID_HEADER];
    expect(echoed).not.toBe(value);
    expect(echoed).toMatch(UUID_V4);
    await instance.close();
  });
});

describe('resolveRequestId', () => {
  it('generates a UUIDv4 when no id was supplied', () => {
    expect(resolveRequestId()).toMatch(UUID_V4);
    expect(resolveRequestId()).not.toBe(resolveRequestId());
  });

  it('takes the first value when the header was repeated', () => {
    // HTTP allows a header to arrive more than once; Fastify surfaces that as an array.
    expect(resolveRequestId(['first-id-1234', 'second-id-5678'])).toBe('first-id-1234');
    expect(resolveRequestId(['bad id', 'second-id-5678'])).toMatch(UUID_V4);
  });

  it.each(['abcdefgh', 'A-Z_a-z.0-9', 'x'.repeat(64)])('accepts the boundary %s', (value) => {
    expect(resolveRequestId(value)).toBe(value);
  });
});
