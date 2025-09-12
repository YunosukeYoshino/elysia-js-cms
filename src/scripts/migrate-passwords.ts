/**
 * 既存ユーザーのパスワードをハッシュ化するマイグレーションスクリプト
 *
 * 使用方法:
 * bun run src/scripts/migrate-passwords.ts
 */

import prisma from '../lib/prisma';
import { hashPassword } from '../utils/password';
import { createSecureBackup, secureDeleteBackup } from '../utils/secure-backup';

async function migratePasswords() {
  console.log('🔄 パスワードマイグレーション開始...');

  try {
    // 平文パスワードを持つユーザーを取得
    // ハッシュ化されたパスワードは ':' を含むため、含まないものを平文と判定
    const users = await prisma.user.findMany({
      where: {
        password: {
          not: {
            contains: ':',
          },
        },
      },
      select: {
        id: true,
        email: true,
        password: true,
      },
    });

    if (users.length === 0) {
      console.log('✅ マイグレーション対象のユーザーはいません。');
      return;
    }

    console.log(`📊 ${users.length}人のユーザーのパスワードをマイグレーションします...`);

    let successCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        console.log(`🔐 ユーザー ${user.email} のパスワードをハッシュ化中...`);

        // パスワードをハッシュ化
        const { hash } = await hashPassword(user.password);

        // データベースを更新
        await prisma.user.update({
          where: { id: user.id },
          data: { password: hash },
        });

        successCount++;
        console.log(`✅ ユーザー ${user.email} のマイグレーション完了`);
      } catch (error) {
        errorCount++;
        console.error(`❌ ユーザー ${user.email} のマイグレーション失敗:`, error);
      }
    }

    console.log('\n📈 マイグレーション結果:');
    console.log(`✅ 成功: ${successCount}人`);
    console.log(`❌ 失敗: ${errorCount}人`);
    console.log(`📊 合計: ${users.length}人`);

    if (errorCount === 0) {
      console.log('\n🎉 すべてのパスワードマイグレーションが完了しました！');
    } else {
      console.log('\n⚠️  一部のマイグレーションが失敗しました。ログを確認してください。');
      process.exit(1);
    }
  } catch (error) {
    console.error('💥 マイグレーション中にエラーが発生しました:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// セキュアバックアップ用のスクリプト
async function createBackup() {
  console.log('💾 ユーザーデータのセキュアバックアップを作成中...');

  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        password: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // セキュアバックアップを作成（暗号化、パスワード除外）
    const backupPath = await createSecureBackup(users, {
      encrypt: true,
      includePasswords: false, // セキュリティ強化: パスワードは含めない
      backupPath: `secure-backup-users-${Date.now()}.enc`,
    });

    return backupPath;
  } catch (error) {
    console.error('❌ セキュアバックアップ作成に失敗しました:', error);
    throw error;
  }
}

async function main() {
  console.log('🚀 パスワードマイグレーションツール (セキュリティ強化版)');
  console.log('======================================================');

  // 引数を確認
  const args = process.argv.slice(2);
  const shouldBackup = !args.includes('--no-backup');
  const dryRun = args.includes('--dry-run');
  const cleanupBackup = args.includes('--cleanup-backup');

  if (dryRun) {
    console.log('🔍 ドライラン モード (実際の変更は行いません)');

    const users = await prisma.user.findMany({
      where: {
        password: {
          not: {
            contains: ':',
          },
        },
      },
      select: {
        id: true,
        email: true,
      },
    });

    console.log(`📊 マイグレーション対象: ${users.length}人`);
    for (const user of users) {
      console.log(`  - ${user.email}`);
    }

    await prisma.$disconnect();
    return;
  }

  let backupPath: string | null = null;

  try {
    // セキュアバックアップ作成
    if (shouldBackup) {
      backupPath = await createBackup();
    }

    // マイグレーション実行
    await migratePasswords();

    // 成功時のバックアップクリーンアップ
    if (cleanupBackup && backupPath) {
      console.log('\n🧹 マイグレーション完了後のバックアップクリーンアップ...');
      await secureDeleteBackup(backupPath);
    } else if (backupPath) {
      console.log(`\n💾 バックアップファイルが保持されています: ${backupPath}`);
      console.log('🔐 暗号化されたバックアップの暗号化キーを安全に保管してください');
    }
  } catch (error) {
    console.error('💥 マイグレーション中にエラーが発生しました:', error);
    if (backupPath) {
      console.log(`💾 バックアップファイル: ${backupPath} - エラー調査のため保持されています`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { migratePasswords, createBackup };
