/**
 * 認証関連の型定義
 * APIリクエスト・レスポンスの型を定義
 */

/**
 * ユーザー情報の型定義
 */
export interface User {
  id: number;
  email: string;
  name: string | null;
  role: string;
}

/**
 * ユーザー登録リクエストの型定義
 */
export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

/**
 * ログインリクエストの型定義
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * ログインレスポンスの型定義
 */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

/**
 * リフレッシュトークンリクエストの型定義
 */
export interface RefreshRequest {
  refreshToken: string;
}

/**
 * リフレッシュトークンレスポンスの型定義
 */
export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * ログアウトリクエストの型定義
 */
export interface LogoutRequest {
  refreshToken?: string;
  logoutAll?: boolean;
}

/**
 * プロフィール取得レスポンスの型定義
 */
export interface ProfileResponse {
  user: User;
}

/**
 * 認証関連のAPIモデル定義
 * 後方互換性のため、staticプロパティを持つオブジェクトとして定義
 */
export const ApiModels = {
  Auth: {
    User: {
      static: {} as User,
    },
    RegisterRequest: {
      static: {} as RegisterRequest,
    },
    LoginRequest: {
      static: {} as LoginRequest,
    },
    LoginResponse: {
      static: {} as LoginResponse,
    },
    RefreshRequest: {
      static: {} as RefreshRequest,
    },
    RefreshResponse: {
      static: {} as RefreshResponse,
    },
    LogoutRequest: {
      static: {} as LogoutRequest,
    },
  },
} as const;
