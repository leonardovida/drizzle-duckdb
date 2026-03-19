import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '../src/index';
import { introspect } from '../src/introspect';
import { expect, test } from 'vitest';

test('introspect returns empty results for an unknown database', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    const db = drizzle(connection);
    const result = await introspect(db, { database: 'missing_catalog' });

    expect(result.files.metaJson).toEqual([]);
  } finally {
    connection.closeSync();
  }
});
