import { asc, avg, sum } from 'drizzle-orm';
import type { DuckDBDatabase } from '../../src/index.ts';
import { afterAll, beforeAll, bench, describe } from 'vitest';
import {
  closePerfHarness,
  createPerfHarness,
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
  bench(
    'scan fact_large (builder)',
    async () => {
      await db.select().from(factLarge);
    },
    { time: 700 }
  );

  bench(
    'aggregation on fact_large (builder)',
    async () => {
      await db
        .select({
          mod100: factLarge.mod100,
          avgValue: avg(factLarge.value),
          sumValue: sum(factLarge.value),
        })
        .from(factLarge)
        .groupBy(factLarge.mod100)
        .orderBy(asc(factLarge.mod100));
    },
    { time: 700 }
  );

  bench(
    'wide row materialization (builder)',
    async () => {
      await db.select().from(narrowWide);
    },
    { time: 700 }
  );

  bench(
    'olap builder (group + window)',
    async () => {
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
    },
    { time: 700 }
  );
});
