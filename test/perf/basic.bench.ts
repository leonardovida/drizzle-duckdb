import { eq, sql } from 'drizzle-orm';
import type { DuckDBDatabase } from '../../src/index.ts';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  closePerfHarness,
  createPerfHarness,
  perfBench,
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
  perfBench('select constant (builder)', 400, async () => {
    await db
      .select({ one: sql`1` })
      .from(factLarge)
      .limit(1);
  });

  perfBench('where + param binding (builder)', 400, async () => {
    await db
      .select({ id: factLarge.id })
      .from(factLarge)
      .where(eq(factLarge.id, 42))
      .limit(1);
  });
});
