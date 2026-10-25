import { describe, expect, it } from 'vitest';

import { BEARER_SCHEME, readBearerToken, requireBearerToken } from '../src/modules/auth/session';
import { AppError } from '../src/lib/errors';

/**
 * `readBearerToken` — the header parser behind `/me`, `/logout` and (from `P1-AUTH-05`) every `/_admin/api/*` request.
 *
 * A table rather than prose, because every row here is a header a real client or proxy sends and because the failure
 * mode of a lenient parser is invisible: `Bearer  token` (two spaces) resolving to `''` answers `401` for a perfectly
 * good credential, and `Basic` being accepted as a scheme is the sort of thing nobody notices until an audit.
 */

const TOKEN = `mm_${'A'.repeat(43)}`;

describe('readBearerToken', () => {
  it('reads the credential out of the forms clients actually send', () => {
    for (const [header, expected] of [
      [`Bearer ${TOKEN}`, TOKEN],
      // The scheme is case-insensitive (RFC 9110 §11.6.2), so a client that sends `bearer` is not wrong.
      [`bearer ${TOKEN}`, TOKEN],
      [`BEARER ${TOKEN}`, TOKEN],
      [`BeArEr ${TOKEN}`, TOKEN],
      // Optional whitespace around the credential is allowed, in any amount and of any kind.
      [`Bearer  ${TOKEN}`, TOKEN],
      [`Bearer\t${TOKEN}`, TOKEN],
      [`  Bearer ${TOKEN}  `, TOKEN],
    ] as const) {
      expect(readBearerToken(header), JSON.stringify(header)).toBe(expected);
    }
  });

  it('returns the credential verbatim, without normalising it', () => {
    // A token is a byte string. Lower-casing it, trimming its ends or slicing off the marker would all produce a
    // credential that hashes to something the database has never seen — i.e. a `401` for the right token.
    const mixed = 'mm_AbC-dEf_0123456789abcdefghijklmnopqrstuvwxyzAB';
    expect(readBearerToken(`Bearer ${mixed}`)).toBe(mixed);
    expect(readBearerToken(`Bearer ${mixed}`)).not.toBe(mixed.toLowerCase());
  });

  it('refuses every header that does not carry exactly one bearer credential', () => {
    for (const header of [
      undefined,
      '',
      '   ',
      'Bearer', // scheme, no credential
      'Bearer ', // scheme and whitespace
      'Basic dXNlcjpwYXNz', // another scheme entirely
      'Token abc',
      'Bearer a b', // two credentials: ambiguous, so refused rather than guessed
      'Bearer Bearer abc',
      `${TOKEN}`, // a bare credential with no scheme
      ' Bearer ', // whitespace only
    ]) {
      expect(readBearerToken(header), JSON.stringify(header)).toBeNull();
    }
  });

  it('does not validate the *shape* of the credential', () => {
    // Shape is `tokens.isTokenShaped`'s job, checked in `verifyToken` before any query. Duplicating it here would put
    // the format in two places, and the second copy is the one that goes stale.
    expect(readBearerToken('Bearer not-a-token')).toBe('not-a-token');
  });

  it('names the scheme it accepts', () => {
    expect(BEARER_SCHEME).toBe('bearer');
  });
});

describe('requireBearerToken', () => {
  it('hands back the credential when there is one', () => {
    expect(requireBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  it('throws the documented UNAUTHENTICATED error otherwise', () => {
    for (const header of [undefined, '', 'Basic abc', 'Bearer']) {
      try {
        requireBearerToken(header);
        throw new Error(`expected a throw for ${JSON.stringify(header)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('UNAUTHENTICATED');
        // The message is user-facing and says nothing about which half of the header was wrong.
        expect((error as AppError).message).toBe('Sign in to continue.');
      }
    }
  });
});
