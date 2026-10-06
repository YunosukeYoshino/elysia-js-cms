import { Elysia } from 'elysia';
import { DomainError } from '../domain/errors/domain-error';

/** 各ルーターで共有できる名前付き例外変換プラグイン。内部情報を返さない。 */
export const domainErrorPlugin = new Elysia({ name: 'cms.domain-errors' })
  .error({ DOMAIN: DomainError })
  .onError({ as: 'global' }, ({ error, code, set }) => {
    if (error instanceof DomainError) {
      set.status = error.status;
      return {
        error: error.message,
        code: error.code,
        success: false,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      };
    }
    if (code === 'UNKNOWN' && set.status === 429) {
      return { error: 'Too many requests', code: 'RATE_LIMITED' };
    }
    if (code === 'UNKNOWN') {
      set.status = 500;
      return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
    }
  });
