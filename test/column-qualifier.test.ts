import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';
import {
  clearTransformCache,
  transformSQL,
} from '../src/sql/ast-transformer.ts';

const users = pgTable('cq_users', {
  id: integer('id'),
  name: text('name'),
});
const posts = pgTable('cq_posts', {
  id: integer('id'),
  userId: integer('user_id'),
});
const comments = pgTable('cq_comments', {
  id: integer('id'),
  postId: integer('post_id'),
  userId: integer('user_id'),
});

let db: DuckDBDatabase;

beforeAll(async () => {
  db = await drizzle(':memory:');
  await db.execute(sql`
    create table cq_users (id integer, name text);
    insert into cq_users values (1, 'ann'), (2, 'bob'), (3, 'cid');
    create table cq_posts (id integer, user_id integer);
    insert into cq_posts values (10, 1), (11, 2), (12, 3);
    create table cq_comments (id integer, post_id integer, user_id integer);
    insert into cq_comments values (100, 10, 2), (101, 10, 2), (102, 11, 1);

    create table cq_a (id integer, x integer);
    insert into cq_a values (1, 10), (2, 20), (3, 30);
    create table cq_b (id integer, a_id integer);
    insert into cq_b values (1, 1), (2, 2), (5, 9);
    create table cq_c (id integer, b_id integer);
    insert into cq_c values (1, 1), (2, 5);

    create schema cq_s;
    create table cq_s.people (id integer, name text);
    insert into cq_s.people values (1, 'a'), (2, 'b');
  `);
});

afterAll(async () => {
  await db?.close();
});

async function rows(query: string) {
  const result = await db.execute(sql.raw(query));
  return result.map((row) => Object.values(row));
}

/** Run the original and the rewritten SQL and return both results. */
async function runBoth(query: string) {
  clearTransformCache();
  const rewritten = transformSQL(query);
  return {
    rewritten,
    original: await rows(query),
    result: await rows(rewritten.sql),
  };
}

describe('unqualified ON columns', () => {
  test('go to the newly joined source, whatever the operand order', async () => {
    const query = `
      select "cq_users"."name", "sq"."n"
      from "cq_users"
      inner join "cq_posts" on "cq_posts"."user_id" = "cq_users"."id"
      left join (
        select user_id as commenter, count(*) as n
        from cq_comments group by user_id
      ) "sq" on "commenter" = "cq_users"."id"
      order by "cq_users"."id"`;
    const { rewritten, original, result } = await runBoth(query);
    expect(rewritten.sql).toContain('"sq"."commenter" = "cq_users"."id"');
    expect(result).toEqual(original);
    expect(result).toEqual([
      ['ann', 1n],
      ['bob', 2n],
      ['cid', null],
    ]);
  });

  test('are left alone when the earlier source is not known', () => {
    clearTransformCache();
    const result = transformSQL(
      'select * from "a" join "b" on "a"."id" = "b"."a_id" join "c" on "c"."id" = "ref"'
    );
    expect(result.sql).not.toContain('"b"."ref"');
    expect(result.sql).not.toContain('"a"."ref"');
  });

  test('drizzle joins on a subquery SQL field after an earlier join', async () => {
    const sq = db
      .select({
        commenter: sql<number>`${comments.userId}`.as('commenter'),
        n: sql<number>`count(*)`.as('n'),
      })
      .from(comments)
      .groupBy(comments.userId)
      .as('sq');

    const result = await db
      .select({ user: users.name, n: sq.n })
      .from(users)
      .innerJoin(posts, eq(posts.userId, users.id))
      .leftJoin(sq, eq(sq.commenter, users.id))
      .orderBy(users.id);

    expect(result).toEqual([
      { user: 'ann', n: 1n },
      { user: 'bob', n: 2n },
      { user: 'cid', n: null },
    ]);
  });
});

describe('other references to a name qualified in ON', () => {
  test('use the qualifier chosen in ON, not the first FROM table', async () => {
    const query = `
      select "cq_users"."name", "id"
      from "cq_users"
      left join (select user_id as id from cq_comments group by user_id) "sq"
        on "cq_users"."id" = "id"
      where "id" is null`;
    clearTransformCache();
    const rewritten = transformSQL(query);
    expect(rewritten.sql).toContain('"sq"."id" IS NULL');
    expect(await rows(rewritten.sql)).toEqual([['cid', null]]);
  });

  test('stay unqualified when the name got more than one qualifier', () => {
    clearTransformCache();
    const result = transformSQL(
      'select "id" from "a" left join "b" on "id" = "id" where "id" is null'
    );
    expect(result.sql).toContain('"a"."id" = "b"."id"');
    expect(result.sql).toMatch(/SELECT "id" FROM/);
    expect(result.sql).toMatch(/WHERE "id" IS NULL/);
  });

  test('keep output aliases in ORDER BY', () => {
    clearTransformCache();
    const result = transformSQL(
      'select "t"."x" as "id" from "t" join "sq" on "t"."id" = "id" order by "id"'
    );
    expect(result.sql).toContain('"t"."id" = "sq"."id"');
    expect(result.sql).toMatch(/ORDER BY "id"/);
  });
});

describe('USING columns', () => {
  test.each(['full', 'right'])(
    'are never qualified after a %s join',
    async (joinType) => {
      const query = `select "id" from cq_a ${joinType} join cq_b using (id) left join cq_c on cq_c.b_id = "a_id" order by 1`;
      const { rewritten, original, result } = await runBoth(query);
      expect(rewritten.sql).not.toMatch(/SELECT "cq_a"\."id"/i);
      expect(result).toEqual(original);
    }
  );
});

describe('schema qualified tables', () => {
  test('an aliased table is qualified by its alias only', async () => {
    const query =
      'select u.name from cq_s.people u join (select 1 as k) q on "k" = u.id';
    const { rewritten, original, result } = await runBoth(query);
    expect(rewritten.sql).not.toContain('"cq_s"."q"');
    expect(result).toEqual(original);
    expect(result).toEqual([['a']]);
  });

  test('both sides of a same-name comparison use the alias', async () => {
    clearTransformCache();
    const rewritten = transformSQL(
      'select q.id from (select 1 as id) q join cq_s.people u on "id" = "id"'
    );
    expect(rewritten.sql).toContain('"q"."id" = "u"."id"');
    expect(await rows(rewritten.sql)).toEqual([[1]]);
  });

  test('a schema qualified table without an alias keeps its schema', () => {
    clearTransformCache();
    const rewritten = transformSQL(
      'select 1 from (select 1 as id) q join cq_s.people on "id" = "id"'
    );
    expect(rewritten.sql).toContain('"cq_s"."people"."id"');
  });
});
