import type {
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  ProfileResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterRequest,
  User,
} from '../types/auth';
import {
  AUTH_CONFIG,
  checkAccountLockByEmail,
  createRefreshToken,
  incrementLoginAttempts,
  resetLoginAttempts,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  revokeRefreshTokenSecure,
  validateRefreshToken,
} from '../utils/auth-security';
import {
  generateSecureToken,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../utils/password';
import { BaseService } from './base-service';

/**
 * Authentication service
 * Handles all authentication-related business logic
 */
export class AuthService extends BaseService {
  /**
   * Register a new user
   */
  async register(userData: RegisterRequest): Promise<User> {
    try {
      const { email, password, name } = userData;

      // Check if user already exists
      const existingUser = await this.prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        throw new Error('EMAIL_ALREADY_EXISTS');
      }

      // Validate password strength
      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.isValid) {
        throw new Error('VALIDATION_ERROR');
      }

      // Hash password
      const { hash } = await hashPassword(password);

      // Create user
      const user = await this.prisma.user.create({
        data: {
          email,
          password: hash,
          name: name || null,
          role: 'user',
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
        },
      });

      this.log(`User registered: ${user.email}`);
      return user as User;
    } catch (error) {
      this.handleError(error, 'AuthService.register');
    }
  }

  /**
   * Login user and generate tokens
   */
  async login(
    credentials: LoginRequest,
    jwtSign: (payload: object, options?: object) => Promise<string>,
  ): Promise<LoginResponse> {
    try {
      const { email, password } = credentials;

      // Find user
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        throw new Error('INVALID_CREDENTIALS');
      }

      // Check account lock status
      const { isLocked, lockedUntil } = await checkAccountLockByEmail(email);
      if (isLocked && lockedUntil) {
        throw new Error('ACCOUNT_LOCKED');
      }

      // Verify password
      const passwordValid = await verifyPassword(password, user.password);

      if (!passwordValid) {
        await incrementLoginAttempts(user.id);
        throw new Error('INVALID_CREDENTIALS');
      }

      // Reset login attempts on successful login
      await resetLoginAttempts(user.id);

      // Generate access token
      const accessToken = await jwtSign(
        {
          userId: user.id,
          role: user.role,
          type: 'access',
        },
        {
          expiresIn: `${AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES}m`,
        },
      );

      // Generate refresh token
      const refreshToken = generateSecureToken(64);
      await createRefreshToken(user.id, refreshToken);

      this.log(`User logged in: ${user.email}`);

      return {
        accessToken,
        refreshToken,
        expiresIn: AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    } catch (error) {
      this.handleError(error, 'AuthService.login');
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(
    refreshTokenData: RefreshRequest,
    jwtSign: (payload: object, options?: object) => Promise<string>,
  ): Promise<RefreshResponse> {
    try {
      const { refreshToken } = refreshTokenData;

      // Validate refresh token
      const tokenData = await validateRefreshToken(refreshToken);
      if (!tokenData) {
        throw new Error('TOKEN_INVALID');
      }

      // Get user
      const user = await this.prisma.user.findUnique({
        where: { id: tokenData.userId },
        select: { id: true, email: true, name: true, role: true },
      });

      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      // Generate new access token
      const accessToken = await jwtSign(
        {
          userId: user.id,
          role: user.role,
          type: 'access',
        },
        {
          expiresIn: `${AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES}m`,
        },
      );

      // Revoke old refresh token and create new one
      await revokeRefreshToken(refreshToken);
      const newRefreshToken = generateSecureToken(64);
      await createRefreshToken(user.id, newRefreshToken);

      return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
      };
    } catch (error) {
      this.handleError(error, 'AuthService.refreshToken');
    }
  }

  /**
   * Logout user by revoking tokens
   */
  async logout(logoutData: LogoutRequest, userId: number): Promise<{ message: string }> {
    try {
      const { refreshToken, logoutAll } = logoutData;

      if (logoutAll) {
        await revokeAllRefreshTokens(userId);
        return { message: 'すべてのデバイスからログアウトしました' };
      } else if (refreshToken) {
        const revoked = await revokeRefreshTokenSecure(refreshToken, userId);
        if (!revoked) {
          throw new Error('TOKEN_INVALID');
        }
        return { message: 'ログアウトしました' };
      } else {
        throw new Error('REQUIRED_FIELD_MISSING');
      }
    } catch (error) {
      this.handleError(error, 'AuthService.logout');
    }
  }

  /**
   * Get user profile
   */
  async getProfile(userId: number): Promise<ProfileResponse> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
        },
      });

      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      return { user: user as User };
    } catch (error) {
      this.handleError(error, 'AuthService.getProfile');
    }
  }
}
