import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AdminProfileSchema,
  LOGIN_PASSWORD_MAX,
  LOGIN_PASSWORD_MIN,
  LOGIN_USERNAME_MAX,
  LOGIN_USERNAME_MIN,
  LoginResponseSchema,
} from '@mapirror/shared';
import { describe, expect, it } from 'vitest';

/**
 * The login contract's *prose* half.
 *
 * `packages/shared/tests/auth.spec.ts` checks the schemas; this file checks that they still agree with `04-api.md`,
 * which is the document clients read. The numbers are quoted in that document ("username 1–64 chars, password 1–256
 * chars") and prose drifts silently — a schema change that is not mirrored there would fail here instead of being
 * discovered by a client that sends exactly the wrong length.
 *
 * It lives in the API suite because `packages/shared` declares `types: []`: a `node:fs` import there is a compile
 * error by design, since the package is bundled for the browser.
 */

/** Reads a document from this repository's `docs` directory. */
function readDoc(name: string): string {
  return readFileSync(resolve(import.meta.dirname, '../../../docs', name), 'utf8');
}

describe('the login contract matches 04-api.md', () => {
  const doc = readDoc('04-api.md');

  it('documents the body bounds the schema enforces', () => {
    const sentence = /username (\d+)–(\d+) chars, password (\d+)–(\d+) chars/u.exec(doc);

    expect(sentence, '04-api.md must state the login body bounds').not.toBeNull();
    expect(Number(sentence?.[1])).toBe(LOGIN_USERNAME_MIN);
    expect(Number(sentence?.[2])).toBe(LOGIN_USERNAME_MAX);
    expect(Number(sentence?.[3])).toBe(LOGIN_PASSWORD_MIN);
    expect(Number(sentence?.[4])).toBe(LOGIN_PASSWORD_MAX);
  });

  it('documents the response envelope the schema describes', () => {
    const section = doc.slice(doc.indexOf('### `POST /_auth/api/login`'));
    expect(section, 'the login section must exist').not.toBe('');

    for (const field of ['"token"', '"expiresAt"', '"admin"']) {
      expect(section, field).toContain(field);
    }
    // The envelope is exactly these fields: a document that still promises `admin.id` and `admin.username` matches a
    // schema that has no room for a third.
    expect(Object.keys(LoginResponseSchema.shape).sort()).toEqual(['admin', 'expiresAt', 'token']);
    expect(Object.keys(AdminProfileSchema.shape).sort()).toEqual(['id', 'username']);
  });

  it('documents the rate-limit answer, including the header the route sets', () => {
    const section = doc.slice(doc.indexOf('### `POST /_auth/api/login`'));
    expect(section).toContain('429');
    expect(section).toMatch(/Retry-After/u);
    expect(section).toContain('retryAfterSeconds');
  });

  it('documents that the answer is never cached', () => {
    // A token in a shared cache is a session handed to the next caller; the route sets `no-store` and the document
    // says so. If either half loses that, this fails.
    const section = doc.slice(doc.indexOf('### `POST /_auth/api/login`'));
    expect(section).toMatch(/no-store/u);
  });

  it('no longer lists login in the stub table', () => {
    // `04-api.md` §0.3 enumerates the routes that still answer `503 NOT_READY`. Login graduated in `P1-AUTH-03`; the row
    // promising otherwise was the thing that had to change alongside the code. The prose in that section may (and does)
    // mention login, to explain that it left the table — so this looks at the table rows only.
    const section = doc.slice(doc.indexOf('### 0.3 Bootstrap state'), doc.indexOf('## 0.2'));
    expect(section, '§0.3 must exist').toContain('| Route |');

    const rows = section.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows.length, 'the stub table must still have its rows').toBe(2);
    for (const row of rows) expect(row).not.toContain('_auth');
  });
});
