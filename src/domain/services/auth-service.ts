import { Prisma } from '@prisma/client';
import { AUTH_CONFIG } from '../../lib/auth-security';
import {
  generateSecureToken,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../../lib/password';
import { DomainError } from '../errors/domain-error';
import type { AuthRepository } from '../repositories/service-database';

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
}
export interface AccessClaims {
  userId: number;
  role: string;
  type: string;
  exp: number;
}
export type AccessSigner = (claims: AccessClaims) => Promise<string>;
export interface AuthCryptography {
  hash(password: string): Promise<{ hash: string }>;
  verify(password: string, hash: string): Promise<boolean>;
  token(): string;
}
const defaultCryptography: AuthCryptography = {
  hash: hashPassword,
  verify: verifyPassword,
  token: () => generateSecureToken(64),
};
const userSelection = { id: true, email: true, name: true, role: true } satisfies Prisma.UserSelect;
const invalidCredentials = (): DomainError =>
  new DomainError('INVALID_CREDENTIALS', 401, 'メールアドレスまたはパスワードが正しくありません');
const invalidRefresh = (): DomainError =>
  new DomainError('INVALID_REFRESH_TOKEN', 401, '無効なリフレッシュトークンです');

/** 認証・ロック・リフレッシュの業務処理。HTTP コンテキストを受け取らない。 */
export class AuthService {
  /** DB、暗号処理、時計を注入し、実 DB と障害ケースを同じ契約で検証する。 */
  constructor(
    private readonly repository: AuthRepository,
    private readonly cryptography: AuthCryptography = defaultCryptography,
    private readonly now: () => number = Date.now,
  ) {}

  /** 重複競合も一意制約で防ぎ、公開可能なプロフィールのみ返す。 */
  async register(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<{ message: string; user: AuthUser }> {
    if (await this.repository.user.findUnique({ where: { email: input.email } }))
      throw new DomainError('EMAIL_EXISTS', 400, 'すでに登録されているメールアドレスです');
    const validation = validatePasswordStrength(input.password);
    if (!validation.isValid)
      throw new DomainError(
        'WEAK_PASSWORD',
        400,
        'パスワードが要件を満たしていません',
        validation.errors,
      );
    try {
      const { hash } = await this.cryptography.hash(input.password);
      const user = await this.repository.user.create({
        data: { email: input.email, password: hash, name: input.name, role: 'user' },
        select: userSelection,
      });
      return { message: 'ユーザー登録が完了しました', user };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new DomainError('EMAIL_EXISTS', 400, 'すでに登録されているメールアドレスです');
      throw new DomainError('REGISTRATION_FAILED', 500, 'ユーザー登録に失敗しました');
    }
  }

  /** ログイン失敗数の更新とロック判定を単一トランザクションで行う。 */
  async login(
    input: { email: string; password: string },
    sign: AccessSigner,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; user: AuthUser }> {
    const user = await this.repository.user.findUnique({ where: { email: input.email } });
    if (!user) throw invalidCredentials();
    const now = this.now();
    if (user.lockedUntil && user.lockedUntil.getTime() > now)
      throw new DomainError(
        'ACCOUNT_LOCKED',
        423,
        `アカウントがロックされています。${user.lockedUntil.toLocaleString('ja-JP')}以降に再試行してください。`,
      );
    if (!(await this.cryptography.verify(input.password, user.password))) {
      await this.repository.$transaction(async (tx) => {
        const latest = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        if (latest.lockedUntil && latest.lockedUntil.getTime() > now)
          throw new DomainError('ACCOUNT_LOCKED', 423, 'アカウントがロックされています');
        const expired = latest.lockedUntil !== null && latest.lockedUntil.getTime() <= now;
        const updated = await tx.user.update({
          where: { id: user.id },
          data: {
            loginAttempts: expired ? 1 : { increment: 1 },
            lockedUntil: expired ? null : undefined,
          },
        });
        if (updated.loginAttempts >= AUTH_CONFIG.MAX_LOGIN_ATTEMPTS)
          await tx.user.update({
            where: { id: user.id },
            data: { lockedUntil: new Date(now + AUTH_CONFIG.LOCKOUT_TIME_MINUTES * 60000) },
          });
      });
      throw invalidCredentials();
    }
    const accessToken = await sign(this.claims(user));
    const refreshToken = this.cryptography.token();
    await this.repository.$transaction(async (tx) => {
      const latest = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (latest.lockedUntil && latest.lockedUntil.getTime() > this.now())
        throw new DomainError('ACCOUNT_LOCKED', 423, 'アカウントがロックされています');
      await tx.user.update({
        where: { id: user.id },
        data: { loginAttempts: 0, lockedUntil: null },
      });
      await tx.refreshToken.create({ data: this.refreshData(user.id, refreshToken) });
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  /** 古いトークンの消費と次トークンの保存を原子的に行い、同時リプレイを拒否する。 */
  async refresh(
    token: string,
    sign: AccessSigner,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const current = await this.repository.refreshToken.findUnique({
      where: { token },
      include: { user: { select: userSelection } },
    });
    if (!current) throw invalidRefresh();
    if (current.expiresAt.getTime() <= this.now()) {
      await this.repository.refreshToken.deleteMany({ where: { token } });
      throw invalidRefresh();
    }
    const accessToken = await sign(this.claims(current.user));
    const refreshToken = this.cryptography.token();
    await this.repository.$transaction(async (tx) => {
      const consumed = await tx.refreshToken.deleteMany({
        where: { token, expiresAt: { gt: new Date(this.now()) } },
      });
      if (consumed.count !== 1) throw invalidRefresh();
      await tx.refreshToken.create({ data: this.refreshData(current.userId, refreshToken) });
    });
    return { accessToken, refreshToken, expiresIn: AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES * 60 };
  }

  /** 所有者を条件に含めてセッションを失効する。 */
  async logout(
    userId: number,
    input: { refreshToken?: string; logoutAll?: boolean },
  ): Promise<{ message: string }> {
    if (input.logoutAll) {
      await this.repository.refreshToken.deleteMany({ where: { userId } });
      return { message: 'すべてのデバイスからログアウトしました' };
    }
    if (!input.refreshToken)
      throw new DomainError(
        'REFRESH_TOKEN_REQUIRED',
        400,
        'リフレッシュトークンまたは logoutAll フラグが必要です',
      );
    const revoked = await this.repository.refreshToken.deleteMany({
      where: { userId, token: input.refreshToken },
    });
    if (!revoked.count)
      throw new DomainError(
        'REFRESH_TOKEN_NOT_OWNED',
        400,
        '指定されたリフレッシュトークンは無効または他のユーザーに属しています',
      );
    return { message: 'ログアウトしました' };
  }

  private claims(user: AuthUser): AccessClaims {
    return {
      userId: user.id,
      role: user.role,
      type: 'access',
      exp: Math.floor(this.now() / 1000) + AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    };
  }
  private refreshData(
    userId: number,
    token: string,
  ): { userId: number; token: string; expiresAt: Date } {
    return {
      userId,
      token,
      expiresAt: new Date(this.now() + AUTH_CONFIG.REFRESH_TOKEN_EXPIRE_DAYS * 86400000),
    };
  }
}
