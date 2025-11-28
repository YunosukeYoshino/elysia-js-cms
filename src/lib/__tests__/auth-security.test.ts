/**
 * Auth security utilities tests
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { revokeRefreshTokenSecure } from '../auth-security';
import prisma from '../prisma';

describe('Auth Security', () => {
  let testUserId: number;
  let otherUserId: number;
  let validToken: string;

  beforeEach(async () => {
    // Create test users
    const testUser = await prisma.user.create({
      data: {
        email: 'test@example.com',
        password: 'hashedPassword',
        name: 'Test User',
        role: 'user',
      },
    });
    testUserId = testUser.id;

    const otherUser = await prisma.user.create({
      data: {
        email: 'other@example.com',
        password: 'hashedPassword',
        name: 'Other User',
        role: 'user',
      },
    });
    otherUserId = otherUser.id;

    // Create refresh token for test user
    validToken = `test_refresh_token_${Date.now()}`;
    await prisma.refreshToken.create({
      data: {
        token: validToken,
        userId: testUserId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });
  });

  afterEach(async () => {
    // Clean up test data
    await prisma.refreshToken.deleteMany({
      where: {
        OR: [{ userId: testUserId }, { userId: otherUserId }],
      },
    });

    await prisma.user.deleteMany({
      where: {
        OR: [{ id: testUserId }, { id: otherUserId }],
      },
    });
  });

  describe('revokeRefreshTokenSecure', () => {
    it('should successfully revoke token belonging to the user', async () => {
      const result = await revokeRefreshTokenSecure(validToken, testUserId);
      expect(result).toBe(true);

      // Verify token is deleted
      const deletedToken = await prisma.refreshToken.findUnique({
        where: { token: validToken },
      });
      expect(deletedToken).toBeNull();
    });

    it('should fail to revoke token belonging to different user', async () => {
      const result = await revokeRefreshTokenSecure(validToken, otherUserId);
      expect(result).toBe(false);

      // Verify token still exists
      const existingToken = await prisma.refreshToken.findUnique({
        where: { token: validToken },
      });
      expect(existingToken).not.toBeNull();
      expect(existingToken?.userId).toBe(testUserId);
    });

    it('should fail to revoke non-existent token', async () => {
      const result = await revokeRefreshTokenSecure('non_existent_token', testUserId);
      expect(result).toBe(false);
    });

    it('should handle multiple tokens with same user correctly', async () => {
      // Create another token for the same user
      const anotherToken = `another_test_token_${Date.now()}`;
      await prisma.refreshToken.create({
        data: {
          token: anotherToken,
          userId: testUserId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // Revoke only the first token
      const result = await revokeRefreshTokenSecure(validToken, testUserId);
      expect(result).toBe(true);

      // Verify only the targeted token is deleted
      const deletedToken = await prisma.refreshToken.findUnique({
        where: { token: validToken },
      });
      expect(deletedToken).toBeNull();

      const remainingToken = await prisma.refreshToken.findUnique({
        where: { token: anotherToken },
      });
      expect(remainingToken).not.toBeNull();

      // Clean up
      await prisma.refreshToken.delete({
        where: { token: anotherToken },
      });
    });

    it('should handle concurrent revocation attempts safely', async () => {
      // Simulate concurrent revocation attempts
      const promises = Array.from({ length: 5 }, () =>
        revokeRefreshTokenSecure(validToken, testUserId),
      );

      const results = await Promise.all(promises);

      // Only one should succeed
      const successCount = results.filter((r) => r === true).length;
      expect(successCount).toBe(1);

      // Token should be deleted
      const deletedToken = await prisma.refreshToken.findUnique({
        where: { token: validToken },
      });
      expect(deletedToken).toBeNull();
    });
  });
});
