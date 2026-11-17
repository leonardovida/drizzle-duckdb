import { sql } from 'drizzle-orm';
import type { Logger } from 'drizzle-orm/logger';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { afterEach, expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';

const ERROR =
  'Transaction config is not supported by DuckDB, which has no SET TRANSACTION statement. Remove the config argument (isolationLevel, accessMode, deferrable).';

afterEach(() => {
  vi.restoreAllMocks();
});

test('transaction config rejects before the transaction begins', async () => {
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
      let ran = false;
      await expect(
        db.transaction(async () => {
          ran = true;
        }, config)
      ).rejects.toThrow(ERROR);
      expect(ran).toBe(false);
    }
    await expect(
      db.session.transaction(async () => 'session', { deferrable: true })
    ).rejects.toThrow(ERROR);

    // Nothing was sent, and the single pooled connection is still free.
    expect(queries).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    // A config with no option set asks for nothing and is accepted.
    await expect(db.transaction(async () => 'empty', {})).resolves.toBe(
      'empty'
    );
    await expect(
      db.transaction(async () => 'unset', { isolationLevel: undefined })
    ).resolves.toBe('unset');
    await expect(
      db.transaction(async (tx) => {
        const rows = await tx.execute<{ value: number }>(
          sql`select 1 as value`
        );
        return rows[0]?.value;
      })
    ).resolves.toBe(1);
  } finally {
    await db.close();
  }
});

test('setTransaction rejects config and resolves without it', async () => {
  const queries: string[] = [];
  const logger: Logger = {
    logQuery: (query) => {
      queries.push(query);
    },
  };
  const db = await drizzle(':memory:', { pool: { size: 1 }, logger });

  try {
    await expect(
      db.transaction(async (tx) => {
        await tx.setTransaction({ accessMode: 'read write' });
      })
    ).rejects.toThrow(ERROR);

    await expect(
      db.transaction(async (tx) => {
        await tx.setTransaction();
        await tx.setTransaction(undefined);
        return 'done';
      })
    ).resolves.toBe('done');

    expect(queries.filter((query) => /set transaction/i.test(query))).toEqual(
      []
    );
  } finally {
    await db.close();
  }
});
