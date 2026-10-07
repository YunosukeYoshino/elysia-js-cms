/**
 * 機密データ移行のためのセキュアバックアップユーティリティ
 * データ漏洩を防ぐための暗号化バックアップ機能を提供
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';

interface BackupOptions {
  encrypt?: boolean;
  encryptionKey?: string;
  includePasswords?: boolean;
  backupPath?: string;
}

interface BackupMetadata {
  timestamp: string;
  version: string;
  encrypted: boolean;
  includesPasswords: boolean;
  recordCount: number;
}

interface SecureBackupData<T = Record<string, unknown>> {
  metadata: BackupMetadata;
  data: T[];
}

type BackupValidation = { valid: true; metadata: BackupMetadata } | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBackupMetadata(value: unknown): value is BackupMetadata {
  return (
    isRecord(value) &&
    typeof value.timestamp === 'string' &&
    typeof value.version === 'string' &&
    typeof value.encrypted === 'boolean' &&
    typeof value.includesPasswords === 'boolean' &&
    typeof value.recordCount === 'number'
  );
}

function isSecureBackupData(value: unknown): value is SecureBackupData {
  return (
    isRecord(value) &&
    isBackupMetadata(value.metadata) &&
    Array.isArray(value.data) &&
    value.data.every(isRecord)
  );
}

/**
 * バックアップ用の安全な暗号化キーを生成
 *
 * @returns Base64エンコードされた暗号化キー
 */
export function generateBackupKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * 機密データ保護付きの暗号化バックアップを作成
 *
 * @param data - バックアップするデータ
 * @param options - バックアップ構成オプション
 * @returns 作成されたバックアップファイルへのパス
 */
export async function createSecureBackup<T extends object = Record<string, unknown>>(
  data: T[],
  options: BackupOptions = {},
): Promise<string> {
  const {
    encrypt = true,
    encryptionKey,
    includePasswords = false,
    backupPath = `backup-users-${Date.now()}.${encrypt ? 'enc' : 'json'}`,
  } = options;

  // 機密情報を削除してデータをサニタイズ
  const sanitizedData = data.map((record) => {
    const sanitized: Partial<T> = { ...record };

    if (!includePasswords && 'password' in sanitized) {
      // セキュリティのためパスワードフィールドを削除
      delete sanitized.password;
    }

    return sanitized;
  });

  const backupData: SecureBackupData<Partial<T>> = {
    metadata: {
      timestamp: new Date().toISOString(),
      version: '1.0',
      encrypted: encrypt,
      includesPasswords: includePasswords,
      recordCount: sanitizedData.length,
    },
    data: sanitizedData,
  };

  const jsonData = JSON.stringify(backupData, null, 2);

  if (encrypt) {
    const key = encryptionKey || generateBackupKey();
    const encrypted = await encryptBackup(jsonData, key);

    await writeFile(backupPath, encrypted);

    // 暗号化キーを安全にログ出力（本番環境では安全なキー管理に保存すべき）
    console.log(`🔐 Backup encrypted with key: ${key}`);
    console.log(`⚠️  IMPORTANT: Store this key securely. It's required for backup restoration.`);
  } else {
    await writeFile(backupPath, jsonData);

    if (includePasswords) {
      console.log(
        '⚠️  WARNING: Unencrypted backup contains sensitive data. Secure this file immediately.',
      );
    }
  }

  console.log(`💾 Backup created: ${backupPath}`);
  console.log(`📊 Records backed up: ${sanitizedData.length}`);
  console.log(`🔒 Encrypted: ${encrypt ? 'Yes' : 'No'}`);
  console.log(`🔑 Includes passwords: ${includePasswords ? 'Yes' : 'No'}`);

  return backupPath;
}

/**
 * セキュアバックアップからデータを復元
 *
 * @param backupPath - バックアップファイルへのパス
 * @param encryptionKey - 復号化キー（暗号化バックアップの場合は必須）
 * @returns 復元されたデータ
 */
export async function restoreSecureBackup(
  backupPath: string,
  encryptionKey?: string,
): Promise<SecureBackupData> {
  const fileContent = await readFile(backupPath, 'utf8');

  let jsonData: string;

  if (backupPath.endsWith('.enc')) {
    if (!encryptionKey) {
      throw new Error('Encryption key required for encrypted backup restoration');
    }
    jsonData = await decryptBackup(fileContent, encryptionKey);
  } else {
    jsonData = fileContent;
  }

  const backupData: unknown = JSON.parse(jsonData);
  if (!isSecureBackupData(backupData)) {
    throw new Error('Invalid backup structure');
  }

  console.log(`📂 Backup restored from: ${backupPath}`);
  console.log(`🕒 Created: ${backupData.metadata.timestamp}`);
  console.log(`📊 Records: ${backupData.metadata.recordCount}`);
  console.log(`🔒 Was encrypted: ${backupData.metadata.encrypted ? 'Yes' : 'No'}`);

  return backupData;
}

/**
 * バックアップファイルを安全に削除
 *
 * @param backupPath - 削除するバックアップファイルへのパス
 */
export async function secureDeleteBackup(backupPath: string): Promise<void> {
  try {
    await unlink(backupPath);
    console.log(`🗑️  Backup file deleted: ${backupPath}`);
  } catch (error) {
    console.error(`❌ Failed to delete backup file: ${error}`);
    throw error;
  }
}

/**
 * AES-256-CBCを使用してバックアップデータを暗号化
 *
 * @param data - 暗号化するデータ
 * @param key - 暗号化キー
 * @returns 暗号化されたデータ
 */
async function encryptBackup(data: string, key: string): Promise<string> {
  const algorithm = 'aes-256-cbc';
  const iv = randomBytes(16);

  // 入力文字列から適切なキーを作成
  const keyBuffer =
    Buffer.from(key, 'base64').length >= 32
      ? Buffer.from(key, 'base64').subarray(0, 32)
      : Buffer.concat([Buffer.from(key, 'utf8'), Buffer.alloc(32)]).subarray(0, 32);

  const cipher = createCipheriv(algorithm, keyBuffer, iv);

  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // 復号化のためにIVを先頭に付加
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * AES-256-CBCを使用してバックアップデータを復号化
 *
 * @param encryptedData - 復号化する暗号化データ
 * @param key - 復号化キー
 * @returns 復号化されたデータ
 */
async function decryptBackup(encryptedData: string, key: string): Promise<string> {
  const algorithm = 'aes-256-cbc';
  const [ivHex, encrypted, ...rest] = encryptedData.split(':');

  if (ivHex === undefined || encrypted === undefined || rest.length > 0) {
    throw new Error('Invalid encrypted backup format');
  }

  const iv = Buffer.from(ivHex, 'hex');

  // 入力文字列から適切なキーを作成
  const keyBuffer =
    Buffer.from(key, 'base64').length >= 32
      ? Buffer.from(key, 'base64').subarray(0, 32)
      : Buffer.concat([Buffer.from(key, 'utf8'), Buffer.alloc(32)]).subarray(0, 32);

  const decipher = createDecipheriv(algorithm, keyBuffer, iv);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * バックアップファイルの完全性を検証
 *
 * @param backupPath - バックアップファイルへのパス
 * @param encryptionKey - 復号化キー（暗号化されている場合）
 * @returns 検証結果
 */
export async function validateBackup(
  backupPath: string,
  encryptionKey?: string,
): Promise<BackupValidation> {
  try {
    // 構造の検証は restoreSecureBackup が行う
    const backupData = await restoreSecureBackup(backupPath, encryptionKey);

    if (backupData.data.length !== backupData.metadata.recordCount) {
      return {
        valid: false,
        error: `Record count mismatch: expected ${backupData.metadata.recordCount}, got ${backupData.data.length}`,
      };
    }

    return { valid: true, metadata: backupData.metadata };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}
