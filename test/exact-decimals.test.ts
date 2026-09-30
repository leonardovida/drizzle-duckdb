import { DuckDBInstance } from '@duckdb/node-api';
import { relations, sql } from 'drizzle-orm';
import { integer, numeric, pgTable } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import { duckDbList, duckDbMap, duckDbStruct } from '../src/columns.ts';
import { drizzle } from '../src/driver.ts';

const exact = '1234567890123456789012345678.1234567890';
const entries = pgTable('decimal_entries', {
  id: integer('id').primaryKey(),
  amount: numeric('amount', { precision: 38, scale: 10 }),
  amounts: duckDbList<string>('amounts', 'DECIMAL(38,10)'),
  detail: duckDbStruct<{ amount: string }>('detail', {
    amount: 'DECIMAL(38,10)',
  }),
  lookup: duckDbMap<Record<string, string>>('lookup', 'DECIMAL(38,10)', {
    mode: 'object',
  }),
});
const owners = pgTable('decimal_owners', { id: integer('id').primaryKey() });
const entriesRelations = relations(entries, ({ one }) => ({
  owner: one(owners, { fields: [entries.id], references: [owners.id] }),
}));
const ownersRelations = relations(owners, ({ many }) => ({
  entries: many(entries),
}));

test('exact decimal policy agrees across raw, builder, stream and columnar reads', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const db = drizzle(await instance.connect(), {
    decimalMode: 'string',
    prepareCache: true,
    schema: { entries, owners, entriesRelations, ownersRelations },
  });
  const approximate = drizzle(await instance.connect());
  try {
    await db.execute(sql`create table decimal_entries(id integer primary key, amount decimal(38,10),
      amounts decimal(38,10)[], detail struct(amount decimal(38,10)), lookup map(varchar,decimal(38,10)));
      create table decimal_owners(id integer primary key);
      insert into decimal_owners values(1)`);
    await db.insert(entries).values({
      id: 1,
      amount: exact,
      amounts: [exact],
      detail: { amount: exact },
      lookup: { value: exact },
    });
    const query = sql`select * from decimal_entries`;
    const expected = {
      id: 1,
      amount: exact,
      amounts: [exact],
      detail: { amount: exact },
      lookup: { value: exact },
    };
    const rawExpected = {
      ...expected,
      lookup: [{ key: 'value', value: exact }],
    };
    expect(await db.execute(query)).toEqual([rawExpected]);
    expect(await db.execute(query)).toEqual([rawExpected]); // Cached prepared result.
    expect(await db.select().from(entries)).toEqual([expected]);
    expect(await db.query.entries.findMany()).toEqual([expected]);
    const batches = [];
    for await (const batch of db.executeBatches(query, { rowsPerChunk: 1 }))
      batches.push(...batch);
    expect(batches).toEqual([rawExpected]);
    const raw = [];
    for await (const batch of db.executeBatchesRaw(query, { rowsPerChunk: 1 }))
      raw.push(...batch.rows);
    expect(raw).toEqual([Object.values(rawExpected)]);
    expect(await db.executeArrow(query)).toEqual(
      Object.fromEntries(
        Object.entries(rawExpected).map(([name, value]) => [name, [value]])
      )
    );
    expect((await approximate.execute(query))[0]?.amount).toEqual(
      Number(exact)
    );
    expect(
      await db.query.owners.findMany({
        with: { entries: { columns: { id: true, amount: true } } },
      })
    ).toEqual([{ id: 1, entries: [{ id: 1, amount: exact }] }]);
  } finally {
    await db.close();
    await approximate.close();
    instance.closeSync();
  }
});
