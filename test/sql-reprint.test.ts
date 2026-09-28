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
