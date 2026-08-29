import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import { splitSqlMigration } from './sql-migration.js';

describe('Neon HTTP migration preparation', () => {
  it('splits the checked-in schema into separate transaction statements', async () => {
    const source = await readFile(
      resolve('db/migrations/001_test_mode_action_queue.sql'),
      'utf8',
    );
    const statements = splitSqlMigration(source);
    assert.equal(statements.length, 7);
    assert.equal(statements.every((statement) => !statement.endsWith(';')), true);
    assert.match(statements[0]!, /^CREATE TABLE IF NOT EXISTS razorpay_shadow_events/);
    assert.match(statements.at(-1)!, /^CREATE TABLE IF NOT EXISTS test_mode_action_attempts/);
  });

  it('keeps transaction control in the Neon transaction wrapper', () => {
    assert.throws(
      () => splitSqlMigration('BEGIN; CREATE TABLE example (id integer); COMMIT;'),
      /transaction control/,
    );
  });

  it('rejects an empty migration', () => {
    assert.throws(() => splitSqlMigration(' ; \n ; '), /no SQL statements/);
  });
});
