import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DomainError } from '../../domain/errors/domain-error';
import {
  type AccessClaims,
  type AuthCryptography,
  AuthService,
} from '../../domain/services/auth-service';
import { AUTH_CONFIG } from '../../lib/auth-security';
import { hashPassword, verifyPassword } from '../../lib/password';
import { createTestDatabase, type TestDatabase } from './helpers';

const password = 'ServiceIntegrationPass123!';
const sign = async (claims: AccessClaims): Promise<string> => JSON.stringify(claims);
const cryptoAdapter: AuthCryptography = {
  hash: hashPassword,
  verify: verifyPassword,
  token: () => crypto.randomUUID(),
};

async function expectDomain(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected service rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    if (!(error instanceof DomainError)) throw error;
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  }
}

describe('AuthService isolated database integration', () => {
  let fixture: TestDatabase;
  let service: AuthService;
  let clock = Date.now();
  beforeAll(async () => {
    fixture = await createTestDatabase();
    service = new AuthService(fixture.database, cryptoAdapter, () => clock);
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('registers, logs in, rotates exactly once and logs out without exposing secrets', async () => {
    const result = await service.register({
      email: 'workflow@example.invalid',
      password,
      name: 'Workflow',
    });
    expect(result.user.role).toBe('user');
    expect(result.user).not.toHaveProperty('password');
    const stored = await fixture.database.user.findUniqueOrThrow({ where: { id: result.user.id } });
    expect(stored.password).not.toBe(password);
    const session = await service.login({ email: stored.email, password }, sign);
    expect(session.user).toEqual(result.user);
    expect(JSON.parse(session.accessToken)).toEqual({
      userId: stored.id,
      role: 'user',
      type: 'access',
      exp: Math.floor(clock / 1000) + 900,
    });
    const refreshed = await service.refresh(session.refreshToken, sign);
    expect(refreshed.refreshToken).not.toBe(session.refreshToken);
    await expectDomain(service.refresh(session.refreshToken, sign), 'INVALID_REFRESH_TOKEN', 401);
    expect(await service.logout(stored.id, { refreshToken: refreshed.refreshToken })).toEqual({
      message: 'ログアウトしました',
    });
    await expectDomain(service.refresh(refreshed.refreshToken, sign), 'INVALID_REFRESH_TOKEN', 401);
  });

  it('rejects weak passwords and duplicate emails, including concurrent registrations', async () => {
    await expectDomain(
      service.register({ email: 'weak@example.invalid', password: 'a' }),
      'WEAK_PASSWORD',
      400,
    );
    expect(await fixture.database.user.count({ where: { email: 'weak@example.invalid' } })).toBe(0);
    const input = { email: 'duplicate@example.invalid', password };
    const attempts = await Promise.allSettled([service.register(input), service.register(input)]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failure = attempts.find((attempt) => attempt.status === 'rejected');
    if (failure?.status !== 'rejected') throw new Error('Expected duplicate rejection');
    expect(failure.reason).toBeInstanceOf(DomainError);
    await expectDomain(service.register(input), 'EMAIL_EXISTS', 400);
  });

  it('maps hashing/persistence failure without leaking the underlying details', async () => {
    const failing = new AuthService(fixture.database, {
      ...cryptoAdapter,
      hash: async () => {
        throw new Error('private database credentials');
      },
    });
    await expectDomain(
      failing.register({ email: 'failed@example.invalid', password }),
      'REGISTRATION_FAILED',
      500,
    );
    expect(await fixture.database.user.count({ where: { email: 'failed@example.invalid' } })).toBe(
      0,
    );
  });

  it('rejects unknown credentials and locks repeated failures, then unlocks after expiry', async () => {
    await expectDomain(
      service.login({ email: 'missing@example.invalid', password }, sign),
      'INVALID_CREDENTIALS',
      401,
    );
    const registered = await service.register({ email: 'lock@example.invalid', password });
    for (let index = 0; index < AUTH_CONFIG.MAX_LOGIN_ATTEMPTS; index++)
      await expectDomain(
        service.login({ email: registered.user.email, password: 'wrong' }, sign),
        'INVALID_CREDENTIALS',
        401,
      );
    const locked = await fixture.database.user.findUniqueOrThrow({
      where: { id: registered.user.id },
    });
    expect(locked.loginAttempts).toBe(AUTH_CONFIG.MAX_LOGIN_ATTEMPTS);
    await expectDomain(
      service.login({ email: registered.user.email, password }, sign),
      'ACCOUNT_LOCKED',
      423,
    );
    clock += AUTH_CONFIG.LOCKOUT_TIME_MINUTES * 60000 + 1;
    await expectDomain(
      service.login({ email: registered.user.email, password: 'still-wrong' }, sign),
      'INVALID_CREDENTIALS',
      401,
    );
    expect(
      (await fixture.database.user.findUniqueOrThrow({ where: { id: registered.user.id } }))
        .loginAttempts,
    ).toBe(1);
    await service.login({ email: registered.user.email, password }, sign);
    const unlocked = await fixture.database.user.findUniqueOrThrow({
      where: { id: registered.user.id },
    });
    expect(unlocked.loginAttempts).toBe(0);
    expect(unlocked.lockedUntil).toBeNull();
  });

  it('increments concurrent failed logins without lost updates', async () => {
    const registered = await service.register({
      email: 'concurrent-login@example.invalid',
      password,
    });
    await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        service.login({ email: registered.user.email, password: 'wrong' }, sign),
      ),
    );
    const stored = await fixture.database.user.findUniqueOrThrow({
      where: { id: registered.user.id },
    });
    expect(stored.loginAttempts).toBe(5);
    expect(stored.lockedUntil).not.toBeNull();
  });

  it('allows one concurrent rotation and rejects replay rather than issuing two sessions', async () => {
    const user = await service.register({ email: 'concurrent-refresh@example.invalid', password });
    const session = await service.login({ email: user.user.email, password }, sign);
    const attempts = await Promise.allSettled([
      service.refresh(session.refreshToken, sign),
      service.refresh(session.refreshToken, sign),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(await fixture.database.refreshToken.count({ where: { userId: user.user.id } })).toBe(1);
  });

  it('rolls token consumption back when replacement cannot be persisted', async () => {
    const user = await service.register({ email: 'rollback-refresh@example.invalid', password });
    const session = await service.login({ email: user.user.email, password }, sign);
    const collision = 'fixture-existing-token';
    await fixture.database.refreshToken.create({
      data: { userId: user.user.id, token: collision, expiresAt: new Date(clock + 60000) },
    });
    const failing = new AuthService(
      fixture.database,
      { ...cryptoAdapter, token: () => collision },
      () => clock,
    );
    await expect(failing.refresh(session.refreshToken, sign)).rejects.toThrow();
    expect(
      await fixture.database.refreshToken.findUnique({ where: { token: session.refreshToken } }),
    ).not.toBeNull();
    expect(await fixture.database.refreshToken.count({ where: { userId: user.user.id } })).toBe(2);
  });

  it('rolls back login state when its session cannot be persisted', async () => {
    const user = await service.register({ email: 'rollback-login@example.invalid', password });
    await fixture.database.user.update({ where: { id: user.user.id }, data: { loginAttempts: 3 } });
    const collision = 'login-collision';
    await fixture.database.refreshToken.create({
      data: { userId: user.user.id, token: collision, expiresAt: new Date(clock + 60000) },
    });
    const failing = new AuthService(
      fixture.database,
      { ...cryptoAdapter, token: () => collision },
      () => clock,
    );
    await expect(failing.login({ email: user.user.email, password }, sign)).rejects.toThrow();
    expect(
      (await fixture.database.user.findUniqueOrThrow({ where: { id: user.user.id } }))
        .loginAttempts,
    ).toBe(3);
  });

  it('expires tokens and restricts logout to their owner, including logout-all', async () => {
    const user = await service.register({ email: 'logout@example.invalid', password });
    const first = await service.login({ email: user.user.email, password }, sign);
    const second = await service.login({ email: user.user.email, password }, sign);
    await expectDomain(
      service.logout(user.user.id + 1000, { refreshToken: first.refreshToken }),
      'REFRESH_TOKEN_NOT_OWNED',
      400,
    );
    await expectDomain(service.logout(user.user.id, {}), 'REFRESH_TOKEN_REQUIRED', 400);
    await fixture.database.refreshToken.update({
      where: { token: first.refreshToken },
      data: { expiresAt: new Date(clock) },
    });
    await expectDomain(service.refresh(first.refreshToken, sign), 'INVALID_REFRESH_TOKEN', 401);
    expect(
      await fixture.database.refreshToken.findUnique({ where: { token: first.refreshToken } }),
    ).toBeNull();
    expect(await service.logout(user.user.id, { logoutAll: true })).toEqual({
      message: 'すべてのデバイスからログアウトしました',
    });
    await expectDomain(service.refresh(second.refreshToken, sign), 'INVALID_REFRESH_TOKEN', 401);
  });
});
