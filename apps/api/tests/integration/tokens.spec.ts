import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { Database, SqlDatabase } from '../../src/index';
import { withTransaction } from '../../src/db/transaction';
import {
  generateToken,
  hashToken,
  issueToken,
  pruneExpiredTokens,
  revokeAllTokens,
  revokeToken,
  verifyToken,
} from '../../src/modules/auth/tokens';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * Acceptance test for `P1-AUTH-02` against a real database: only the digest is stored, a token is verified by that
 * digest (not by its prefix), it expires, it can be revoked individually or in bulk, and `last_used_at` is written at
 * most once a minute.
 *
 * Each case gets its own database, migrated with `0001_init`, because the interesting assertions are about rows: what
 * a dumped table contains, what a second request changes, what the server does with a token whose `expires_at` has
 * passed.
 */

const skipReason = await freshDatabaseSkipReason();

/** A fixed instant, so expiry assertions do not depend on how long the test took to run. */
const NOW = new Date('2026-10-25T09:00:00.000Z');

/** Inserts an admin and returns its id. The hash is a placeholder: no test here logs in with a password. */
async function insertAdmin(
  db: Kysely<Database>,
  username = 'admin',
  isActive = true,
): Promise<string> {
  const row = await db
    .insertInto('admins')
    .values({ username, password_hash: '$argon2id$placeholder', is_active: isActive })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Runs a case against a fresh, migrated database with one admin already present. */
async function withAdmin(
  run: (context: { handle: SqlDatabase; db: Kysely<Database>; adminId: string }) => Promise<void>,
  isActive = true,
): Promise<void> {
  await withFreshDatabase(
    async (handle) => {
      const adminId = await insertAdmin(handle.db, 'admin', isActive);
      await run({ handle, db: handle.db, adminId });
    },
    { prefix: 'tk', migrate: true },
  );
}

describe.skipIf(skipReason !== null)('issueToken', () => {
  it('stores the digest and the prefix, and never the token', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, {
        ttlHours: 12,
        now: NOW,
        userAgent: 'vitest/5',
        ip: '10.1.2.3',
      });

      const row = await db.selectFrom('admin_tokens').selectAll().executeTakeFirstOrThrow();

      expect(row.id).toBe(issued.tokenId);
      expect(row.admin_id).toBe(adminId);
      expect(row.token_prefix).toBe(issued.tokenPrefix);
      expect(row.token_prefix).toHaveLength(8);
      expect(row.token_hash).toHaveLength(32);
      expect(row.token_hash.equals(hashToken(issued.token))).toBe(true);
      expect(row.expires_at.toISOString()).toBe('2026-10-25T21:00:00.000Z');
      expect(row.revoked_at).toBeNull();
      expect(row.last_used_at).toBeNull();
      expect(row.user_agent).toBe('vitest/5');
      expect(row.ip).toBe('10.1.2.3');

      // The property the whole design rests on: nothing in the row can be turned back into the credential. Checked by
      // looking at *every* value rather than at the columns this test remembered to list.
      for (const value of Object.values(row)) {
        if (typeof value === 'string') expect(value).not.toContain(issued.token);
        if (Buffer.isBuffer(value)) expect(value.toString('utf8')).not.toContain(issued.token);
      }
      expect(JSON.stringify(row)).not.toContain(issued.token.slice(8));
    });
  });

  it('can mint inside a transaction, so the token and the audit entry commit together', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await withTransaction(db, (trx) =>
        issueToken(trx, adminId, { ttlHours: 1, now: NOW }),
      );

      const verdict = await verifyToken(db, issued.token, { now: NOW });
      expect(verdict.status).toBe('valid');
    });
  });
});

describe.skipIf(skipReason !== null)('verifyToken', () => {
  it('accepts a live token and records its use', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 12, now: NOW });

      const verdict = await verifyToken(db, issued.token, { now: NOW });

      expect(verdict).toMatchObject({
        status: 'valid',
        admin: { id: adminId, username: 'admin', isActive: true },
        token: { id: issued.tokenId, prefix: issued.tokenPrefix, lastUsedAt: NOW },
      });

      const row = await db.selectFrom('admin_tokens').selectAll().executeTakeFirstOrThrow();
      expect(row.last_used_at?.toISOString()).toBe(NOW.toISOString());
    });
  });

  it('answers `unknown` for a token that never existed, and for one character changed', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 12, now: NOW });
      const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;

      await expect(verifyToken(db, generateToken().token, { now: NOW })).resolves.toEqual({
        status: 'unknown',
      });
      await expect(verifyToken(db, tampered, { now: NOW })).resolves.toEqual({ status: 'unknown' });
      // ...and the real token still works, so the rejection is about the value and not about the row.
      expect((await verifyToken(db, issued.token, { now: NOW })).status).toBe('valid');
    });
  });

  it('looks the token up by digest, not by its display prefix', async () => {
    await withAdmin(async ({ db, adminId }) => {
      // A row whose prefix is the prefix of a token we know, but whose digest belongs to a different string. If
      // verification matched `token_prefix` — the tempting shortcut, since it is the only human-readable part —
      // this would authenticate as that row.
      const presented = generateToken();
      await db
        .insertInto('admin_tokens')
        .values({
          admin_id: adminId,
          token_hash: hashToken(generateToken().token),
          token_prefix: presented.tokenPrefix,
          expires_at: new Date(NOW.getTime() + 3_600_000),
        })
        .execute();

      await expect(verifyToken(db, presented.token, { now: NOW })).resolves.toEqual({
        status: 'unknown',
      });
    });
  });

  it('reports expiry, with the admin and the token facts still attached', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 12, now: NOW });

      // The boundary is `expires_at <= now`: a token is dead at the instant it expires, not one millisecond later.
      const atExpiry = await verifyToken(db, issued.token, { now: new Date(issued.expiresAt) });
      expect(atExpiry.status).toBe('expired');
      expect(atExpiry).toMatchObject({
        admin: { username: 'admin' },
        token: { expiresAt: issued.expiresAt },
      });

      const before = await verifyToken(db, issued.token, {
        now: new Date(issued.expiresAt.getTime() - 1),
      });
      expect(before.status).toBe('valid');
    });
  });

  it('reports revocation before expiry, when a token is both', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 1, now: NOW });
      await revokeToken(db, issued.token, { now: NOW });
      await db
        .updateTable('admin_tokens')
        .set({ expires_at: new Date(NOW.getTime() - 1) })
        .execute();

      // "You were signed out" is more useful than "that expired", and both are 401.
      expect((await verifyToken(db, issued.token, { now: NOW })).status).toBe('revoked');
    });
  });

  it('reports a deactivated account separately from a bad token', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 12, now: NOW });
      await db.updateTable('admins').set({ is_active: false }).execute();

      // ACCOUNT_DISABLED is a 403 in the contract, and it must never be reported as a token problem: the client
      // should stop retrying and tell the person an operator has to act.
      const verdict = await verifyToken(db, issued.token, { now: NOW });
      expect(verdict.status).toBe('disabled');
      expect(verdict).toMatchObject({ admin: { isActive: false } });
    });
  });

  it('writes last_used_at at most once a minute', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 12, now: NOW });

      const readUsage = async (): Promise<string | null> => {
        const row = await db
          .selectFrom('admin_tokens')
          .select('last_used_at')
          .executeTakeFirstOrThrow();
        return row.last_used_at?.toISOString() ?? null;
      };

      await verifyToken(db, issued.token, { now: NOW });
      expect(await readUsage()).toBe(NOW.toISOString());

      const thirtySeconds = new Date(NOW.getTime() + 30_000);
      const second = await verifyToken(db, issued.token, { now: thirtySeconds });
      // The write is skipped, so the row keeps the first instant — and the verdict reports what the row holds rather
      // than pretending it just wrote.
      expect(await readUsage()).toBe(NOW.toISOString());
      expect(second).toMatchObject({ token: { lastUsedAt: NOW } });

      const twoMinutes = new Date(NOW.getTime() + 120_000);
      await verifyToken(db, issued.token, { now: twoMinutes });
      expect(await readUsage()).toBe(twoMinutes.toISOString());
    });
  });
});

describe.skipIf(skipReason !== null)('the default clock', () => {
  it('uses the real clock when no instant is supplied, for every operation', async () => {
    // Nothing here passes `now`: these are the calls production makes, and a default that reads `undefined` as a date
    // would mint tokens that expire in 1970 or never expire at all.
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 12 });
      expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 3_600_000);

      expect((await verifyToken(db, issued.token)).status).toBe('valid');
      expect(await revokeAllTokens(db, adminId)).toBe(1);
      expect((await verifyToken(db, issued.token)).status).toBe('revoked');
      expect(await revokeToken(db, issued.token)).toBe(false);
      expect(await pruneExpiredTokens(db)).toBe(0);
    });
  });
});

describe.skipIf(skipReason !== null)('revocation', () => {
  it('revokes only the presented token, idempotently', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const first = await issueToken(db, adminId, { ttlHours: 12, now: NOW });
      const second = await issueToken(db, adminId, { ttlHours: 12, now: NOW });

      await expect(revokeToken(db, first.token, { now: NOW })).resolves.toBe(true);
      await expect(revokeToken(db, first.token, { now: NOW })).resolves.toBe(false);
      await expect(revokeToken(db, generateToken().token, { now: NOW })).resolves.toBe(false);

      expect((await verifyToken(db, first.token, { now: NOW })).status).toBe('revoked');
      expect((await verifyToken(db, second.token, { now: NOW })).status).toBe('valid');
    });
  });

  it('keeps the original revocation time when logout is repeated later', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const issued = await issueToken(db, adminId, { ttlHours: 12, now: NOW });
      await revokeToken(db, issued.token, { now: NOW });
      await revokeToken(db, issued.token, { now: new Date(NOW.getTime() + 60_000) });

      const row = await db.selectFrom('admin_tokens').selectAll().executeTakeFirstOrThrow();
      // The audit reads this value; a second logout must not rewrite history.
      expect(row.revoked_at?.toISOString()).toBe(NOW.toISOString());
    });
  });

  it('revokes every session of an admin, as a password reset must', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const tokens = await Promise.all(
        [0, 1, 2].map((index) =>
          issueToken(db, adminId, { ttlHours: 12, now: new Date(NOW.getTime() + index) }),
        ),
      );

      await expect(revokeAllTokens(db, adminId, { now: NOW })).resolves.toBe(3);
      await expect(revokeAllTokens(db, adminId, { now: NOW })).resolves.toBe(0);

      for (const issued of tokens) {
        expect((await verifyToken(db, issued.token, { now: NOW })).status).toBe('revoked');
      }
    });
  });
});

describe.skipIf(skipReason !== null)('pruneExpiredTokens', () => {
  it('deletes tokens expired for longer than the retention window, and nothing else', async () => {
    await withAdmin(async ({ db, adminId }) => {
      const insert = (expiresInDays: number): Promise<unknown> =>
        db
          .insertInto('admin_tokens')
          .values({
            admin_id: adminId,
            token_hash: hashToken(generateToken().token),
            token_prefix: 'mm_prune1',
            expires_at: new Date(NOW.getTime() + expiresInDays * 86_400_000),
          })
          .execute();

      await insert(-40); // expired 40 days ago → deleted
      await insert(-31); // expired 31 days ago → deleted
      await insert(-30); // exactly at the boundary → kept (`expires_at < cutoff` is strict)
      await insert(-10); // expired recently: kept, so the sessions list can still explain it
      await insert(0); // live → kept

      // A revoked but not yet expired token is not housekeeping's business: it still explains a session.
      const revoked = await issueToken(db, adminId, { ttlHours: 1, now: NOW });
      await revokeToken(db, revoked.token, { now: NOW });

      await expect(pruneExpiredTokens(db, { now: NOW })).resolves.toBe(2);

      const remaining = await db
        .selectFrom('admin_tokens')
        .select(sql<number>`count(*)::int`.as('count'))
        .executeTakeFirstOrThrow();
      // Six rows were inserted and two were housekeeping: the boundary row, the recent expiry, the live token and
      // the revoked one all survive.
      expect(remaining.count).toBe(4);
    });
  });
});
