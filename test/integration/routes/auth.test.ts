import { describe, expect, it, beforeAll } from 'bun:test';
import { Elysia } from 'elysia';
import { authRouter } from '../../../src/routes/auth';
import { PrismaClient } from '@prisma/client';
import { generateTestToken, testClient } from '../../helpers';

describe('Auth Routes Integration Tests', () => {
  let app: Elysia;
  let prisma: PrismaClient;
  
  beforeAll(async () => {
    prisma = new PrismaClient();
    app = new Elysia().use(authRouter);
    
    // テストデータを初期化
    await prisma.user.upsert({
      where: { email: 'test.integration@example.com' },
      update: {},
      create: {
        email: 'test.integration@example.com',
        password: 'password123',
        name: 'Integration Test User',
        role: 'user'
      }
    });
  });
  
  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const client = testClient(app);
      
      const response = await client.post('/auth/register', {
        email: `new.user.${Date.now()}@example.com`,
        password: 'password123',
        name: 'New Test User'
      });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('email');
    });
    
    it('should return 400 when registering with an existing email', async () => {
      const client = testClient(app);
      
      const response = await client.post('/auth/register', {
        email: 'test.integration@example.com', // 既存ユーザー
        password: 'password123',
        name: 'Duplicate User'
      });
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });
  
  describe('POST /auth/login', () => {
    it('should login successfully with correct credentials', async () => {
      const client = testClient(app);
      
      const response = await client.post('/auth/login', {
        email: 'test.integration@example.com',
        password: 'password123'
      });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('email', 'test.integration@example.com');
    });
    
    it('should return 401 with incorrect password', async () => {
      const client = testClient(app);
      
      const response = await client.post('/auth/login', {
        email: 'test.integration@example.com',
        password: 'wrongpassword'
      });
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });
    
    it('should return 401 with non-existent email', async () => {
      const client = testClient(app);
      
      const response = await client.post('/auth/login', {
        email: 'nonexistent@example.com',
        password: 'password123'
      });
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });
  });
  
  describe('GET /auth/me', () => {
    it('should return user info with valid token', async () => {
      // テストユーザーのIDを取得
      const testUser = await prisma.user.findUnique({
        where: { email: 'test.integration@example.com' }
      });
      
      expect(testUser).not.toBeNull();
      
      // 有効なトークンを生成
      const token = await generateTestToken(testUser!.id);
      const client = testClient(app);
      
      const response = await client.get('/auth/me', token);
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('email', 'test.integration@example.com');
    });
    
    it('should return 401 with invalid token', async () => {
      const client = testClient(app);
      
      const response = await client.get('/auth/me', 'invalid.token.here');
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });
    
    it('should return 401 without a token', async () => {
      const client = testClient(app);
      
      const response = await client.get('/auth/me');
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });
  });
});
