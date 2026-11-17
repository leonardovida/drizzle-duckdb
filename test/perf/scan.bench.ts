import { asc, avg, sum } from 'drizzle-orm';
import type { DuckDBDatabase } from '../../src/index.ts';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  closePerfHarness,
  createPerfHarness,
  perfBench,
  type PerfHarness,
} from './setup.ts';
import { factLarge, narrowWide } from './schema.ts';
import { olap, sumN } from '../../src/olap.ts';

let harness: PerfHarness;
let db: DuckDBDatabase;

beforeAll(async () => {
  harness = await createPerfHarness();
  db = harness.db;
});

afterAll(async () => {
  await closePerfHarness(harness);
});

describe('table scans and aggregations', () => {
  perfBench('scan fact_large (builder)', 700, async () => {
    await db.select().from(factLarge);
  });

  perfBench('aggregation on fact_large (builder)', 700, async () => {
    await db
      .select({
        mod100: factLarge.mod100,
        avgValue: avg(factLarge.value),
        sumValue: sum(factLarge.value),
      })
      .from(factLarge)
      .groupBy(factLarge.mod100)
      .orderBy(asc(factLarge.mod100));
  });

  perfBench('wide row materialization (builder)', 700, async () => {
    await db.select().from(narrowWide);
  });

  perfBench('olap builder (group + window)', 700, async () => {
    await olap(db)
      .from(factLarge)
      .groupBy([factLarge.cat])
      .selectNonAggregates(
        { anyPayload: factLarge.payload },
        { anyValue: true }
      )
      .measures({
        total: sumN(factLarge.value),
        avgValue: avg(factLarge.value),
      })
      .orderBy(asc(factLarge.cat))
      .run();
  });
});
