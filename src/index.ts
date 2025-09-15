import { Elysia } from 'elysia';
import { setupPlugins } from './plugins';
import { authRouter } from './routes/auth';
import { categoriesRouter } from './routes/categories';
import { filesRouter } from './routes/files';
import { postsRouter } from './routes/posts';

/**
 * Get HTTP status text from status code
 */
function getHttpStatusText(statusCode: number): string {
  const statusTexts: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Payload Too Large',
    423: 'Locked',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return statusTexts[statusCode] || 'Unknown Error';
}

const app = new Elysia()
  .onError(({ error, set, request }) => {
    const timestamp = new Date().toISOString();
    const method = request.method;
    const url = new URL(request.url).pathname;
    const isDevelopment = process.env.NODE_ENV === 'development';
    const isTest = process.env.NODE_ENV === 'test';

    // Service error mapping
    const ServiceErrorCodes: Record<string, number> = {
      EMAIL_ALREADY_EXISTS: 409,
      INVALID_CREDENTIALS: 401,
      ACCOUNT_LOCKED: 423,
      TOKEN_INVALID: 401,
      USER_NOT_FOUND: 404,
      REQUIRED_FIELD_MISSING: 400,
      AUTHENTICATION_REQUIRED: 401,
      POST_NOT_FOUND: 404,
      PERMISSION_DENIED: 403,
      CATEGORY_NOT_FOUND: 404,
      SLUG_ALREADY_EXISTS: 409,
      CATEGORY_IN_USE: 400,
      FILE_NOT_FOUND: 404,
      VALIDATION_ERROR: 400,
      DATABASE_ERROR: 500,
      INTERNAL_ERROR: 500,
    };

    const ServiceErrorMessages: Record<string, string> = {
      EMAIL_ALREADY_EXISTS: 'すでに登録されているメールアドレスです',
      INVALID_CREDENTIALS: 'メールアドレスまたはパスワードが正しくありません',
      ACCOUNT_LOCKED: 'アカウントがロックされています',
      TOKEN_INVALID: '無効なトークンです',
      USER_NOT_FOUND: 'ユーザーが見つかりません',
      REQUIRED_FIELD_MISSING: '必須フィールドが不足しています',
      AUTHENTICATION_REQUIRED: '認証が必要です',
      POST_NOT_FOUND: '投稿が見つかりません',
      PERMISSION_DENIED: 'この操作を行う権限がありません',
      CATEGORY_NOT_FOUND: 'カテゴリが見つかりません',
      SLUG_ALREADY_EXISTS: 'このスラッグは既に使用されています',
      CATEGORY_IN_USE: 'このカテゴリは投稿に使用されているため削除できません',
      FILE_NOT_FOUND: 'ファイルが見つかりません',
      VALIDATION_ERROR: 'バリデーションエラーです',
      DATABASE_ERROR: 'データベースエラーが発生しました',
      INTERNAL_ERROR: '内部エラーが発生しました',
    };

    let errorCode = 'INTERNAL_ERROR';
    let statusCode = 500;
    let message = 'Internal server error';

    // Check if it's a known service error
    if (error.message && error.message in ServiceErrorCodes) {
      errorCode = error.message;
      statusCode = ServiceErrorCodes[errorCode];
      message = ServiceErrorMessages[errorCode];
    }
    // Check for Elysia validation errors
    else if (error.code === 'VALIDATION') {
      errorCode = 'VALIDATION_ERROR';
      statusCode = ServiceErrorCodes.VALIDATION_ERROR;
      message = ServiceErrorMessages.VALIDATION_ERROR;
    }

    // Log error (suppress in test environment unless development)
    if (!isTest || isDevelopment) {
      console.error(`[${timestamp}] ${method} ${url} - ${errorCode}:`, error.message);
    }

    set.status = statusCode;

    const response = {
      error: getHttpStatusText(statusCode),
      message,
      code: errorCode,
      timestamp,
    };

    // Add debug information in development
    if (isDevelopment && !isTest) {
      response.details = error.cause;
      response.stack = error.stack;
    }

    return response;
  })
  .use(setupPlugins)
  .get(
    '/',
    () => 'ElysiaJS CMS API - お好みのツールでAPIを探索するには /swagger にアクセスしてください',
  )
  .group('/api', (app) =>
    app.use(authRouter).use(postsRouter).use(categoriesRouter).use(filesRouter),
  );

if (import.meta.main) {
  const port = process.env.PORT || 3001;
  app.listen(port);
  console.log(`🦊 ElysiaJS CMS APIサーバー起動中: ${app.server?.hostname}:${app.server?.port}`);
}

export type App = typeof app;
export default app;
