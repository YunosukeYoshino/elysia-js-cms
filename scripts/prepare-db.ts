import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';

async function prepareDatabase(mode: 'development' | 'test' = 'development') {
  console.log(`🔧 Preparing ${mode} database...`);

  // Set DATABASE_URL if not already set
  if (mode === 'test' && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:./test.db';
  }

  try {
    // Ensure database file path is absolute and consistent
    const dbPath = path.resolve(process.cwd(), mode === 'test' ? 'test.db' : 'dev.db');

    // Optionally remove existing database for clean state in test mode
    if (mode === 'test' && fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log(`🗑️ Removed existing ${mode} database`);
    }

    // Use Prisma to push the schema to the database
    console.log('🔄 Pushing Prisma schema to database...');
    const env = mode === 'test' ? { ...process.env, NODE_ENV: 'test' } : process.env;
    execSync('bunx prisma db push --skip-generate', {
      stdio: 'inherit',
      env,
    });

    const prisma = new PrismaClient({
      log: mode === 'test' ? [] : ['warn', 'error'],
    });

    // Verify connection and log current database state
    await prisma.$connect();
    
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type='table';`;
    console.log('🗃️ Current database tables:', tables.map(t => t.name).join(', '));

    await prisma.$disconnect();
    console.log(`✅ ${mode.toUpperCase()} database prepared successfully`);
  } catch (error) {
    console.error(`❌ Database preparation failed for ${mode}:`, error);
    process.exit(1);
  }
}

// Allow running directly or importing
if (import.meta.main) {
  const mode = (process.argv[2] as 'development' | 'test') || 'development';
  prepareDatabase(mode);
}

export default prepareDatabase;
