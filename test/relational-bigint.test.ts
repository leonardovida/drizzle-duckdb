import { DuckDBInstance } from '@duckdb/node-api';
import { relations, sql } from 'drizzle-orm';
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
const authorsRelations = relations(authors, ({ many }) => ({
  books: many(books),
}));
const booksRelations = relations(books, ({ one }) => ({
  author: one(authors, { fields: [books.authorId], references: [authors.id] }),
}));

// Both ids are past 2^53, where a JSON number rounds.
const authorId = 1765432109876543211n;
const bookId = 1765432109876543299n;

test('nested relations keep 64-bit integers exact', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const db = drizzle(await instance.connect(), {
    schema: { authors, books, authorsRelations, booksRelations },
  });
  try {
    await db.execute(sql`create table bigint_authors(id bigint primary key);
      create table bigint_books(id bigint primary key, author_id bigint, pages bigint);
      insert into bigint_authors values (${sql.raw(String(authorId))});
      insert into bigint_books values (${sql.raw(String(bookId))}, ${sql.raw(String(authorId))}, 320),
        (${sql.raw(String(bookId + 1n))}, ${sql.raw(String(authorId))}, null)`);

    const withBooks = await db.query.authors.findMany({
      with: { books: { orderBy: (book, { asc }) => asc(book.id) } },
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
      where: (book, { eq }) => eq(book.id, bookId),
      with: { author: true },
    });
    expect(withAuthor?.author?.id).toBe(authorId);
    expect(withAuthor?.author?.id).toBe(withAuthor?.authorId);
  } finally {
    await db.close();
  }
});
