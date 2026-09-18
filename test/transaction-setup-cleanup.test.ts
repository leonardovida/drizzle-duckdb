import { sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { expect, test, vi } from 'vitest';
import { drizzle } from '../src/driver.ts';

test.each([
  ['unsupported SQL option', 'serializable', /syntax error/i],
  ['invalid option', 'invalid', /Invalid transaction isolation level/],
] as const)(
  'rolls back after %s before reusing the connection',
  async (_, isolationLevel, error) => {
    const db = await drizzle(':memory:', { pool: { size: 1 } });
    const callback = vi.fn(async () => undefined);

    try {
      await expect(
        db.session.transaction(callback, {
          isolationLevel:
            isolationLevel as PgTransactionConfig['isolationLevel'],
        })
      ).rejects.toThrow(error);
      expect(callback).not.toHaveBeenCalled();

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
  }
);
