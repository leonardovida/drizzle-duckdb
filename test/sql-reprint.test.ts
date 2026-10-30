import { DuckDBInstance } from '@duckdb/node-api';
import {
  and,
  arrayContained,
  arrayContains,
  arrayOverlaps,
  eq,
  sql,
} from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { duckDbArrayContains, duckDbList } from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';
import {
  clearTransformCache,
  transformSQL,
} from '../src/sql/ast-transformer.ts';

const docs = pgTable('reprint_docs', {
  id: integer('id'),
  name: text('name'),
  tags: duckDbList<string>('tags', 'VARCHAR'),
  paths: duckDbList<string>('paths', 'VARCHAR'),
});

const owners = pgTable('reprint_owners', {
  id: integer('id'),
  docId: integer('doc_id'),
});

let instance: DuckDBInstance;
let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;
let db: DuckDBDatabase;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);
  await db.execute(
    sql`create table reprint_docs (id integer, name text, tags varchar[], paths varchar[])`
  );
  await db.execute(
    sql`create table reprint_owners (id integer, doc_id integer)`
  );
  await db.insert(docs).values([
    { id: 1, name: 'a', tags: ['x', 'y'], paths: ['C:\\new\\table'] },
    { id: 2, name: 'b', tags: ['z'], paths: ['D:\\other'] },
  ]);
  await db.insert(owners).values([{ id: 7, docId: 1 }]);
});

afterAll(() => {
  connection.closeSync();
});

describe('native array operators', () => {
  test('arrayContains, arrayContained and arrayOverlaps run without rewriting', async () => {
    const query = db
      .select({ id: docs.id })
      .from(docs)
      .where(
        and(
          arrayContains(docs.tags, ['x']),
          arrayContained(docs.tags, ['x', 'y', 'q']),
          arrayOverlaps(docs.tags, ['y', 'w'])
        )
      );
    const { sql: text } = query.toSQL();
    expect(text).toContain('@>');
    expect(text).toContain('<@');
    expect(text).toContain('&&');
    expect(await query).toEqual([{ id: 1 }]);
  });

  test('array operators work in UPDATE and DELETE', async () => {
    const updated = await db
      .update(docs)
      .set({ name: 'tagged' })
      .where(arrayOverlaps(docs.tags, ['z']))
      .returning({ id: docs.id });
    expect(updated).toEqual([{ id: 2 }]);

    const deleted = await db
      .delete(docs)
      .where(arrayContains(docs.tags, ['nope']))
      .returning({ id: docs.id });
    expect(deleted).toEqual([]);
  });
});

describe('AST re-print guard', () => {
  test('backslashes in literals survive when another rewrite applies', async () => {
    const rows = await db
      .select({ id: docs.id })
      .from(docs)
      .where(
        and(
          duckDbArrayContains(docs.paths, ['C:\\new\\table']),
          arrayOverlaps(docs.tags, ['x'])
        )
      );
    expect(rows).toEqual([{ id: 1 }]);

    // A join that needs qualification forces the parser to re-print SQL.
    const joined = await db.execute(
      sql`select ${docs.id} from ${docs} inner join ${owners} on ${docs.id} = "doc_id" where ${docs.paths} = ${sql.raw(`['C:\\new\\table']`)}`
    );
    expect(joined.map((row) => row.id)).toEqual([1]);
  });

  test('IS DISTINCT FROM $n keeps its parameter', async () => {
    const rows = await db
      .select({ id: docs.id })
      .from(docs)
      .innerJoin(owners, sql`${docs.id} = "doc_id"`)
      .where(sql`${docs.name} is distinct from ${'zzz'}`);
    expect(rows).toEqual([{ id: 1 }]);
  });

  test('falls back to the original SQL when literals would change', () => {
    clearTransformCache();
    const query = `select "a"."id" from "a" inner join "b" on "a"."id" = "b_id" where "a"."p" = 'C:\\new'`;
    expect(transformSQL(query)).toEqual({ sql: query, transformed: false });
  });
});

describe('re-print guard for DuckDB syntax the parser misreads', () => {
  test('an ANTI JOIN is not re-printed as an INNER JOIN', async () => {
    clearTransformCache();
    await db.execute(
      sql`create table anti_orders as select * from (values (1, 1, [1, 2]), (2, 3, [7])) v(id, customer_id, tags)`
    );
    await db.execute(
      sql`create table anti_customers as select * from (values (1)) v(id)`
    );
    const rows = await db.execute(
      sql`select customer_id, array_upper(tags, 1) as n from anti_orders anti join anti_customers c on customer_id = c.id`
    );
    // Re-printed as an INNER JOIN, this returned customer 1 instead.
    expect(rows).toEqual([{ customer_id: 3, n: 1n }]);
  });

  test.each([
    'select array_upper(tags, 1) from t semi join u on t.id = u.id',
    'select array_upper(tags, 1) from t asof join u using (id, ts)',
    'select gs from t cross join generate_series(1, 3) gs',
    'select gs from t natural join generate_series(1, 3) gs',
    'select gs from t positional join generate_series(1, 3) gs',
  ])('keeps the join type: %s', (query) => {
    clearTransformCache();
    const result = transformSQL(query);
    expect(result.sql).not.toMatch(
      /AS "(?:semi|asof|cross|natural|positional)"/i
    );
    expect(result.sql.toLowerCase()).toMatch(
      /(?:semi|asof|cross|natural|positional) join/
    );
  });

  test('a CROSS JOIN after an aliased table is still rewritten', () => {
    clearTransformCache();
    const result = transformSQL(
      'select gs from t x cross join generate_series(1, 3) gs'
    );
    expect(result.transformed).toBe(true);
    expect(result.sql).toContain('CROSS JOIN');
  });

  test('negative numbers past 2^53 keep every digit', async () => {
    clearTransformCache();
    const query =
      'select gs.generate_series as v from generate_series(1, 1) gs where -9007199254740993 < -9007199254740992 and gs = 1';
    expect(transformSQL(query)).toEqual({ sql: query, transformed: false });
    clearTransformCache();
    expect(
      transformSQL(
        'select gs, -1.123456789012345678 as d from generate_series(1, 1) gs'
      ).transformed
    ).toBe(false);
  });

  test('`- -x` is not re-printed as the comment `--x`', () => {
    clearTransformCache();
    const query = 'select 1 as k, - -gs as n from generate_series(1, 2) gs';
    expect(transformSQL(query)).toEqual({ sql: query, transformed: false });
  });

  test('numbers the printer only respells are still rewritten', () => {
    clearTransformCache();
    const result = transformSQL(
      'select gs, .5 as half, 1.50 as d, 12345678901234567890 as big from generate_series(1, 1) gs'
    );
    expect(result.transformed).toBe(true);
    expect(result.sql).toContain('0.5');
    expect(result.sql).toContain('12345678901234567890');
  });
});

describe('join column qualification', () => {
  test('an unqualified column is not assigned to the table already on the other side', async () => {
    const rows = await db.execute(
      sql`select ${owners.id} as owner, ${docs.id} as doc from ${owners} inner join ${docs} on ${docs.id} = "doc_id"`
    );
    expect(rows).toEqual([{ owner: 7, doc: 1 }]);
  });

  test('same-name columns do not become a self comparison', () => {
    const result = transformSQL(
      'select * from "b" inner join "a" on "a"."id" = "id"'
    );
    expect(result.sql).toContain('"a"."id" = "b"."id"');
  });

  test('keeps qualifying the joined side for CTE style joins', () => {
    const result = transformSQL(
      'select * from "t" inner join "cte" on "t"."id" = "tid"'
    );
    expect(result.sql).toContain('"t"."id" = "cte"."tid"');
  });
});
