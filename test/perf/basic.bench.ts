import { eq, sql } from 'drizzle-orm';
import type { DuckDBDatabase } from '../../src/index.ts';
import { afterAll, beforeAll, bench, describe } from 'vitest';
import {
  closePerfHarness,
  createPerfHarness,
  type PerfHarness,
} from './setup.ts';
import { factLarge } from './schema.ts';

let harness: PerfHarness;
let db: DuckDBDatabase;

beforeAll(async () => {
  harness = await createPerfHarness();
  db = harness.db;
});

afterAll(async () => {
  await closePerfHarness(harness);
});

describe('basic plumbing', () => {
  bench(
    'select constant (builder)',
    async () => {
      await db
        .select({ one: sql`1` })
        .from(factLarge)
        .limit(1);
    },
    { time: 400 }
  );

  bench(
    'where + param binding (builder)',
    async () => {
      await db
        .select({ id: factLarge.id })
        .from(factLarge)
        .where(eq(factLarge.id, 42))
        .limit(1);
    },
    { time: 400 }
  );
});
