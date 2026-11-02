import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/lib/errors';
import { login, type LoginDeps } from '../../src/modules/auth/service';

const mocks = vi.hoisted(() => ({
  insertAuditLog: vi.fn(),
  findAdminByUsername: vi.fn(),
  recordLogin: vi.fn(),
  withTransaction: vi.fn(),
  normaliseIp: vi.fn(),
  verifyPassword: vi.fn(),
  issueToken: vi.fn(),
}));

vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { login: 'auth.login', loginFailed: 'auth.login_failed' },
  insertAuditLog: mocks.insertAuditLog,
}));
vi.mock('../../src/db/repositories/admins', () => ({
  findAdminByUsername: mocks.findAdminByUsername,
  recordLogin: mocks.recordLogin,
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/lib/client-ip', () => ({ normaliseIp: mocks.normaliseIp }));
vi.mock('../../src/modules/auth/password', () => ({ verifyPassword: mocks.verifyPassword }));
vi.mock('../../src/modules/auth/tokens', () => ({ issueToken: mocks.issueToken }));

const ADMIN = {
  id: 'admin-id',
  username: 'operator',
  password_hash: 'stored-hash',
  is_active: true,
};
const CURRENT = { password_hash: ADMIN.password_hash, is_active: true };
const EXPIRES_AT = new Date('2026-11-02T12:00:00.000Z');

function makeThrottle(limited = false) {
  return {
    check: vi.fn(() =>
      limited
        ? {
            limited: true as const,
            lockedUntil: new Date('2026-11-01T12:01:00.000Z'),
            retryAfterSeconds: 60,
          }
        : { limited: false as const },
    ),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    release: vi.fn(),
  };
}

function makeTransaction(current: typeof CURRENT | undefined = CURRENT) {
  const query = {
    select: vi.fn(() => query),
    where: vi.fn(() => query),
    forUpdate: vi.fn(() => query),
    executeTakeFirst: vi.fn(() => Promise.resolve(current)),
  };
  return {
    transaction: { selectFrom: vi.fn(() => query) },
    query,
  };
}

function makeDeps(overrides: Partial<LoginDeps> = {}) {
  const throttle = makeThrottle();
  const warning = vi.fn<(context: object, message: string) => void>();
  const database = {} as LoginDeps['database'];
  return {
    deps: {
      database,
      throttle,
      tokenTtlHours: 12,
      ip: '::ffff:192.0.2.4',
      userAgent: 'unit-test',
      now: new Date('2026-11-01T12:00:00.000Z'),
      log: { warn: warning },
      ...overrides,
    } as LoginDeps,
    throttle,
    warning,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.normaliseIp.mockImplementation(
    (ip: string | null | undefined) => ip?.replace('::ffff:', '') ?? null,
  );
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.recordLogin.mockResolvedValue(undefined);
  mocks.insertAuditLog.mockResolvedValue(undefined);
  mocks.issueToken.mockResolvedValue({
    token: 'once-only-token',
    tokenId: 'token-id',
    expiresAt: EXPIRES_AT,
  });
  const { transaction } = makeTransaction();
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (trx: unknown) => Promise<unknown>) => work(transaction),
  );
});

describe('admin login service', () => {
  it('rejects a limited attempt before looking up an account or verifying a password', async () => {
    const { deps, throttle } = makeDeps();
    const limitedThrottle = makeThrottle(true);
    const limitedDeps = {
      ...deps,
      throttle: limitedThrottle as unknown as LoginDeps['throttle'],
    };

    await expect(
      login(limitedDeps, { username: ' operator ', password: 'secret' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mocks.findAdminByUsername).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(throttle.check).not.toHaveBeenCalled();
    expect(limitedThrottle.check).toHaveBeenCalledWith('192.0.2.4', 'operator');
  });

  it('uses the dummy hash for unknown users and records one generic failed attempt', async () => {
    const { deps, throttle } = makeDeps();
    mocks.findAdminByUsername.mockResolvedValue(null);

    await expect(
      login(deps, { username: ' missing ', password: 'candidate' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(mocks.findAdminByUsername).toHaveBeenCalledWith(deps.database, 'missing');
    expect(mocks.verifyPassword).toHaveBeenCalledWith(
      expect.stringContaining('$argon2id$'),
      'candidate',
    );
    expect(throttle.recordFailure).toHaveBeenCalledWith('192.0.2.4', 'missing');
    expect(throttle.release).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      deps.database,
      expect.objectContaining({
        actorId: null,
        actorName: 'missing',
        action: 'auth.login_failed',
        metadata: { reason: 'unknown_username' },
      }),
    );
  });

  it('counts a wrong password for an existing account without revealing the account', async () => {
    const { deps, throttle } = makeDeps();
    mocks.findAdminByUsername.mockResolvedValue(ADMIN);
    mocks.verifyPassword.mockResolvedValue(false);

    await expect(
      login(deps, { username: ADMIN.username, password: 'wrong' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'The username or password is incorrect.',
    });
    expect(mocks.verifyPassword).toHaveBeenCalledWith(ADMIN.password_hash, 'wrong');
    expect(throttle.recordFailure).toHaveBeenCalledTimes(1);
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      deps.database,
      expect.objectContaining({
        actorId: ADMIN.id,
        actorName: ADMIN.username,
        metadata: { reason: 'wrong_password' },
      }),
    );
  });

  it('releases the throttle reservation for a disabled account with a correct password', async () => {
    const { deps, throttle } = makeDeps();
    mocks.findAdminByUsername.mockResolvedValue({ ...ADMIN, is_active: false });

    await expect(
      login(deps, { username: ADMIN.username, password: 'correct' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(throttle.release).toHaveBeenCalledWith('192.0.2.4', ADMIN.username);
    expect(throttle.recordFailure).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      deps.database,
      expect.objectContaining({
        metadata: { reason: 'account_disabled' },
      }),
    );
  });

  it('issues a token, login timestamp, and audit row in one transaction on success', async () => {
    const { deps, throttle } = makeDeps();
    mocks.findAdminByUsername.mockResolvedValue(ADMIN);
    const result = await login(deps, { username: ' operator ', password: 'correct' });

    expect(result).toEqual({
      token: 'once-only-token',
      expiresAt: EXPIRES_AT.toISOString(),
      admin: { id: ADMIN.id, username: ADMIN.username },
    });
    expect(mocks.issueToken).toHaveBeenCalledWith(expect.anything(), ADMIN.id, {
      ttlHours: 12,
      now: deps.now,
      userAgent: 'unit-test',
      ip: '192.0.2.4',
    });
    expect(mocks.recordLogin).toHaveBeenCalledWith(expect.anything(), ADMIN.id, deps.now);
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: ADMIN.id,
        action: 'auth.login',
        targetType: 'admin_token',
        targetId: 'token-id',
      }),
    );
    expect(throttle.recordSuccess).toHaveBeenCalledWith('192.0.2.4', ADMIN.username);
    expect(throttle.release).not.toHaveBeenCalled();
  });

  it('counts a password reset racing after verification as a generic credential failure', async () => {
    const { deps, throttle } = makeDeps();
    mocks.findAdminByUsername.mockResolvedValue(ADMIN);
    const { transaction } = makeTransaction({ password_hash: 'new-hash', is_active: true });
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (trx: unknown) => Promise<unknown>) => work(transaction),
    );

    await expect(
      login(deps, { username: ADMIN.username, password: 'correct' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(throttle.recordFailure).toHaveBeenCalledTimes(1);
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      deps.database,
      expect.objectContaining({
        metadata: { reason: 'password_changed_during_login' },
      }),
    );
  });

  it('releases an unsettled reservation after an infrastructure failure and warns if failed-login audit also fails', async () => {
    const { deps, throttle, warning } = makeDeps();
    mocks.findAdminByUsername.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(login(deps, { username: ADMIN.username, password: 'correct' })).rejects.toThrow(
      'database unavailable',
    );
    expect(throttle.release).toHaveBeenCalledWith('192.0.2.4', ADMIN.username);

    mocks.findAdminByUsername.mockResolvedValue(null);
    mocks.insertAuditLog.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      login(deps, { username: ADMIN.username, password: 'correct' }),
    ).rejects.toBeInstanceOf(AppError);
    const warningContext = warning.mock.calls[0]?.[0] as { err?: unknown } | undefined;
    expect(warningContext?.err).toBeInstanceOf(Error);
    expect(warning.mock.calls[0]?.[1]).toBe(
      'could not record a failed login attempt; the 401 stands',
    );
  });
});
