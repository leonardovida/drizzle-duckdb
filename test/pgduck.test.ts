import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';
import {
  createPgDuckConnectionPool,
  type PgDuckClient,
  type PgDuckPool,
  type PgDuckQueryConfig,
} from '../src/pgduck.ts';

const users = pgTable('users', {
  id: integer('id'),
  name: text('name'),
});

function queryText(query: string | PgDuckQueryConfig): string {
  return typeof query === 'string' ? query : query.text;
}

function queryValues(query: string | PgDuckQueryConfig, values?: unknown[]) {
  return typeof query === 'string' ? values : query.values;
}

describe('pg_duckdb client support', () => {
  test('executes Drizzle queries through a Postgres wire client', async () => {
    const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
    const client: PgDuckClient = {
      async query(query, values) {
        calls.push({
          text: queryText(query),
          values: queryValues(query, values),
        });

        return {
          fields: [{ name: 'id' }, { name: 'name' }],
          rows: [[1, 'Ada']],
        };
      },
    };

    const db = drizzle(client);
    const result = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(sql`${users.id} = ${1}`);

    expect(result).toEqual([{ id: 1, name: 'Ada' }]);
    expect(calls[0]).toMatchObject({
      text: 'select "id" as "id", "name" as "name" from "users" where "users"."id" = $1',
      values: [1],
    });
  });

  test('pins pg_duckdb pool clients for transactions', async () => {
    const calls: string[] = [];
    let releaseCalls = 0;
    const poolClient: PgDuckClient & { release(): void } = {
      async query(query) {
        calls.push(queryText(query));
        return { fields: [], rows: [] };
      },
      release() {
        releaseCalls += 1;
      },
    };
    const pool: PgDuckPool = {
      async connect() {
        return poolClient;
      },
    };

    const db = drizzle(createPgDuckConnectionPool(pool));

    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
    });

    expect(calls).toEqual(['BEGIN TRANSACTION;', 'select 1', 'commit']);
    expect(releaseCalls).toBe(1);
  });
});
