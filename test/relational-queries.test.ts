import { defineRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import {
  drizzle,
  duckDbJson,
  duckDbList,
  duckDbMap,
  duckDbStruct,
  duckDbTimestamp,
  type DuckDBDatabase,
} from '../src/index.ts';

const users = pgTable('rq_users', {
  id: integer('id').primaryKey(),
  fullName: text('full_name').notNull(),
});

const posts = pgTable('rq_posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title').notNull(),
  publishedAt: timestamp('published_at'),
});

const relations = defineRelations({ users, posts }, (r) => ({
  users: {
    posts: r.many.posts({ from: r.users.id, to: r.posts.authorId }),
  },
  posts: {
    author: r.one.users({ from: r.posts.authorId, to: r.users.id }),
  },
}));

let db: DuckDBDatabase<typeof relations>;

beforeAll(async () => {
  db = await drizzle(':memory:', { relations });
  await db.execute(sql`
    create table rq_users (id integer primary key, full_name text not null);
    create table rq_posts (
      id integer primary key,
      author_id integer not null,
      title text not null,
      published_at timestamp
    );
  `);
});

beforeEach(async () => {
  await db.execute(sql`delete from rq_posts; delete from rq_users;`);
});

afterAll(async () => {
  await db?.close();
});

test('findFirst returns undefined for an empty table', async () => {
  expect(await db.query.users.findFirst()).toBeUndefined();
  expect(await db.query.users.findMany()).toEqual([]);
});

test('findFirst and findMany map rows to schema keys', async () => {
  await db.insert(users).values({ id: 1, fullName: 'Ann' });

  expect(await db.query.users.findFirst()).toEqual({ id: 1, fullName: 'Ann' });
  expect(await db.query.users.findMany()).toEqual([{ id: 1, fullName: 'Ann' }]);
});

test('findMany loads many and one relations as DuckDB nested values', async () => {
  await db.insert(users).values([
    { id: 1, fullName: 'Ann' },
    { id: 2, fullName: 'Bob' },
  ]);
  await db.insert(posts).values([
    { id: 10, authorId: 1, title: 'first' },
    { id: 11, authorId: 1, title: 'second' },
  ]);

  const withPosts = await db.query.users.findMany({
    orderBy: (u, { asc }) => asc(u.id),
    with: {
      posts: {
        columns: { id: true, title: true },
        orderBy: (p, { desc }) => desc(p.id),
      },
    },
  });

  expect(withPosts).toEqual([
    {
      id: 1,
      fullName: 'Ann',
      posts: [
        { id: 11, title: 'second' },
        { id: 10, title: 'first' },
      ],
    },
    { id: 2, fullName: 'Bob', posts: [] },
  ]);

  const withAuthor = await db.query.posts.findFirst({
    where: { id: 10 },
    columns: { title: true },
    with: { author: { with: { posts: { columns: { id: true } } } } },
  });

  expect(withAuthor).toEqual({
    title: 'first',
    author: {
      id: 1,
      fullName: 'Ann',
      posts: expect.arrayContaining([{ id: 10 }, { id: 11 }]),
    },
  });
});

test('relation columns decode through their column mappers', async () => {
  await db.insert(users).values({ id: 1, fullName: 'Ann' });
  await db.insert(posts).values({
    id: 10,
    authorId: 1,
    title: 'dated',
    publishedAt: new Date('2024-01-02T03:04:05.000Z'),
  });

  const result = await db.query.users.findFirst({
    with: { posts: { columns: { publishedAt: true } } },
  });

  expect(result?.posts[0]?.publishedAt).toBeInstanceOf(Date);
  expect(result?.posts[0]?.publishedAt?.toISOString()).toBe(
    '2024-01-02T03:04:05.000Z'
  );
});

test('related columns named like the join aliases keep their values', async () => {
  const parents = pgTable('rq_alias_parents', {
    id: integer('id').primaryKey(),
  });
  const kids = pgTable('rq_alias_kids', {
    id: integer('id').primaryKey(),
    parentId: integer('parent_id').notNull(),
    t: text('t'),
    r: text('r'),
  });
  const aliasRelations = defineRelations({ parents, kids }, (r) => ({
    parents: {
      kids: r.many.kids({ from: r.parents.id, to: r.kids.parentId }),
    },
    kids: {
      parent: r.one.parents({ from: r.kids.parentId, to: r.parents.id }),
    },
  }));
  const aliasDb = await drizzle(':memory:', { relations: aliasRelations });
  try {
    await aliasDb.execute(sql`
      create table rq_alias_parents (id integer primary key);
      create table rq_alias_kids (
        id integer primary key,
        parent_id integer not null,
        t text,
        r text
      );
      insert into rq_alias_parents values (1);
      insert into rq_alias_kids values (10, 1, 'tee', 'arr');
    `);

    expect(
      await aliasDb.query.parents.findMany({ with: { kids: true } })
    ).toEqual([{ id: 1, kids: [{ id: 10, parentId: 1, t: 'tee', r: 'arr' }] }]);
    expect(
      await aliasDb.query.kids.findFirst({
        columns: { t: true, r: true },
        with: { parent: true },
      })
    ).toEqual({ t: 'tee', r: 'arr', parent: { id: 1 } });
  } finally {
    await aliasDb.close();
  }
});

test('DuckDB column helpers decode in relations like a flat select', async () => {
  const docs = pgTable('rq_docs', { id: integer('id').primaryKey() });
  const attrs = pgTable('rq_doc_attrs', {
    id: integer('id').primaryKey(),
    docId: integer('doc_id').notNull(),
    payload: duckDbJson<{ a: number; b: string[] }>('payload'),
    seenAt: duckDbTimestamp('seen_at'),
    seenAtText: duckDbTimestamp('seen_at_text', { mode: 'string' }),
    tags: duckDbList<string>('tags', 'TEXT'),
    meta: duckDbStruct<{ k: string; n: number }>('meta', {
      k: 'TEXT',
      n: 'INTEGER',
    }),
    counts: duckDbMap<Record<string, number>>('counts', 'INTEGER', {
      mode: 'object',
    }),
  });
  const docRelations = defineRelations({ docs, attrs }, (r) => ({
    docs: { attrs: r.many.attrs({ from: r.docs.id, to: r.attrs.docId }) },
    attrs: { doc: r.one.docs({ from: r.attrs.docId, to: r.docs.id }) },
  }));
  const docDb = await drizzle(':memory:', { relations: docRelations });
  try {
    await docDb.execute(sql`
      create table rq_docs (id integer primary key);
      create table rq_doc_attrs (
        id integer primary key,
        doc_id integer not null,
        payload json,
        seen_at timestamp,
        seen_at_text timestamp,
        tags text[],
        meta struct(k text, n integer),
        counts map(varchar, integer)
      );
      insert into rq_docs values (1);
    `);
    await docDb.insert(attrs).values({
      id: 10,
      docId: 1,
      payload: { a: 1, b: ['x', 'y'] },
      seenAt: new Date('2024-01-02T03:04:05.123Z'),
      seenAtText: '2024-01-02 03:04:05.123456',
      tags: ['red', 'blue'],
      meta: { k: 'key', n: 7 },
      counts: { one: 1, two: 2 },
    });

    const [flat] = await docDb.select().from(attrs);
    expect(flat).toEqual({
      id: 10,
      docId: 1,
      payload: { a: 1, b: ['x', 'y'] },
      seenAt: new Date('2024-01-02T03:04:05.123Z'),
      seenAtText: '2024-01-02 03:04:05.123456',
      tags: ['red', 'blue'],
      meta: { k: 'key', n: 7 },
      counts: { one: 1, two: 2 },
    });
    expect(await docDb.query.docs.findMany({ with: { attrs: true } })).toEqual([
      { id: 1, attrs: [flat] },
    ]);
    expect(
      await docDb.query.docs.findFirst({
        with: { attrs: { with: { doc: true } } },
      })
    ).toEqual({ id: 1, attrs: [{ ...flat, doc: { id: 1 } }] });
  } finally {
    await docDb.close();
  }
});

test('related keys that differ only in case keep their values', async () => {
  const owners = pgTable('rq_case_owners', { id: integer('id').primaryKey() });
  const items = pgTable('rq_case_items', {
    id: integer('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
    userId: integer('user_id_a'),
    userid: integer('user_id_b'),
    // Named like the driver's ordinal and positional columns.
    ord: integer('ord'),
    c0: text('c0'),
  });
  const caseRelations = defineRelations({ owners, items }, (r) => ({
    owners: {
      items: r.many.items({ from: r.owners.id, to: r.items.ownerId }),
    },
    items: {
      owner: r.one.owners({ from: r.items.ownerId, to: r.owners.id }),
    },
  }));
  const caseDb = await drizzle(':memory:', { relations: caseRelations });
  try {
    await caseDb.execute(sql`
      create table rq_case_owners (id integer primary key);
      create table rq_case_items (
        id integer primary key,
        owner_id integer not null,
        user_id_a integer,
        user_id_b integer,
        ord integer,
        c0 text
      );
      insert into rq_case_owners values (1);
      insert into rq_case_items values
        (10, 1, 1, 2, 30, 'x'),
        (11, 1, 3, 4, 10, 'y'),
        (12, 1, 5, 6, 20, 'z');
    `);

    expect(
      await caseDb.query.owners.findFirst({
        with: {
          items: {
            columns: { userId: true, userid: true, ord: true, c0: true },
            orderBy: { ord: 'asc' },
          },
        },
      })
    ).toEqual({
      id: 1,
      items: [
        { userId: 3, userid: 4, ord: 10, c0: 'y' },
        { userId: 5, userid: 6, ord: 20, c0: 'z' },
        { userId: 1, userid: 2, ord: 30, c0: 'x' },
      ],
    });
    expect(
      await caseDb.query.items.findFirst({
        columns: { id: true },
        where: { id: 10 },
        with: {
          owner: {
            with: {
              items: {
                columns: { userId: true, userid: true },
                orderBy: { id: 'desc' },
              },
            },
          },
        },
      })
    ).toEqual({
      id: 10,
      owner: {
        id: 1,
        items: [
          { userId: 5, userid: 6 },
          { userId: 3, userid: 4 },
          { userId: 1, userid: 2 },
        ],
      },
    });
  } finally {
    await caseDb.close();
  }
});

test('nested DECIMAL extras follow decimalMode', async () => {
  const extras = {
    amount: () => sql`cast(1234567890123456789.5 as decimal(38, 2))`,
  };
  const query = (target: DuckDBDatabase<typeof relations>) =>
    target.query.users.findFirst({
      columns: { id: true },
      with: { posts: { columns: { id: true }, extras } },
    });

  await db.insert(users).values({ id: 1, fullName: 'Ann' });
  await db.insert(posts).values({ id: 10, authorId: 1, title: 'first' });
  expect(await query(db)).toEqual({
    id: 1,
    posts: [{ id: 10, amount: 1234567890123456789.5 }],
  });

  const stringDb = await drizzle(':memory:', {
    relations,
    decimalMode: 'string',
  });
  try {
    await stringDb.execute(sql`
      create table rq_users (id integer primary key, full_name text not null);
      create table rq_posts (
        id integer primary key,
        author_id integer not null,
        title text not null,
        published_at timestamp
      );
      insert into rq_users values (1, 'Ann');
      insert into rq_posts values (10, 1, 'first', null);
    `);
    expect(await query(stringDb)).toEqual({
      id: 1,
      posts: [{ id: 10, amount: '1234567890123456789.50' }],
    });
  } finally {
    await stringDb.close();
  }
});
