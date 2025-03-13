import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import request from 'supertest';
import { type App } from '../src/index';

// JWTトークンを生成するヘルパー関数
export async function generateTestToken(userId: number, role: 'admin' | 'user' = 'user') {
  const jwtPlugin = jwt({
    name: 'jwt',
    secret: process.env.JWT_SECRET || 'test-secret-key-for-testing-only'
  });
  
  const app = new Elysia().use(jwtPlugin);
  const token = await app.jwt.sign({ userId, role });
  return token;
}

// アプリケーションのエンドポイントに対してリクエストを送信するヘルパー
export function testClient(app: App) {
  return {
    // GETリクエストを送信
    get: (url: string, token?: string) => {
      const req = request(app.server).get(url);
      if (token) {
        req.set('Authorization', `Bearer ${token}`);
      }
      return req;
    },
    
    // POSTリクエストを送信
    post: (url: string, data?: Record<string, any>, token?: string) => {
      const req = request(app.server).post(url).send(data);
      if (token) {
        req.set('Authorization', `Bearer ${token}`);
      }
      return req;
    },
    
    // PUTリクエストを送信
    put: (url: string, data?: Record<string, any>, token?: string) => {
      const req = request(app.server).put(url).send(data);
      if (token) {
        req.set('Authorization', `Bearer ${token}`);
      }
      return req;
    },
    
    // DELETEリクエストを送信
    delete: (url: string, token?: string) => {
      const req = request(app.server).delete(url);
      if (token) {
        req.set('Authorization', `Bearer ${token}`);
      }
      return req;
    },
    
    // ファイルアップロードリクエストを送信
    upload: (url: string, filePath: string, fieldName: string = 'file', token?: string) => {
      const req = request(app.server).post(url).attach(fieldName, filePath);
      if (token) {
        req.set('Authorization', `Bearer ${token}`);
      }
      return req;
    }
  };
}
