import { neon } from '@neondatabase/serverless';

export type DatabaseRow = Record<string, unknown>;
export type DatabaseQuery = (
  text: string,
  parameters?: readonly unknown[],
) => Promise<readonly DatabaseRow[]>;
export type DatabaseTransaction = (statements: readonly string[]) => Promise<void>;

function checkedConnectionString(connectionString: string): string {
  if (connectionString.trim().length === 0) throw new Error('DATABASE_URL is empty');
  return connectionString;
}

export function createNeonQuery(connectionString: string): DatabaseQuery {
  const sql = neon(checkedConnectionString(connectionString));
  return async (text, parameters = []) => {
    const rows = await sql.query(text, [...parameters]);
    if (!Array.isArray(rows)) throw new Error('database query did not return rows');
    return rows as readonly DatabaseRow[];
  };
}

export function createNeonTransaction(connectionString: string): DatabaseTransaction {
  const sql = neon(checkedConnectionString(connectionString));
  return async (statements) => {
    if (statements.length === 0) throw new Error('migration contains no SQL statements');
    if (statements.some((statement) => statement.trim().length === 0)) {
      throw new Error('migration contains an empty SQL statement');
    }
    await sql.transaction(
      (transaction) => statements.map((statement) => transaction.query(statement)),
      { isolationLevel: 'Serializable', readOnly: false },
    );
  };
}
