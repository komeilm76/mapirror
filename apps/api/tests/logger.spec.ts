import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  describeError,
  LOG_REDACT_PATHS,
  REDACT_CENSOR,
  REDACTED_HEADERS,
  REDACTED_KEYS,
  scrubSecrets,
  withRedaction,
} from '../src/index';
import { buildTestApp } from './helpers/test-app';

/**
 * L9 says redaction happens "at the logger level, not per call site", so these tests never configure
 * redaction themselves — they build the app the way `server.ts` does, capture what it actually writes, and
 * assert the secrets are absent. A test that inspected the options object would pass while the output leaked.
 */

/** A writable that collects log output as text. */
function captureLines(): {
  stream: Writable;
  lines: () => Record<string, unknown>[];
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    stream,
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('the logger redacts credentials at the logger level', () => {
  it('never writes a request-shaped record carrying headers', async () => {
    // Fastify's default serializer logs `req: { method, url, host, remoteAddress }` — no headers — so a plain
    // injected request would prove nothing here. The shape a handler actually logs when it dumps context is
    // the one that matters. Not nested under `req`/`res`: Fastify registers serializers for those keys, and a
    // hand-built object there is emptied by the request serializer before redaction ever runs.
    const captured = captureLines();
    const instance = await buildTestApp({ logger: { level: 'info', stream: captured.stream } });

    instance.log.info(
      {
        request: {
          headers: {
            authorization: 'Bearer mm_SUPERSECRETTOKEN',
            cookie: 'session=SUPERSECRETCOOKIE',
          },
        },
        response: { headers: { 'set-cookie': 'session=SUPERSECRETSETCOOKIE' } },
      },
      'request dumped',
    );
    await instance.close();

    const output = captured.text();
    expect(output).not.toContain('mm_SUPERSECRETTOKEN');
    expect(output).not.toContain('SUPERSECRETCOOKIE');
    expect(output).not.toContain('SUPERSECRETSETCOOKIE');
    // Redacted, not dropped: a reader must still see that a credential was present.
    expect(output).toContain(REDACT_CENSOR);
  });

  it('logs a real request without ever including its credentials', async () => {
    // The end-to-end half: whatever Fastify chooses to serialize today, a request carrying an Authorization
    // header and a cookie must not put them in the log stream. If a future serializer starts including headers,
    // this is the test that keeps redaction honest — the one above proves the paths work.
    const captured = captureLines();
    const instance = await buildTestApp({ logger: { level: 'info', stream: captured.stream } });

    await instance.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: 'Bearer mm_INJECTED_TOKEN', cookie: 'session=INJECTED_COOKIE' },
    });
    await instance.close();

    expect(captured.text()).not.toContain('mm_INJECTED_TOKEN');
    expect(captured.text()).not.toContain('INJECTED_COOKIE');
    expect(captured.lines().some((line) => line.msg === 'incoming request')).toBe(true);
  });

  it('never writes a password logged from a call site, one or two levels deep', async () => {
    const captured = captureLines();
    const instance = await buildTestApp({ logger: { level: 'info', stream: captured.stream } });

    // The point of the law: these call sites do not know about redaction, and must not have to.
    instance.log.info(
      { body: { username: 'admin', password: 'PLAINTEXT_PASSWORD_1' } },
      'login attempt',
    );
    instance.log.info({ data: { user: { token: 'PLAINTEXT_TOKEN_2' } } }, 'token issued');
    instance.log.info({ authorization: 'Bearer PLAINTEXT_BEARER_3' }, 'outbound call');
    await instance.close();

    const output = captured.text();
    expect(output).not.toContain('PLAINTEXT_PASSWORD_1');
    expect(output).not.toContain('PLAINTEXT_TOKEN_2');
    expect(output).not.toContain('PLAINTEXT_BEARER_3');
    // The harmless sibling field survives, so the record is still useful for diagnosis.
    expect(output).toContain('admin');
  });

  it('keeps unrelated fields intact', async () => {
    const captured = captureLines();
    const instance = await buildTestApp({ logger: { level: 'info', stream: captured.stream } });

    instance.log.info(
      {
        request: {
          headers: { authorization: 'Bearer nope', 'x-correlation-key': 'keep-me-visible' },
        },
      },
      'request dumped',
    );
    await instance.close();

    // Redaction is targeted: the same headers object still shows everything harmless.
    expect(captured.text()).toContain('keep-me-visible');
  });

  it('censors at every depth the law names', () => {
    for (const key of REDACTED_KEYS) {
      expect(LOG_REDACT_PATHS, key).toContain(key);
      expect(LOG_REDACT_PATHS, key).toContain(`*.${key}`);
      expect(LOG_REDACT_PATHS, key).toContain(`*.*.${key}`);
    }
    // Header-shaped context, at the depths a handler nests it.
    for (const header of REDACTED_HEADERS) {
      expect(LOG_REDACT_PATHS, header).toContain(`*.headers.${header}`);
      expect(LOG_REDACT_PATHS, header).toContain(`*.*.headers.${header}`);
    }
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(LOG_REDACT_PATHS).toContain('res.headers.set-cookie');
  });
});

describe('withRedaction', () => {
  it('leaves logging disabled when it was disabled', () => {
    // The test suite and injected probes must stay quiet; adding redaction must not switch logging on.
    expect(withRedaction(false)).toBe(false);
    expect(withRedaction(undefined)).toBe(false);
  });

  it('turns a bare `true` into a redacting options object', () => {
    // `logger: true` is the one setting that would otherwise log with no redaction at all.
    const option = withRedaction(true);
    expect(option).toMatchObject({ redact: { censor: REDACT_CENSOR } });
    expect(JSON.stringify(option)).toContain('req.headers.authorization');
  });

  it('keeps redaction paths a caller already configured', () => {
    const merged = withRedaction({ level: 'debug', redact: ['custom.secret'] });
    const json = JSON.stringify(merged);

    expect(json).toContain('custom.secret');
    expect(json).toContain('req.headers.authorization');
    expect(json).toContain('"level":"debug"');
  });

  it('accepts the object form of redaction from a caller', () => {
    const merged = withRedaction({ redact: { paths: ['a.b'], censor: 'X' } });
    // The caller's censor is replaced on purpose: two censors in one log stream is a reading hazard.
    expect(merged).toMatchObject({ redact: { censor: REDACT_CENSOR } });
    expect(JSON.stringify(merged)).toContain('a.b');
  });
});

describe('free text is scrubbed, because field redaction cannot see inside a message', () => {
  it('masks the password in a DSN embedded in a message', () => {
    // The measured case: an exception whose text is `connect ECONNREFUSED postgres://user:hunter2@db/x`.
    expect(scrubSecrets('connect ECONNREFUSED postgres://user:hunter2@db:5432/app')).toBe(
      'connect ECONNREFUSED postgres://user:***@db:5432/app',
    );
  });

  it('masks credentials written as key=value', () => {
    expect(scrubSecrets('GET /x?password=hunter2&page=2')).toBe('GET /x?password=***&page=2');
    expect(scrubSecrets('token=abc123 secret:')).toContain('token=***');
    expect(scrubSecrets('api_key=abcdef')).toContain('api_key=***');
  });

  it('masks a bearer token quoted in a message', () => {
    expect(scrubSecrets('sent Authorization: Bearer mm_abcdefghijklmnop')).toBe(
      'sent Authorization: Bearer ***',
    );
  });

  it('leaves ordinary text alone', () => {
    const text = 'Version 260101 already exists for country finland (page 2 of 3).';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('scrubs both the message and the stack of a real exception', () => {
    const error = new Error('failed: postgres://user:hunter2@db:5432/app unreachable');
    const loggable = describeError(error);

    expect(loggable.type).toBe('Error');
    expect(loggable.message).not.toContain('hunter2');
    expect(loggable.stack).toContain('failed');
    expect(JSON.stringify(loggable)).not.toContain('hunter2');
  });

  it('keeps a thrown non-error readable', () => {
    // `throw 'oops'` is legal; losing it entirely would leave an empty log line.
    expect(describeError('oops')).toEqual({ type: 'Thrown', message: 'oops', stack: '' });
    expect(describeError({ password: 'x' }).type).toBe('Thrown');
  });
});

describe('the err serializer is installed by the logger, for every call site', () => {
  it('scrubs a password inside an exception message logged the ordinary way', async () => {
    // `log.error({ err })` is how every call site logs a caught exception — including `server.ts`'s shutdown
    // path, which is why the scrubbing belongs to the serializer rather than to one handler.
    const captured = captureLines();
    const instance = await buildTestApp({ logger: { level: 'info', stream: captured.stream } });

    instance.log.error(
      { err: new Error('connect ECONNREFUSED postgres://user:hunter2@db:5432/app') },
      'failed',
    );
    await instance.close();

    const output = captured.text();
    expect(output).not.toContain('hunter2');
    expect(output).toContain('postgres://user:***@db:5432/app');
    // The error's own name survives, which Fastify's default serializer loses for a pre-shaped object.
    expect(output).toContain('"type":"Error"');
  });

  it('keeps a caller’s other serializers and still owns err', () => {
    const merged = withRedaction({
      serializers: { req: (value: unknown) => ({ custom: 'kept', value }) },
    });
    // Functions do not survive JSON.stringify, so the shape is inspected rather than serialised.
    const serializers = (merged as { serializers?: Record<string, unknown> }).serializers ?? {};

    expect(Object.keys(serializers).sort()).toEqual(['err', 'req']);
    expect(typeof serializers.err).toBe('function');
  });
});
