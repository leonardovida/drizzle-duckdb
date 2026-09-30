import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import { bigint, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';
import { introspect } from '../src/introspect.ts';
import { wrapList } from '../src/value-wrappers.ts';

let instance: DuckDBInstance;
let db: DuckDBDatabase;
const parents = pgTable('sweep_parents', { id: integer('id') });
const children = pgTable('sweep_children', {
  id: integer('id'),
  note: text('note'),
});

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  db = drizzle(await instance.connect());
  await db.execute(sql`
    create table sweep_parents(id integer);
    insert into sweep_parents values(1),(2);
    create table sweep_children(id integer,note varchar);
    insert into sweep_children values(1,null),(3,'unmatched');
    create table sweep_a(id integer,parent_id integer);
    insert into sweep_a values(1,1);
    create table sweep_b(key integer);
    insert into sweep_b values(1);
    create table sweep_big(id bigint);
    create table sweep_fixed(v integer[2]);
    insert into sweep_fixed values ([1,2]);
    insert into sweep_big values(-9223372036854775808),(9007199254740991),(9007199254740993),(9223372036854775807);
    attach ':memory:' as sweep_other;
    create table sweep_other.main.only_other(id integer);
  `);
});
afterAll(async () => {
  await db.close();
  instance.closeSync();
});

test.each(['left', 'full'] as const)(
  'join nullification is field-order invariant for %s joins',
  async (join) => {
    for (const aliased of [false, true]) {
      const id = aliased
        ? sql`${children.id}`.mapWith(children.id).as('child_id')
        : children.id;
      const note = aliased
        ? sql`${children.note}`.mapWith(children.note).as('child_note')
        : children.note;
      const selections = [{ child: { note, id } }, { child: { id, note } }];
      const results = [];
      for (const selection of selections) {
        const query = db.select(selection).from(parents);
        results.push(
          await (
            join === 'left'
              ? query.leftJoin(children, eq(parents.id, children.id))
              : query.fullJoin(children, eq(parents.id, children.id))
          ).orderBy(parents.id)
        );
      }
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toContainEqual({ child: { id: 1, note: null } });
      expect(results[0]).toContainEqual({ child: null });
    }
  }
);

test('valid raw joins retain DuckDB column ownership', async () => {
  for (const query of [
    'select sweep_a.id from sweep_a join sweep_b on sweep_a.parent_id = id',
    'select sweep_a.id from sweep_a join sweep_b on id = sweep_a.parent_id where id = 1 order by id',
    'select id,count(*) as n from sweep_a join sweep_b on sweep_a.parent_id = id group by id having count(*) = 1',
    '(select id from sweep_a join sweep_b on sweep_a.parent_id = id) union all (select id from sweep_a)',
  ]) {
    const native = await (
      await (db.$client as Awaited<ReturnType<DuckDBInstance['connect']>>).run(
        query
      )
    ).getRowsJS();
    const adapted = await db.execute(sql.raw(query));
    expect(adapted.map((row) => Object.values(row))).toEqual(native);
  }
});

test.each([
  { value: [] },
  { value: ['a', 'b'] },
  { value: ['1', '2', '3'] },
  { value: null },
])('array bounds preserve bound values: $value', async ({ value }) => {
  const parameter = value === null ? null : wrapList(value, 'VARCHAR');
  const [row] = await db.execute(
    sql`select array_upper(${parameter},1) as upper_bound, array_lower(${parameter},1) as lower_bound`
  );
  expect(row).toEqual({
    upper_bound: value?.length ? BigInt(value.length) : null,
    lower_bound: value?.length ? 1 : null,
  });
});

test('array_upper supports string literals and fixed arrays', async () => {
  expect(
    await db.execute(
      sql`select array_upper(ARRAY['a','b'],1) as n, array_upper(v,1) as fixed from sweep_fixed`
    )
  ).toEqual([{ n: 2n, fixed: 2n }]);
});

test('array bounds rewrite each volatile expression once across query clauses', async () => {
  await db.execute(sql`create sequence sweep_bounds_sequence`);
  expect(
    await db.execute(
      sql`select array_upper(ARRAY[nextval('sweep_bounds_sequence')],1) as n`
    )
  ).toEqual([{ n: 1n }]);
  expect(
    await db.execute(sql`select currval('sweep_bounds_sequence') as n`)
  ).toEqual([{ n: 1n }]);
  expect(
    await db.execute(
      sql`select array_upper(ARRAY[nextval('sweep_bounds_sequence')],1) as n from range(3)`
    )
  ).toEqual([{ n: 1n }, { n: 1n }, { n: 1n }]);
  expect(
    await db.execute(sql`select currval('sweep_bounds_sequence') as n`)
  ).toEqual([{ n: 4n }]);
  const query =
    "with bounds as (select ARRAY['a','b'] as items) select array_upper(items,1) as n from bounds where array_lower(items,1)=1 group by items having array_upper(items,1)=2 order by array_upper(items,1)";
  expect(await db.execute(sql.raw(query))).toEqual([{ n: 2n }]);
});

test('explicit database takes precedence over allDatabases', async () => {
  const result = await introspect(db, {
    database: 'sweep_other',
    allDatabases: true,
  });
  expect(result.files.metaJson.map((t) => [t.database, t.name])).toEqual([
    ['sweep_other', 'only_other'],
  ]);
});

test('introspection preserves BIGINT extrema and supports explicit number mode', async () => {
  const generated = await introspect(db);
  expect(generated.files.schemaTs).toContain(
    'bigint("id", { mode: \'bigint\' })'
  );
  const table = pgTable('sweep_big', { id: bigint('id', { mode: 'bigint' }) });
  const boundaries = [
    -9223372036854775808n,
    -9007199254740993n,
    9007199254740991n,
    9007199254740992n,
    9007199254740993n,
    9223372036854775807n,
  ];
  await db.delete(table);
  await db.insert(table).values(boundaries.map((id) => ({ id })));
  expect(
    (await db.select().from(table).orderBy(table.id)).map((r) => r.id)
  ).toEqual(boundaries);
  expect(
    (await introspect(db, { bigintMode: 'number' })).files.schemaTs
  ).toContain('bigint("id", { mode: \'number\' })');
});
