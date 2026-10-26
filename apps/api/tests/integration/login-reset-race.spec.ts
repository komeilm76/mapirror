import { describe, expect, it, vi } from 'vitest';

const verificationGate = vi.hoisted(() => {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    entered,
    released,
    markEntered: () => enteredResolve(),
    release: () => releaseResolve(),
  };
});

vi.mock('../../src/modules/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return {
    ...actual,
    verifyPassword: async (hash: string, password: string): Promise<boolean> => {
      const valid = await actual.verifyPassword(hash, password);
      verificationGate.markEntered();
      await verificationGate.released;
      return valid;
    },
  };
});

import type * as PasswordModule from '../../src/modules/auth/password';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password';
import { resetAdminPassword } from '../../src/modules/auth/admin-accounts';
import { login } from '../../src/modules/auth/service';
import { LoginThrottle } from '../../src/modules/auth/login-throttle';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a newer and safer passphrase';

describe.skipIf(skipReason !== null)('login racing a password reset', () => {
  it('does not create a session from the old password after reset has committed', async () => {
    await withFreshDatabase(
      async (database) => {
        const row = await database.db
          .insertInto('admins')
          .values({ username: 'admin', password_hash: await hashPassword(OLD_PASSWORD) })
          .returning('id')
          .executeTakeFirstOrThrow();

        const loginInFlight = login(
          {
            database: database.db,
            throttle: new LoginThrottle({ maxAttempts: 10, windowMs: 15 * 60_000 }),
            tokenTtlHours: 12,
          },
          { username: 'admin', password: OLD_PASSWORD },
        );

        // Pause after the old hash has successfully verified but before the login transaction starts. The reset then
        // commits first, deterministically reproducing the timing window instead of hoping two Argon2 calls race.
        await verificationGate.entered;
        await resetAdminPassword(database.db, {
          username: 'admin',
          password: NEW_PASSWORD,
          actorName: 'race-test',
        });
        verificationGate.release();

        await expect(loginInFlight).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
        const tokens = await database.db
          .selectFrom('admin_tokens')
          .selectAll()
          .where('admin_id', '=', row.id)
          .execute();
        expect(tokens).toEqual([]);
        const failedLogin = await database.db
          .selectFrom('audit_logs')
          .select(['action', 'metadata'])
          .where('action', '=', 'auth.login_failed')
          .executeTakeFirstOrThrow();
        expect(failedLogin.metadata).toMatchObject({ reason: 'password_changed_during_login' });

        const password = await database.db
          .selectFrom('admins')
          .select('password_hash')
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        expect(await verifyPassword(password.password_hash, NEW_PASSWORD)).toBe(true);
      },
      { prefix: 'loginresetrace', migrate: true },
    );
  });
});
