import { describe, expect, it } from 'vitest';

import {
  ApiError,
  CLIENT_ERROR_CODES,
  errorFromFailure,
  errorFromResponse,
  isApiError,
  SESSION_ENDED_CODES,
  validationIssues,
} from '../src/api/errors';

/**
 * The error envelope, in and out (`P1-WEB-04`).
 *
 * `api/errors.ts` is the single place a failed response becomes something a screen can render, so these cases are the
 * contract in both directions: the documented envelope (`04-api.md` §0.2) is read faithfully, and everything that is
 * *not* the envelope still arrives as an `ApiError` rather than as a `SyntaxError` from three call sites deeper.
 */

/** Builds a response the way the API does. */
function envelopeResponse(
  body: unknown,
  init: { status?: number; requestId?: string } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 500,
    headers: init.requestId === undefined ? {} : { 'x-request-id': init.requestId },
  });
}

/** The documented error body. */
function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    error: {
      code: 'VERSION_DUPLICATE',
      message: 'Version 260101 already exists for this country.',
      details: { countryId: 'c0ffee', version: '260101' },
      requestId: '9f1c2d1e-4b7a-4c2f-9e3a-1a2b3c4d5e6f',
      ...overrides,
    },
  };
}

describe('reading the documented envelope', () => {
  it('keeps the code, the sentence, the details and the request id', async () => {
    const error = await errorFromResponse(envelopeResponse(envelope(), { status: 409 }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.code).toBe('VERSION_DUPLICATE');
    expect(error.status).toBe(409);
    expect(error.message).toBe('Version 260101 already exists for this country.');
    expect(error.details).toEqual({ countryId: 'c0ffee', version: '260101' });
    expect(error.requestId).toBe('9f1c2d1e-4b7a-4c2f-9e3a-1a2b3c4d5e6f');
  });

  it('takes the request id from the header when the body has none', async () => {
    // The two are always written together by the API, but a body produced by something else (a proxy rewriting the
    // error, a trimmed fixture) still leaves the header, and a support request quotes whatever we have.
    const error = await errorFromResponse(
      envelopeResponse(envelope({ requestId: undefined }), {
        status: 409,
        requestId: 'header-id-123',
      }),
    );

    expect(error.requestId).toBe('header-id-123');
  });

  it('prefers the body request id to the header', async () => {
    const error = await errorFromResponse(
      envelopeResponse(envelope(), { status: 409, requestId: 'header-id-123' }),
    );

    expect(error.requestId).toBe('9f1c2d1e-4b7a-4c2f-9e3a-1a2b3c4d5e6f');
  });

  it('has no request id when neither carries one', async () => {
    const error = await errorFromResponse(
      envelopeResponse(envelope({ requestId: undefined }), { status: 409 }),
    );

    expect(error.requestId).toBeNull();
  });
});

describe('when the answer is not the documented envelope', () => {
  it('maps a code from a newer server to UNKNOWN, and keeps its sentence', async () => {
    // Version skew, and the honest answer: the code is one the SPA has never heard of, so it cannot switch on it —
    // but the sentence is still the server's, written for a person.
    const error = await errorFromResponse(
      envelopeResponse(envelope({ code: 'QUOTA_EXCEEDED', message: 'Slow down.' }), {
        status: 429,
      }),
    );

    expect(error.code).toBe('UNKNOWN');
    expect(error.status).toBe(429);
    expect(error.message).toBe('Slow down.');
  });

  it('reads an HTML error page as UNKNOWN, with the status in the sentence', async () => {
    // nginx's `502 Bad Gateway` page is HTML, and the reader deserves better than "Unexpected token < in JSON".
    const error = await errorFromResponse(
      envelopeResponse('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
    );

    expect(error.code).toBe('UNKNOWN');
    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
    expect(error.message).not.toContain('<html>');
    expect(error.details).toBeUndefined();
  });

  it('reads an empty body as UNKNOWN', async () => {
    const error = await errorFromResponse(envelopeResponse('', { status: 500 }));

    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toContain('500');
  });

  it('accepts a JSON body that is not an object', async () => {
    // `null`, `[]`, `"oops"` — all valid JSON and none of them an envelope.
    for (const body of [null, [], 'oops', 42]) {
      const error = await errorFromResponse(envelopeResponse(body, { status: 500 }));
      expect(error.code, JSON.stringify(body)).toBe('UNKNOWN');
    }
  });

  it('rejects an `error` member that is not an object', async () => {
    const error = await errorFromResponse(envelopeResponse({ error: 'nope' }, { status: 500 }));

    expect(error.code).toBe('UNKNOWN');
  });

  it('uses the client sentence for a known code with no message', async () => {
    const error = await errorFromResponse(
      envelopeResponse(envelope({ message: '' }), { status: 409 }),
    );

    expect(error.code).toBe('VERSION_DUPLICATE');
    expect(error.message).toBe('Something went wrong.');
  });
});

describe('which codes end the session', () => {
  it('ends it for the four verdicts that mean the credential is finished', () => {
    expect(SESSION_ENDED_CODES).toEqual([
      'UNAUTHENTICATED',
      'TOKEN_EXPIRED',
      'TOKEN_REVOKED',
      'ACCOUNT_DISABLED',
    ]);

    for (const code of SESSION_ENDED_CODES) {
      expect(
        new ApiError({ code, status: code === 'ACCOUNT_DISABLED' ? 403 : 401 }).sessionEnded,
        code,
      ).toBe(true);
    }
  });

  it('does not end it for a wrong password, a permission answer or an outage', () => {
    // `INVALID_CREDENTIALS` is the login form's error: the visitor is not signed in, so there is no session to end —
    // and widening this set would make a typo on the login page clear the token of another tab's session.
    for (const code of [
      'INVALID_CREDENTIALS',
      'FORBIDDEN',
      'RATE_LIMITED',
      'INTERNAL_ERROR',
    ] as const) {
      expect(new ApiError({ code, status: 401 }).sessionEnded, code).toBe(false);
    }
    for (const code of CLIENT_ERROR_CODES) {
      expect(new ApiError({ code }).sessionEnded, code).toBe(false);
    }
  });

  it('ends it for an unreadable 401, because the credential is still refused', () => {
    // A proxy that answers `401` with its own HTML says the same thing in a different dialect: the token did not
    // work. Treating it as a display error would leave the reader on a page that can never load.
    expect(new ApiError({ code: 'UNKNOWN', status: 401 }).sessionEnded).toBe(true);
    expect(new ApiError({ code: 'UNKNOWN', status: 500 }).sessionEnded).toBe(false);
  });
});

describe('failures that never reached the server', () => {
  it('gives each client code a sentence of its own', () => {
    const sentences = CLIENT_ERROR_CODES.map((code) => new ApiError({ code }).message);

    expect(new Set(sentences).size).toBe(CLIENT_ERROR_CODES.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });

  it('keeps the cause for the console and shows none of it', () => {
    const cause = new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8080');
    const error = errorFromFailure(cause, 'NETWORK');

    expect(error.code).toBe('NETWORK');
    expect(error.status).toBeNull();
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('ECONNREFUSED');
  });

  it('is recognisable from a catch block', () => {
    expect(isApiError(errorFromFailure(undefined, 'TIMEOUT'))).toBe(true);
    expect(isApiError(new Error('unrelated'))).toBe(false);
    expect(isApiError('TIMEOUT')).toBe(false);
  });
});

describe('validation issues, for the forms', () => {
  /** An error carrying whatever `details` a case wants. */
  function withDetails(details: unknown): ApiError {
    return new ApiError({ code: 'VALIDATION_ERROR', status: 400, details });
  }

  it('reads the documented `details.issues`', () => {
    const error = withDetails({
      issues: [
        { path: 'username', message: 'Too small: expected string to have >=3 characters' },
        { path: 'country.slug', message: 'Required' },
      ],
    });

    expect(validationIssues(error)).toEqual([
      { path: 'username', message: 'Too small: expected string to have >=3 characters' },
      { path: 'country.slug', message: 'Required' },
    ]);
  });

  it('drops entries a form could not place, rather than throwing', () => {
    const error = withDetails({
      issues: [null, 'nope', { path: 1, message: 'x' }, { path: 'ok', message: 'fine' }],
    });

    expect(validationIssues(error)).toEqual([{ path: 'ok', message: 'fine' }]);
  });

  it('is empty when the failure carried no details, or details of another shape', () => {
    expect(validationIssues(withDetails(undefined))).toEqual([]);
    expect(validationIssues(withDetails(null))).toEqual([]);
    expect(validationIssues(withDetails({ issues: 'username' }))).toEqual([]);
    expect(validationIssues(new ApiError({ code: 'NOT_FOUND', status: 404 }))).toEqual([]);
  });
});
