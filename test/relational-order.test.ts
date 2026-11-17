import { defineRelations, sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';

// Enough children per parent that DuckDB aggregates a relation on several
// threads. list() does not keep the order of its input then, so the order of
// a many relation has to live inside the aggregate.
const PARENTS = 20;
const CHILDREN = 10_000;
// 7919 is coprime with 10_000, so n is a permutation of the child index.
const STEP = 7919;

const parents = pgTable('ord_parents', { id: integer('id').primaryKey() });
const children = pgTable('ord_children', {
  id: integer('id').primaryKey(),
  parentId: integer('parent_id').notNull(),
  n: integer('n').notNull(),
});
const tags = pgTable('ord_tags', {
  id: integer('id').primaryKey(),
  n: integer('n').notNull(),
});
const parentTags = pgTable('ord_parent_tags', {
  parentId: integer('parent_id').notNull(),
  tagId: integer('tag_id').notNull(),
});

const relations = defineRelations(
  { parents, children, tags, parentTags },
  (r) => ({
    parents: {
      children: r.many.children({
        from: r.parents.id,
        to: r.children.parentId,
      }),
      tags: r.many.tags({
        from: r.parents.id.through(r.parentTags.parentId),
        to: r.tags.id.through(r.parentTags.tagId),
      }),
    },
  })
);

let db: DuckDBDatabase<typeof relations>;

// Inlined, since a multi-statement execute takes no parameters.
const N = {
  PARENTS: sql.raw(String(PARENTS)),
  CHILDREN: sql.raw(String(CHILDREN)),
  STEP: sql.raw(String(STEP)),
};

// Child index whose n is k, so expected ids follow from expected n values.
const indexForN = new Map<number, number>();
for (let i = 0; i < CHILDREN; i += 1) indexForN.set((i * STEP) % CHILDREN, i);
const childId = (parent: number, n: number) =>
  parent * CHILDREN + indexForN.get(n)!;
const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => from + i);

beforeAll(async () => {
  db = await drizzle(':memory:', { relations, pool: false });
  // Explicit, so the test does not depend on the machine's core count.
  await db.execute(sql`set threads = 8`);
  await db.execute(sql`
    create table ord_parents (id integer primary key);
    create table ord_children (
      id integer primary key,
      parent_id integer not null,
      n integer not null
    );
    create table ord_tags (id integer primary key, n integer not null);
    create table ord_parent_tags (parent_id integer not null, tag_id integer not null);
    insert into ord_parents select range from range(${N.PARENTS});
    insert into ord_children
      select p.range * ${N.CHILDREN} + c.range, p.range, (c.range * ${N.STEP}) % ${N.CHILDREN}
      from range(${N.PARENTS}) p, range(${N.CHILDREN}) c;
    insert into ord_tags
      select range, (range * ${N.STEP}) % ${N.CHILDREN} from range(${N.CHILDREN});
    insert into ord_parent_tags
      select p.range, t.range from range(${N.PARENTS}) p, range(${N.CHILDREN}) t;
  `);
});

afterAll(async () => {
  await db?.close();
});

describe('many relations keep their orderBy on several threads', () => {
  test('the database runs on more than one thread', async () => {
    const [row] = await db.execute<{ threads: number }>(
      sql`select cast(current_setting('threads') as integer) as threads`
    );
    expect(row!.threads).toBeGreaterThan(1);
  });

  test('orderBy with limit', async () => {
    const rows = await db.query.parents.findMany({
      orderBy: { id: 'asc' },
      with: { children: { orderBy: { n: 'asc' }, limit: 5 } },
    });
    expect(rows).toHaveLength(PARENTS);
    for (const parent of rows) {
      expect(parent.children.map((child) => child.n)).toEqual(range(0, 5));
    }
  });

  test('orderBy on an unselected column with offset', async () => {
    const rows = await db.query.parents.findMany({
      orderBy: { id: 'asc' },
      with: {
        children: {
          columns: { id: true },
          orderBy: { n: 'desc' },
          limit: 5,
          offset: 3,
        },
      },
    });
    for (const parent of rows) {
      expect(parent.children).toEqual(
        range(CHILDREN - 8, 5)
          .reverse()
          .map((n) => ({ id: childId(parent.id, n) }))
      );
    }
  });

  test('orderBy on an expression', async () => {
    const rows = await db.query.parents.findMany({
      orderBy: { id: 'asc' },
      with: {
        children: {
          columns: { n: true },
          orderBy: (t, { asc }) => [asc(sql`${t.n} % 1000`), asc(t.n)],
          limit: 4,
        },
      },
    });
    for (const parent of rows) {
      expect(parent.children.map((child) => child.n)).toEqual([
        0, 1000, 2000, 3000,
      ]);
    }
  });

  test('orderBy through a junction table', async () => {
    const rows = await db.query.parents.findMany({
      orderBy: { id: 'asc' },
      with: { tags: { orderBy: { n: 'asc' }, limit: 5, offset: 1 } },
    });
    for (const parent of rows) {
      expect(parent.tags.map((tag) => tag.n)).toEqual(range(1, 5));
    }
  });

  test('nested relations under an ordered relation', async () => {
    const rows = await db.query.parents.findMany({
      orderBy: { id: 'asc' },
      limit: 3,
      with: {
        children: { columns: { n: true }, orderBy: { n: 'asc' }, limit: 5 },
        tags: { columns: { n: true }, orderBy: { n: 'desc' }, limit: 3 },
      },
    });
    for (const parent of rows) {
      expect(parent.children.map((child) => child.n)).toEqual(range(0, 5));
      expect(parent.tags.map((tag) => tag.n)).toEqual([9999, 9998, 9997]);
    }
  });
});

// Whether DuckDB reorders an unordered list() depends on its plan, so the
// SQL is pinned as well: every ordered many relation aggregates by an ordinal.
describe('ordered many relations aggregate in order', () => {
  test('orderBy with limit', () => {
    expect(
      db.query.parents
        .findMany({
          with: { children: { orderBy: { n: 'asc' }, limit: 5 } },
        })
        .toSQL().sql
    ).toBe(
      'select "d0"."id" as "id", "children"."r" as "children" from "ord_parents" as "d0" ' +
        'left join lateral(select coalesce(list(struct_pack("c0" := "t"."c0", "c1" := "t"."c1", "c2" := "t"."c2") order by "t"."ord"), []) as "r" ' +
        'from (select row_number() over (order by "d1"."n" asc) as "ord", "d1"."id" as "id", "d1"."parent_id" as "parentId", "d1"."n" as "n" ' +
        'from "ord_children" as "d1" where "d0"."id" = "d1"."parent_id" order by "d1"."n" asc limit 5) ' +
        'as "t"("ord", "c0", "c1", "c2")) as "children" on true'
    );
  });

  test('offset and through', () => {
    const query = db.query.parents
      .findMany({
        with: {
          children: { orderBy: { n: 'desc' }, limit: 5, offset: 3 },
          tags: { orderBy: { n: 'asc' }, limit: 5, offset: 1 },
        },
      })
      .toSQL().sql;
    expect(query.match(/ order by "t"\."ord"\)/g)).toHaveLength(2);
    expect(query).toContain(
      'row_number() over (order by "d1"."n" desc) as "ord"'
    );
    expect(query).toContain(
      'row_number() over (order by "d1"."n" asc) as "ord"'
    );
  });

  test('relations without orderBy stay unordered', () => {
    const query = db.query.parents
      .findMany({
        with: { children: { limit: 5 } },
      })
      .toSQL().sql;
    expect(query).not.toContain('row_number()');
    expect(query).toContain(
      'coalesce(list(struct_pack("c0" := "t"."c0", "c1" := "t"."c1", "c2" := "t"."c2")), [])'
    );
  });
});
