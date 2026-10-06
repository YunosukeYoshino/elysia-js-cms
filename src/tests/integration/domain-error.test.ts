import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Elysia, t } from 'elysia';
import { DomainError } from '../../domain/errors/domain-error';
import { AuthService } from '../../domain/services/auth-service';
import { CategoryService } from '../../domain/services/category-service';
import { domainErrorPlugin } from '../../middlewares/domain-error';
import { createAuthRouter } from '../../routes/auth';
import { createTestDatabase, type TestDatabase } from './helpers';

interface ErrorBody {
  code?: string;
  error?: string;
  details?: string[];
}

describe('Service errors through Elysia lifecycle', () => {
  let fixture: TestDatabase;
  beforeAll(async () => {
    fixture = await createTestDatabase();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('maps actual authentication/category failures to stable HTTP statuses and codes', async () => {
    const auth = new AuthService(fixture.database);
    const categories = new CategoryService(fixture.database);
    const app = new Elysia()
      .use(domainErrorPlugin)
      .get('/missing', () => categories.getById(9999999))
      .get('/invalid', () => categories.getById(-1))
      .get('/login', () =>
        auth.login(
          { email: 'missing@example.invalid', password: 'irrelevant' },
          async () => 'unused',
        ),
      )
      .get('/logout', () => auth.logout(1, {}));
    for (const [path, status, code] of [
      ['/missing', 404, 'CATEGORY_NOT_FOUND'],
      ['/invalid', 422, 'INVALID_CATEGORY_ID'],
      ['/login', 401, 'INVALID_CREDENTIALS'],
      ['/logout', 400, 'REFRESH_TOKEN_REQUIRED'],
    ] satisfies Array<[string, number, string]>) {
      const response = await app.handle(new Request('http://localhost' + path));
      const body: ErrorBody = await response.json();
      expect(response.status).toBe(status);
      expect(body.code).toBe(code);
      expect(body.error).toBeDefined();
    }
  });

  it('preserves 403, 413 and 423 service errors and hides unexpected failure details', async () => {
    const app = new Elysia()
      .use(domainErrorPlugin)
      .get('/forbidden', () => {
        throw new DomainError('FILE_FORBIDDEN', 403, 'Permission denied');
      })
      .get('/large', () => {
        throw new DomainError('UPLOAD_TOO_LARGE', 413, 'Upload too large');
      })
      .get('/locked', () => {
        throw new DomainError('ACCOUNT_LOCKED', 423, 'Account locked');
      })
      .get('/unexpected', () => {
        throw new Error('Private SQL and credentials');
      });
    for (const [path, status, code] of [
      ['/forbidden', 403, 'FILE_FORBIDDEN'],
      ['/large', 413, 'UPLOAD_TOO_LARGE'],
      ['/locked', 423, 'ACCOUNT_LOCKED'],
      ['/unexpected', 500, 'INTERNAL_ERROR'],
    ] satisfies Array<[string, number, string]>) {
      const response = await app.handle(new Request('http://localhost' + path));
      expect(response.status).toBe(status);
      const body: ErrorBody = await response.json();
      expect(body.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain('Private');
    }
  });

  it('keeps Elysia validation/not-found statuses rather than turning them into internal errors', async () => {
    const app = new Elysia()
      .use(domainErrorPlugin)
      .get('/number/:id', ({ params }) => params.id, { params: t.Object({ id: t.Numeric() }) });
    expect((await app.handle(new Request('http://localhost/number/invalid'))).status).toBe(422);
    expect((await app.handle(new Request('http://localhost/absent'))).status).toBe(404);
  });

  it('supports actual auth router DI and preserves password-validation details', async () => {
    const auth = new AuthService(fixture.database);
    const app = new Elysia().use(createAuthRouter({}, auth));
    const request = (body: object) =>
      new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const weak = await app.handle(request({ email: 'http@example.invalid', password: 'password' }));
    expect(weak.status).toBe(400);
    const weakBody: ErrorBody = await weak.json();
    expect(weakBody.code).toBe('WEAK_PASSWORD');
    expect(weakBody.details?.length).toBeGreaterThan(0);
    const registered = await app.handle(
      request({ email: 'http@example.invalid', password: 'CorrectServicePass123!' }),
    );
    expect(registered.status).toBe(200);
    expect(await fixture.database.user.count({ where: { email: 'http@example.invalid' } })).toBe(1);
    const duplicate = await app.handle(
      request({ email: 'http@example.invalid', password: 'CorrectServicePass123!' }),
    );
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()).code).toBe('EMAIL_EXISTS');
  });
});

it('lets the external hierarchy own authentication admission without a second fixed quota', async () => {
  const fixture = await createTestDatabase();
  const service = new AuthService(fixture.database);
  const app = new Elysia().use(createAuthRouter({ externalRateLimit: true }, service));
  try {
    for (let index = 0; index < 5; index++) {
      const response = await app.handle(
        new Request('http://localhost/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'external-admission@example.invalid',
            password: 'ExternalQuotaTest123!',
          }),
        }),
      );
      expect(response.status).toBe(index === 0 ? 200 : 400);
      expect(response.headers.get('X-RateLimit-Limit')).toBeNull();
    }
  } finally {
    await fixture.close();
  }
});
