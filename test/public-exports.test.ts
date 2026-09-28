import { expect, expectTypeOf, test } from 'vitest';
import * as publicApi from '../src/index.ts';
import type { DuckDbMigrationConfig } from '../src/index.ts';

test('types used in public signatures are exported by name', async () => {
  expect(publicApi.DuckDBDialect).toBeTypeOf('function');
  expect(publicApi.DuckDBSelectBuilder).toBeTypeOf('function');
  expectTypeOf<DuckDbMigrationConfig>().toEqualTypeOf<
    Parameters<typeof publicApi.migrate>[1]
  >();

  const db = await publicApi.drizzle(':memory:');
  try {
    expect(db.dialect).toBeInstanceOf(publicApi.DuckDBDialect);
    expect(db.select()).toBeInstanceOf(publicApi.DuckDBSelectBuilder);
  } finally {
    await db.close();
  }
});
