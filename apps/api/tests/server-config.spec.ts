import { afterEach, describe, expect, it } from 'vitest';

import { readPort } from '../src/server';

/**
 * `readPort` is the only place where a string from outside the process becomes a number that reaches
 * `listen`. The socket and signal path of `server.ts` is covered by a real-process probe (start → curl →
 * SIGTERM → exit 0) rather than here: a unit test that listens on a port can fail for reasons unrelated to
 * the code. Importing `server.ts` is safe (its signal handlers live inside `start()`, and the module only
 * auto-starts under `import.meta.main`), but starting it is not something a unit test should do.
 */
describe('readPort', () => {
  const original = process.env.PORT;

  afterEach(() => {
    if (original === undefined) delete process.env.PORT;
    else process.env.PORT = original;
  });

  it('defaults to 3000 when PORT is absent — the value in .env.example', () => {
    delete process.env.PORT;
    expect(readPort()).toBe(3000);
  });

  it('reads a valid port', () => {
    process.env.PORT = '8080';
    expect(readPort()).toBe(8080);
    process.env.PORT = '1';
    expect(readPort()).toBe(1);
    process.env.PORT = '65535';
    expect(readPort()).toBe(65535);
  });

  it.each(['0', '65536', '-1', 'abc', '', '30 00', '3000.5', '0x10'])(
    'falls back to the default for an unusable value (%s)',
    (value) => {
      process.env.PORT = value;
      expect(readPort()).toBe(3000);
    },
  );
});
