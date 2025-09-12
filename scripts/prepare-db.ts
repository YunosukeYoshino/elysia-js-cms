import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function prepareDatabase(mode: 'development' | 'test' = 'development') {
  console.log(`🔧 Preparing ${mode} database...`);

  const prisma = new PrismaClient({
    log: mode === 'test' ? [] : ['warn', 'error'],
  });

  try {
    // Ensure database file path is absolute and consistent
    const dbPath = path.resolve(process.cwd(), mode === 'test' ? 'test.db' : 'dev.db');

    // Optionally remove existing database for clean state in test mode
    if (mode === 'test' && fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log(`🗑️ Removed existing ${mode} database`);
    }

    // Apply migrations
    await prisma.$connect();

    // Verify and log current database state
    const tables = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table';`;
    console.log('🗃️ Current database tables:', tables);

    // Additional schema validation
    const requiredTables = ['User', 'RefreshToken'];
    const missingTables = requiredTables.filter(
      (table) => !tables.some((t: { name: string }) => t.name === table),
    );

    if (missingTables.length > 0) {
      console.warn(`⚠️ Missing tables: ${missingTables.join(', ')}`);

      // Optional: Attempt to create missing tables
      if (mode === 'test') {
        console.log('🛠️ Attempting to create missing tables...');
        await prisma.$executeRaw`
          CREATE TABLE IF NOT EXISTS "User" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "email" TEXT NOT NULL,
            "password" TEXT NOT NULL,
            "name" TEXT,
            "role" TEXT NOT NULL DEFAULT 'user',
            "loginAttempts" INTEGER NOT NULL DEFAULT 0,
            "lockedUntil" DATETIME,
            "passwordResetToken" TEXT,
            "passwordResetExpires" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `;
        await prisma.$executeRaw`
          CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
        `;
        await prisma.$executeRaw`
          CREATE TABLE IF NOT EXISTS "RefreshToken" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "token" TEXT NOT NULL,
            "userId" INTEGER NOT NULL,
            "expiresAt" DATETIME NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
          );
        `;
        await prisma.$executeRaw`
          CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_token_key" ON "RefreshToken"("token");
        `;
      }
    }

    console.log(`✅ ${mode.toUpperCase()} database prepared successfully`);
  } catch (error) {
    console.error(`❌ Database preparation failed for ${mode}:`, error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Allow running directly or importing
if (import.meta.main) {
  const mode = (process.argv[2] as 'development' | 'test') || 'development';
  prepareDatabase(mode);
}

export default prepareDatabase;
