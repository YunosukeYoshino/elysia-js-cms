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
 * 型安全なモデル定義として改善
 */
export const ApiModels = {
  Auth: {
    User: 'User' as const,
    RegisterRequest: 'RegisterRequest' as const,
    LoginRequest: 'LoginRequest' as const,
    LoginResponse: 'LoginResponse' as const,
    RefreshRequest: 'RefreshRequest' as const,
    RefreshResponse: 'RefreshResponse' as const,
    LogoutRequest: 'LogoutRequest' as const,
    ProfileResponse: 'ProfileResponse' as const,
  },
} as const;

/**
 * 型安全なモデルアクセサー
 */
export type AuthModelType = typeof ApiModels.Auth;
export type AuthModelKeys = keyof AuthModelType;

/**
 * 型マッピング
 */
export type AuthTypeMap = {
  User: User;
  RegisterRequest: RegisterRequest;
  LoginRequest: LoginRequest;
  LoginResponse: LoginResponse;
  RefreshRequest: RefreshRequest;
  RefreshResponse: RefreshResponse;
  LogoutRequest: LogoutRequest;
  ProfileResponse: ProfileResponse;
};
