export function splitSqlMigration(source: string): readonly string[] {
  const statements = source
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  if (statements.length === 0) throw new Error('migration contains no SQL statements');
  for (const statement of statements) {
    if (/^(BEGIN|COMMIT|ROLLBACK)(?:\s+TRANSACTION)?$/iu.test(statement)) {
      throw new Error('transaction control must be owned by the migration runner');
    }
  }
  return statements;
}
