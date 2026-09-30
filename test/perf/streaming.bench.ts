import { arrayContains, sql } from 'drizzle-orm';
import type { DuckDBDatabase } from '../../src/index.ts';
import { afterAll, beforeAll, bench, describe } from 'vitest';
import {
  closePerfHarness,
  createPerfHarness,
  type PerfHarness,
} from './setup.ts';
import { arrayTable, factLarge } from './schema.ts';

let harness: PerfHarness;
let db: DuckDBDatabase;

beforeAll(async () => {
  harness = await createPerfHarness();
  db = harness.db;
});

afterAll(async () => {
  await closePerfHarness(harness);
});

describe('streaming paths', () => {
  bench(
    'executeInBatches (drizzle)',
    async () => {
      let total = 0;
      for await (const chunk of db.executeBatches(
        sql`select * from ${factLarge}`,
        { rowsPerChunk: 10000 }
      )) {
        total += chunk.length;
      }
      if (total !== 100000) {
        throw new Error(`expected 100000 rows, saw ${total}`);
      }
    },
    { time: 700 }
  );

  bench(
    'executeArrow (drizzle)',
    async () => {
      await db.executeArrow(sql`select * from ${factLarge}`);
    },
    { time: 700 }
  );

  bench(
    'array contains (builder with native operators)',
    async () => {
      await db
        .select()
        .from(arrayTable)
        .where(arrayContains(arrayTable.seqArray, [10, 11]))
        .orderBy(arrayTable.id)
        .limit(10);
    },
    { time: 700 }
  );
});
