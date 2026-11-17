import { DuckDBInstance } from '@duckdb/node-api';
import { defineRelations, sql } from 'drizzle-orm';
import { bigint, pgTable } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';

const authors = pgTable('bigint_authors', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
});
const books = pgTable('bigint_books', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  authorId: bigint('author_id', { mode: 'bigint' }),
  pages: bigint('pages', { mode: 'number' }),
});
const relations = defineRelations({ authors, books }, (r) => ({
  authors: {
    books: r.many.books({ from: r.authors.id, to: r.books.authorId }),
  },
  books: {
    author: r.one.authors({ from: r.books.authorId, to: r.authors.id }),
  },
}));

// Both ids are past 2^53, where a JSON number rounds.
const authorId = 1765432109876543211n;
const bookId = 1765432109876543299n;

test('nested relations keep 64-bit integers exact', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const db = drizzle(await instance.connect(), { relations });
  try {
    await db.execute(sql`create table bigint_authors(id bigint primary key);
      create table bigint_books(id bigint primary key, author_id bigint, pages bigint);
      insert into bigint_authors values (${sql.raw(String(authorId))});
      insert into bigint_books values (${sql.raw(String(bookId))}, ${sql.raw(String(authorId))}, 320),
        (${sql.raw(String(bookId + 1n))}, ${sql.raw(String(authorId))}, null)`);

    const withBooks = await db.query.authors.findMany({
      with: { books: { orderBy: { id: 'asc' } } },
    });
    expect(withBooks).toEqual([
      {
        id: authorId,
        books: [
          { id: bookId, authorId, pages: 320 },
          { id: bookId + 1n, authorId, pages: null },
        ],
      },
    ]);

    const withAuthor = await db.query.books.findFirst({
      where: { id: bookId },
      with: { author: true },
    });
    expect(withAuthor?.author?.id).toBe(authorId);
    expect(withAuthor?.author?.id).toBe(withAuthor?.authorId);
  } finally {
    await db.close();
  }
});
