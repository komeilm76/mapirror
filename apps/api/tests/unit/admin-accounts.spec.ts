import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Admin, Database } from '../../src/db/schema';

const mocks = vi.hoisted(() => ({
  findAdminByUsername: vi.fn(),
  insertAdmin: vi.fn(),
  updateAdminPassword: vi.fn(),
  revokeAllTokens: vi.fn(),
  insertAuditLog: vi.fn(),
  withTransaction: vi.fn(),
  hashPassword: vi.fn(),
  assertPasswordAcceptable: vi.fn(),
}));
vi.mock('../../src/db/repositories/admins', () => ({
  findAdminByUsername: mocks.findAdminByUsername,
  insertAdmin: mocks.insertAdmin,
  updateAdminPassword: mocks.updateAdminPassword,
}));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { adminCreated: 'admin.created', passwordReset: 'admin.password_reset' },
  insertAuditLog: mocks.insertAuditLog,
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/modules/auth/tokens', () => ({ revokeAllTokens: mocks.revokeAllTokens }));
vi.mock('../../src/modules/auth/password', () => ({
  hashPassword: mocks.hashPassword,
  assertPasswordAcceptable: mocks.assertPasswordAcceptable,
}));

import {
  AdminNotFoundError,
  AdminUsernameError,
  ensureAdmin,
  findExistingAdmin,
  parseAdminUsername,
  resetAdminPassword,
} from '../../src/modules/auth/admin-accounts';

const NOW = new Date('2026-11-01T12:00:00Z');

function admin(overrides: Partial<Admin> = {}): Admin {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'operator',
    password_hash: 'not-returned',
    is_active: true,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as Admin;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findAdminByUsername.mockResolvedValue(null);
  mocks.insertAdmin.mockResolvedValue(admin());
  mocks.updateAdminPassword.mockResolvedValue(admin());
  mocks.revokeAllTokens.mockResolvedValue(3);
  mocks.insertAuditLog.mockResolvedValue(undefined);
  mocks.withTransaction.mockImplementation(
    (_database: unknown, work: (trx: unknown) => Promise<unknown>) => work({ transaction: true }),
  );
  mocks.hashPassword.mockResolvedValue('argon-hash');
  mocks.assertPasswordAcceptable.mockImplementation(() => undefined);
});

describe('admin account helpers', () => {
  it('trims valid usernames and reports every violated rule without echoing the input', () => {
    expect(parseAdminUsername('  Operator  ')).toBe('Operator');
    expect(() => parseAdminUsername('  ')).toThrow(AdminUsernameError);

    try {
      parseAdminUsername(`${'x'.repeat(65)}\n`);
      throw new Error('expected invalid username');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminUsernameError);
      expect((error as AdminUsernameError).problems.map(({ rule }) => rule)).toEqual([
        'too-long',
        'control-character',
      ]);
      expect((error as Error).message).not.toContain('x'.repeat(20));
    }
  });

  it('looks up a normalized username and omits the stored hash from the result', async () => {
    mocks.findAdminByUsername.mockResolvedValue(admin({ is_active: false }));
    await expect(findExistingAdmin({} as never, ' OPERATOR ')).resolves.toEqual({
      id: admin().id,
      username: 'operator',
      isActive: false,
    });
    expect(mocks.findAdminByUsername).toHaveBeenCalledWith(expect.anything(), 'OPERATOR');
    mocks.findAdminByUsername.mockResolvedValue(null);
    await expect(findExistingAdmin({} as never, 'operator')).resolves.toBeNull();
    await expect(findExistingAdmin({} as never, '\n')).rejects.toThrow(AdminUsernameError);
  });

  it('does not touch the database for invalid credentials and preserves existing accounts unchanged', async () => {
    mocks.assertPasswordAcceptable.mockImplementationOnce(() => {
      throw new Error('password rejected');
    });
    await expect(
      ensureAdmin({} as unknown as Kysely<Database>, { username: 'operator', password: 'weak' }),
    ).rejects.toThrow('password rejected');
    expect(mocks.findAdminByUsername).not.toHaveBeenCalled();

    mocks.findAdminByUsername.mockResolvedValue(admin({ is_active: false }));
    await expect(
      ensureAdmin({} as unknown as Kysely<Database>, {
        username: ' operator ',
        password: 'Strong password 123!',
      }),
    ).resolves.toEqual({
      status: 'exists',
      admin: { id: admin().id, username: 'operator', isActive: false },
    });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('creates and audits a new admin using one injected timestamp and safe actor default', async () => {
    const database = {} as unknown as Kysely<Database>;
    await expect(
      ensureAdmin(database, {
        username: ' operator ',
        password: 'Strong password 123!',
        now: NOW,
      }),
    ).resolves.toEqual({
      status: 'created',
      admin: { id: admin().id, username: 'operator', isActive: true },
    });
    expect(mocks.hashPassword).toHaveBeenCalledWith('Strong password 123!');
    expect(mocks.insertAdmin).toHaveBeenCalledWith(
      { transaction: true },
      { username: 'operator', passwordHash: 'argon-hash' },
      NOW,
    );
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      { transaction: true },
      expect.objectContaining({
        action: 'admin.created',
        actorName: 'init-admin',
        targetId: admin().id,
        metadata: { username: 'operator' },
        at: NOW,
      }),
    );
  });

  it('treats only a unique-violation race as exists and propagates other creation failures', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
    mocks.withTransaction.mockRejectedValueOnce(duplicate);
    mocks.findAdminByUsername.mockResolvedValueOnce(null).mockResolvedValueOnce(admin());
    await expect(
      ensureAdmin({} as unknown as Kysely<Database>, {
        username: 'operator',
        password: 'Strong password 123!',
      }),
    ).resolves.toMatchObject({ status: 'exists', admin: { isActive: true } });

    const other = new Error('database unavailable');
    mocks.withTransaction.mockRejectedValueOnce(other);
    mocks.findAdminByUsername.mockResolvedValueOnce(null);
    await expect(
      ensureAdmin({} as unknown as Kysely<Database>, {
        username: 'operator',
        password: 'Strong password 123!',
      }),
    ).rejects.toBe(other);

    mocks.withTransaction.mockRejectedValueOnce(duplicate);
    mocks.findAdminByUsername.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(
      ensureAdmin({} as unknown as Kysely<Database>, {
        username: 'operator',
        password: 'Strong password 123!',
      }),
    ).rejects.toBe(duplicate);
  });

  it('resets passwords and revokes sessions atomically, including inactive accounts', async () => {
    const updated = admin({ is_active: false });
    mocks.findAdminByUsername.mockResolvedValue(admin());
    mocks.updateAdminPassword.mockResolvedValue(updated);
    const result = await resetAdminPassword({} as unknown as Kysely<Database>, {
      username: 'operator',
      password: 'Another strong password 123!',
      now: NOW,
      actorName: 'operator-cli',
    });
    expect(result).toEqual({
      admin: { id: updated.id, username: updated.username, isActive: false },
      revokedTokens: 3,
    });
    expect(mocks.updateAdminPassword).toHaveBeenCalledWith(
      { transaction: true },
      updated.id,
      'argon-hash',
      NOW,
    );
    expect(mocks.revokeAllTokens).toHaveBeenCalledWith({ transaction: true }, updated.id, {
      now: NOW,
    });
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      { transaction: true },
      expect.objectContaining({
        action: 'admin.password_reset',
        actorName: 'operator-cli',
        metadata: { username: 'operator', revokedTokens: 3 },
      }),
    );
  });

  it('rejects invalid reset credentials and reports accounts removed before or during reset', async () => {
    mocks.findAdminByUsername.mockResolvedValue(null);
    await expect(
      resetAdminPassword({} as unknown as Kysely<Database>, {
        username: 'operator',
        password: 'Strong password 123!',
      }),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
    expect(mocks.hashPassword).not.toHaveBeenCalled();

    mocks.findAdminByUsername.mockResolvedValue(admin());
    mocks.updateAdminPassword.mockResolvedValue(null);
    await expect(
      resetAdminPassword({} as unknown as Kysely<Database>, {
        username: 'operator',
        password: 'Strong password 123!',
      }),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
    expect(mocks.revokeAllTokens).not.toHaveBeenCalled();

    mocks.assertPasswordAcceptable.mockImplementationOnce(() => {
      throw new Error('weak password');
    });
    await expect(
      resetAdminPassword({} as unknown as Kysely<Database>, {
        username: 'operator',
        password: 'weak',
      }),
    ).rejects.toThrow('weak password');
  });
});
