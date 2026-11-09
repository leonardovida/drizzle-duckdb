import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';
import { getPreparedStatementCacheStats } from '../src/prepared-statement-cache.ts';

const notes = pgTable('cache_notes', {
  id: integer('id').primaryKey(),
  note: text('note'),
});

// DuckDB plans a prepared statement from the statistics at prepare time. A
// statement kept from the empty table returned 's' and 'm' for these notes,
// 0 for the count, and failed the second insert of a deleted key.
test('prepareCache is ignored, so repeated queries see changed data', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const db = drizzle(connection, { prepareCache: true });
    drizzle(connection, { prepareCache: { size: 8 } });
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('prepareCache option is deprecated')
      )
    ).toHaveLength(1);

    await db.execute(
      sql`create table cache_notes(id integer primary key, note varchar)`
    );
    const ordered = () => db.select().from(notes).orderBy(notes.id);
    const above = () =>
      db.execute(sql`select count(*)::int as n from cache_notes where id > 5`);
    expect(await ordered()).toEqual([]);
    expect(await above()).toEqual([{ n: 0 }]);

    await db.insert(notes).values([
      { id: 1, note: 'outer' },
      { id: 2, note: 'inner' },
      { id: 10, note: 'a much longer string value here' },
    ]);
    expect(await ordered()).toEqual([
      { id: 1, note: 'outer' },
      { id: 2, note: 'inner' },
      { id: 10, note: 'a much longer string value here' },
    ]);
    expect(await above()).toEqual([{ n: 1 }]);

    for (const note of ['first', 'second', 'third']) {
      await db.execute(sql`delete from cache_notes where id = 10`);
      await db.insert(notes).values({ id: 10, note });
    }
    expect(await above()).toEqual([{ n: 1 }]);
    expect(getPreparedStatementCacheStats(connection)).toBeUndefined();
  } finally {
    warn.mockRestore();
    connection.closeSync();
  }
});
