import type { DuckDBConnectionPool } from './client.ts';

export interface PgDuckField {
  name: string;
}

export interface PgDuckQueryConfig {
  text: string;
  values?: unknown[];
  rowMode?: 'array';
}

export interface PgDuckQueryResult<TRow = unknown> {
  rows: TRow[];
  fields?: PgDuckField[];
  rowCount?: number | null;
}

export interface PgDuckClient {
  query(
    query: string | PgDuckQueryConfig,
    values?: unknown[]
  ): Promise<PgDuckQueryResult | unknown[]>;
  close?(): Promise<void> | void;
  end?(): Promise<void> | void;
}

export interface PgDuckPoolClient extends PgDuckClient {
  release(): void;
}

export interface PgDuckPool {
  connect(): Promise<PgDuckPoolClient>;
  close?(): Promise<void> | void;
  end?(): Promise<void> | void;
}

export function createPgDuckConnectionPool(
  pool: PgDuckPool
): DuckDBConnectionPool {
  return {
    acquire: () => pool.connect(),
    release(connection) {
      (connection as PgDuckPoolClient).release();
    },
    async close() {
      if (typeof pool.end === 'function') {
        await pool.end();
        return;
      }

      if (typeof pool.close === 'function') {
        await pool.close();
      }
    },
  };
}
