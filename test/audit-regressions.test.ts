import { DuckDBInstance, type DuckDBValue } from '@duckdb/node-api';
import { defineRelations, sql } from 'drizzle-orm';
import { date, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import {
  buildStructLiteral,
  duckDbList,
  duckDbMap,
  duckDbStruct,
  duckDbTimestamp,
  formatLiteral,
} from '../src/columns.ts';
import { drizzle } from '../src/driver.ts';
import { duckLakeMergeAdjacentFiles } from '../src/ducklake.ts';
import { introspect } from '../src/introspect.ts';
import { olap, sumN } from '../src/olap.ts';
import { transformSQL } from '../src/sql/ast-transformer.ts';
import { wrapTimestamp, wrapperToNodeApiValue } from '../src/value-wrappers.ts';

describe('audit regressions', () => {
  test('relational queries preserve infinite DATE and TIMESTAMP values', async () => {
    const parents = pgTable('rel_inf_parents', {
      id: integer('id').primaryKey(),
      d: date('d', { mode: 'date' }),
      ts: timestamp('ts', { mode: 'date' }),
      tstz: timestamp('tstz', { mode: 'date', withTimezone: true }),
    });
    const children = pgTable('rel_inf_children', {
      id: integer('id').primaryKey(),
      parentId: integer('parent_id').notNull(),
      ts: timestamp('ts', { mode: 'date' }),
      d: date('d', { mode: 'date' }),
    });
    const relations = defineRelations({ parents, children }, (r) => ({
      parents: {
        children: r.many.children({
          from: r.parents.id,
          to: r.children.parentId,
        }),
      },
    }));

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const db = drizzle(connection, { relations });
    try {
      await db.execute(sql`
        create table rel_inf_parents (id integer primary key, d date, ts timestamp, tstz timestamptz);
        create table rel_inf_children (id integer primary key, parent_id integer not null, ts timestamp, d date);
        insert into rel_inf_parents values (1, 'infinity', 'infinity', '-infinity');
        insert into rel_inf_children values (10, 1, '-infinity', '-infinity');
      `);

      const rows = await db.query.parents.findMany({
        with: { children: true },
      });
      expect(rows).toEqual([
        {
          id: 1,
          d: 'infinity',
          ts: 'infinity',
          tstz: '-infinity',
          children: [
            {
              id: 10,
              parentId: 1,
              ts: '-infinity',
              d: '-infinity',
            },
          ],
        },
      ]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  test('introspect() and olap() accept databases with relations and olap() accepts transactions', async () => {
    const sales = pgTable('typed_sales', {
      id: integer('id').primaryKey(),
      region: text('region').notNull(),
      amount: integer('amount').notNull(),
    });
    const relations = defineRelations({ sales });

    const db = await drizzle(':memory:', { pool: false, relations });
    try {
      await db.execute(sql`
        create table typed_sales (id integer primary key, region text not null, amount integer not null);
        insert into typed_sales values (1, 'eu', 10), (2, 'eu', 15);
      `);

      const introspected = await introspect(db);
      expect(introspected.files.metaJson.map((t) => t.name)).toContain(
        'typed_sales'
      );

      const topRows = await olap(db)
        .from(sales)
        .groupBy([sales.region])
        .measures({ total: sumN(sales.amount) })
        .run();
      expect(topRows).toEqual([{ 'typed_sales.region': 'eu', total: 25 }]);

      const txRows = await db.transaction((tx) =>
        olap(tx)
          .from(sales)
          .groupBy([sales.region])
          .measures({ total: sumN(sales.amount) })
          .run()
      );
      expect(txRows).toEqual([{ 'typed_sales.region': 'eu', total: 25 }]);
    } finally {
      await db.close();
    }
  });

  test('duckDbStruct handles prototype-named fields safely', async () => {
    const items = pgTable('proto_structs', {
      id: integer('id').primaryKey(),
      payload: duckDbStruct<{
        toString: string;
        constructor: string;
        valueOf: string;
      }>('payload', {
        toString: 'VARCHAR',
        constructor: 'VARCHAR',
        valueOf: 'VARCHAR',
      }),
      nested: duckDbList<{ toString: string }>(
        'nested',
        'STRUCT(toString VARCHAR, "__proto__" DATE)'
      ),
    });

    const db = await drizzle(':memory:', { pool: false });
    try {
      await db.execute(sql`
        create table proto_structs (
          id integer primary key,
          payload struct("toString" varchar, "constructor" varchar, "valueOf" varchar),
          nested struct("toString" varchar, "__proto__" date)[]
        )
      `);

      await db.insert(items).values({
        id: 1,
        payload: {
          toString: 'alpha',
          constructor: 'beta',
          valueOf: 'gamma',
        },
        nested: [{ toString: 'delta' }],
      });

      const rows = await db.select().from(items);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload!.toString).toBe('alpha');
      expect(rows[0]!.payload!.constructor).toBe('beta');
      expect(rows[0]!.payload!.valueOf).toBe('gamma');
      expect(rows[0]!.nested).toEqual([{ toString: 'delta', __proto__: null }]);

      // Unmatched prototype property name on schema must not call Object.prototype.toString
      const literalQuery = buildStructLiteral({ toString: 'x' }, {});
      expect(literalQuery).toBeDefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  test('dateLiteral and timestampLiteral reject invalid Date and format BC / >9999 dates', () => {
    const invalid = new Date('not-a-date');
    expect(() => formatLiteral(invalid, 'DATE')).toThrow(
      /Invalid Date parameter/
    );
    expect(() => formatLiteral(invalid, 'TIMESTAMP')).toThrow(
      /Invalid Date parameter/
    );

    const tsTable = pgTable('ts_lit_test', {
      ts: duckDbTimestamp('ts', { bindMode: 'literal' }),
    });
    expect(() => tsTable.ts.mapToDriverValue(invalid)).toThrow(
      /Invalid Date parameter/
    );

    const year10000 = new Date(Date.UTC(10000, 0, 1, 0, 0, 0));
    expect(formatLiteral(year10000, 'DATE')).toBe("DATE '10000-01-01'");
    expect(formatLiteral(year10000, 'TIMESTAMP')).toBe(
      "TIMESTAMP '10000-01-01 00:00:00'"
    );

    const bcDate = new Date(Date.UTC(-43, 2, 15, 0, 0, 0));
    expect(formatLiteral(bcDate, 'DATE')).toBe("DATE '0044-03-15 (BC)'");
    expect(formatLiteral(bcDate, 'TIMESTAMPTZ')).toBe(
      "TIMESTAMPTZ '0044-03-15 (BC) 00:00:00+00'"
    );
  });

  test('duckDbMap object mode preserves sub-millisecond timestamp keys and TIMESTAMPTZ suffix', async () => {
    const events = pgTable('ts_map_keys', {
      id: integer('id').primaryKey(),
      naiveMap: duckDbMap<Record<string, number>>('naive_map', 'INTEGER', {
        mode: 'object',
        keyType: 'TIMESTAMP',
      }),
      tzMap: duckDbMap<Record<string, number>>('tz_map', 'INTEGER', {
        mode: 'object',
        keyType: 'TIMESTAMPTZ',
      }),
    });

    const db = await drizzle(':memory:', { pool: false });
    try {
      await db.execute(sql`
        create table ts_map_keys (
          id integer primary key,
          naive_map map(timestamp, integer),
          tz_map map(timestamptz, integer)
        );
        insert into ts_map_keys values (
          1,
          map([TIMESTAMP '2024-01-15 10:30:00.123456'], [1]),
          map([TIMESTAMPTZ '2024-01-15 10:30:00.123456+00'], [2])
        );
      `);

      const [row] = await db.select().from(events);
      expect(row?.naiveMap).toEqual({
        '2024-01-15 10:30:00.123456': 1,
      });
      expect(row?.tzMap).toEqual({
        '2024-01-15 10:30:00.123456+00': 2,
      });
    } finally {
      await db.close();
    }
  });

  test('duckLakeMergeAdjacentFiles validates individual options before cross-field comparisons', () => {
    expect(() =>
      duckLakeMergeAdjacentFiles('lake', {
        minFileSize: 1.5,
        maxFileSize: 10,
      })
    ).toThrow(/ducklake_merge_adjacent_files minFileSize must be an integer/);

    expect(() =>
      duckLakeMergeAdjacentFiles('lake', {
        newerThan: new Date('invalid'),
        olderThan: new Date('2025-01-01T00:00:00Z'),
      })
    ).toThrow(
      /ducklake_merge_adjacent_files newerThan must be a valid Date or timestamp string/
    );
  });

  test('wrapperToNodeApiValue rejects non-finite timestamp numbers cleanly', () => {
    const noop = (v: unknown) => v as DuckDBValue;
    expect(() =>
      wrapperToNodeApiValue(wrapTimestamp(NaN, false), noop)
    ).toThrow('Invalid timestamp number: NaN');
    expect(() =>
      wrapperToNodeApiValue(wrapTimestamp(Infinity, false), noop)
    ).toThrow('Invalid timestamp number: Infinity');
  });

  test('transformSQL preserves dollar-quoted strings, comments, params, and numbers', () => {
    const query = `
      /* comment */
      SELECT $tag$hello 'world'$tag$ AS txt, .5 AS half, $1 AS p, array_upper(tags, 1) AS len
      FROM items
    `;
    const result = transformSQL(query, { qualifyJoinColumns: false });
    expect(result.transformed).toBe(true);
    expect(result.sql).toContain('nullif(array_length(tags), 0)');
    expect(result.sql).toContain("$tag$hello 'world'$tag$");
  });
});
