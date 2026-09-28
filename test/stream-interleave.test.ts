import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/index.ts';

const STREAMING_ERROR = /streaming a result from executeBatches\(\)/;
const source = sql`select x from range(10000) t(x)`;

describe('queries while executeBatches is open', () => {
  let instance: DuckDBInstance;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
  });

  afterAll(() => {
    instance.closeSync();
  });

  describe('on a single connection', () => {
    let db: DuckDBDatabase;

    beforeAll(async () => {
      db = drizzle(await instance.connect(), { prepareCache: false });
    });

    afterAll(async () => {
      await db.close();
    });

    test('another query throws instead of cutting the stream short', async () => {
      let rows = 0;
      const consume = async () => {
        for await (const batch of db.executeBatches(source, {
          rowsPerChunk: 1000,
        })) {
          rows += batch.length;
          await db.execute(sql`select 1`);
        }
      };

      await expect(consume()).rejects.toThrow(STREAMING_ERROR);
      expect(rows).toBe(1000);

      // The marker is cleared once the loop exits.
      expect(await db.execute(sql`select 1 as one`)).toEqual([{ one: 1 }]);
    });

    test('executeArrow, a second stream and cached statements also throw', async () => {
      const cached = drizzle(await instance.connect(), { prepareCache: true });
      try {
        const stream = cached.executeBatchesRaw(source, { rowsPerChunk: 10 });
        await stream.next();

        await expect(cached.executeArrow(sql`select 1`)).rejects.toThrow(
          STREAMING_ERROR
        );
        await expect(cached.execute(sql`select ${1} as one`)).rejects.toThrow(
          STREAMING_ERROR
        );
        await expect(
          cached.executeBatches(sql`select 1`).next()
        ).rejects.toThrow(STREAMING_ERROR);

        await stream.return(undefined);
        expect(await cached.execute(sql`select ${1} as one`)).toEqual([
          { one: 1 },
        ]);
      } finally {
        await cached.close();
      }
    });

    test('break and throw clear the marker', async () => {
      for await (const _batch of db.executeBatches(source, {
        rowsPerChunk: 100,
      })) {
        break;
      }
      expect(await db.execute(sql`select 2 as two`)).toEqual([{ two: 2 }]);

      await expect(
        (async () => {
          for await (const _batch of db.executeBatches(source)) {
            throw new Error('consumer failed');
          }
        })()
      ).rejects.toThrow('consumer failed');
      expect(await db.execute(sql`select 3 as three`)).toEqual([{ three: 3 }]);
    });

    test('a finished stream reads every row', async () => {
      let rows = 0;
      for await (const batch of db.executeBatches(source, {
        rowsPerChunk: 1000,
      })) {
        rows += batch.length;
      }
      expect(rows).toBe(10000);
    });
  });

  describe('on a pool', () => {
    let db: DuckDBDatabase;

    beforeAll(async () => {
      db = await drizzle(':memory:', { pool: { size: 2 } });
      await db.execute(sql`create table src as ${source}`);
      await db.execute(sql`create table dst (x bigint)`);
    });

    afterAll(async () => {
      await db.close();
    });

    test('queries on other pooled connections run while the stream is open', async () => {
      let rows = 0;
      for await (const batch of db.executeBatches(sql`select x from src`, {
        rowsPerChunk: 1000,
      })) {
        rows += batch.length;
        await db.execute(sql`select 1`);
      }
      expect(rows).toBe(10000);
    });

    test('writing inside a transaction stream throws and rolls back', async () => {
      await expect(
        db.transaction(async (tx) => {
          for await (const batch of tx.executeBatches<{ x: bigint }>(
            sql`select x from src`,
            { rowsPerChunk: 1000 }
          )) {
            await tx.execute(
              sql`insert into dst select unnest(${sql.param(
                batch.map((row) => row.x)
              )})`
            );
          }
        })
      ).rejects.toThrow(STREAMING_ERROR);

      expect(await db.execute(sql`select count(*)::int as n from dst`)).toEqual(
        [{ n: 0 }]
      );
    });
  });
});
