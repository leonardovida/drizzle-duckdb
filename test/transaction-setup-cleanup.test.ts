import { sql } from 'drizzle-orm';
import type { Logger } from 'drizzle-orm/logger';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { afterEach, expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';

const WARNING =
  'Transaction config is not supported by DuckDB and is ignored. Passing it will throw in the next major version.';

afterEach(() => {
  vi.restoreAllMocks();
});

test('transaction config is ignored with a one-time deprecation warning', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const queries: string[] = [];
  const logger: Logger = {
    logQuery: (query) => {
      queries.push(query);
    },
  };
  const db = await drizzle(':memory:', { pool: { size: 1 }, logger });

  try {
    const configs: PgTransactionConfig[] = [
      { isolationLevel: 'serializable' },
      { accessMode: 'read only' },
      { isolationLevel: 'invalid' as PgTransactionConfig['isolationLevel'] },
    ];

    for (const config of configs) {
      await expect(
        db.transaction(async (tx) => {
          const rows = await tx.execute<{ value: number }>(
            sql`select 1 as value`
          );
          return rows[0]?.value;
        }, config)
      ).resolves.toBe(1);
    }

    await expect(
      db.session.transaction(async (tx) => {
        await tx.setTransaction({ accessMode: 'read write' });
        return 'session';
      }, {})
    ).resolves.toBe('session');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(WARNING);
    expect(queries.filter((query) => /set transaction/i.test(query))).toEqual(
      []
    );
  } finally {
    await db.close();
  }
});
