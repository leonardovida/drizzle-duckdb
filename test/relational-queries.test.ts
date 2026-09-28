import { relations, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';

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

const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));

const schema = { users, posts, usersRelations, postsRelations };

let db: DuckDBDatabase<typeof schema>;

beforeAll(async () => {
  db = await drizzle(':memory:', { schema });
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

test('findMany loads many and one relations with DuckDB JSON functions', async () => {
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
    where: (p, { eq }) => eq(p.id, 10),
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
