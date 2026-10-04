import { expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { authenticated, isAdmin } from '../middlewares/auth';

for (const role of [null, 'user', 'admin']) {
  it('enforces authentication and administrator access for ' + role, async () => {
    const user = role ? { id: 1, email: 'test@example.com', name: null, role } : null;
    const app = new Elysia()
      .decorate('user', user)
      .get('/private', () => 'ok', { beforeHandle: authenticated })
      .get('/admin', () => 'ok', { beforeHandle: isAdmin });
    expect((await app.handle(new Request('http://localhost/private'))).status).toBe(
      role ? 200 : 401,
    );
    expect((await app.handle(new Request('http://localhost/admin'))).status).toBe(
      role === 'admin' ? 200 : role ? 403 : 401,
    );
  });
}
