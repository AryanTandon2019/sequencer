import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from 'dotenv';

import { assertNonProductionDatabase } from '../application/test-mode-runtime.js';
import { createNeonTransaction } from './neon.js';
import { splitSqlMigration } from './sql-migration.js';

config({ path: ['.env.local', '.env'], quiet: true });
assertNonProductionDatabase();

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.trim().length === 0) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const migrationPath = resolve('db/migrations/001_test_mode_action_queue.sql');
const migration = await readFile(migrationPath, 'utf8');
const statements = splitSqlMigration(migration);
const transaction = createNeonTransaction(connectionString);
await transaction(statements);
console.log('Applied 001_test_mode_action_queue.sql');
