/**
 * Secure backup utility for sensitive data migration
 * Provides encrypted backup functionality to prevent data breaches
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

/**
 * Generate a secure encryption key for backups
 *
 * @returns Base64 encoded encryption key
 */
export function generateBackupKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Create encrypted backup with sensitive data protection
 *
 * @param data - Data to backup
 * @param options - Backup configuration options
 * @returns Path to created backup file
 */
export async function createSecureBackup<T = Record<string, unknown>>(
  data: T[],
  options: BackupOptions = {},
): Promise<string> {
  const {
    encrypt = true,
    encryptionKey,
    includePasswords = false,
    backupPath = `backup-users-${Date.now()}.${encrypt ? 'enc' : 'json'}`,
  } = options;

  // Sanitize data to remove sensitive information
  const sanitizedData = data.map((record) => {
    const sanitized = { ...record };

    if (!includePasswords && 'password' in sanitized) {
      // Remove password field for security
      delete sanitized.password;
    }

    return sanitized;
  });

  const backupData: SecureBackupData = {
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

    // Log encryption key securely (in production, should be stored in secure key management)
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
 * Restore data from secure backup
 *
 * @param backupPath - Path to backup file
 * @param encryptionKey - Decryption key (required for encrypted backups)
 * @returns Restored data
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

  const backupData = JSON.parse(jsonData) as SecureBackupData;

  console.log(`📂 Backup restored from: ${backupPath}`);
  console.log(`🕒 Created: ${backupData.metadata.timestamp}`);
  console.log(`📊 Records: ${backupData.metadata.recordCount}`);
  console.log(`🔒 Was encrypted: ${backupData.metadata.encrypted ? 'Yes' : 'No'}`);

  return backupData;
}

/**
 * Securely delete backup file
 *
 * @param backupPath - Path to backup file to delete
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
 * Encrypt backup data using AES-256-CBC
 *
 * @param data - Data to encrypt
 * @param key - Encryption key
 * @returns Encrypted data
 */
async function encryptBackup(data: string, key: string): Promise<string> {
  const algorithm = 'aes-256-cbc';
  const iv = randomBytes(16);

  // Create a proper key from the input string
  const keyBuffer =
    Buffer.from(key, 'base64').length >= 32
      ? Buffer.from(key, 'base64').subarray(0, 32)
      : Buffer.concat([Buffer.from(key, 'utf8'), Buffer.alloc(32)]).subarray(0, 32);

  const cipher = createCipheriv(algorithm, keyBuffer, iv);

  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Prepend IV for decryption
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt backup data using AES-256-CBC
 *
 * @param encryptedData - Encrypted data to decrypt
 * @param key - Decryption key
 * @returns Decrypted data
 */
async function decryptBackup(encryptedData: string, key: string): Promise<string> {
  const algorithm = 'aes-256-cbc';
  const parts = encryptedData.split(':');

  if (parts.length !== 2) {
    throw new Error('Invalid encrypted backup format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];

  // Create a proper key from the input string
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
 * Validate backup file integrity
 *
 * @param backupPath - Path to backup file
 * @param encryptionKey - Decryption key (if encrypted)
 * @returns Validation result
 */
export async function validateBackup(
  backupPath: string,
  encryptionKey?: string,
): Promise<{ valid: boolean; metadata?: BackupMetadata; error?: string }> {
  try {
    const backupData = await restoreSecureBackup(backupPath, encryptionKey);

    // Basic validation
    if (!backupData.metadata || !Array.isArray(backupData.data)) {
      return { valid: false, error: 'Invalid backup structure' };
    }

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
