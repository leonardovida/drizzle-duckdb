import { asc, eq, sql } from 'drizzle-orm';
import type { DuckDBDatabase } from '../../src/index.ts';
import { afterAll, beforeAll, bench, describe } from 'vitest';
import {
  closePerfHarness,
  createPerfHarness,
  type PerfHarness,
} from './setup.ts';
import {
  benchComplex,
  benchInsert,
  benchPrepared,
  factLarge,
} from './schema.ts';

let harness: PerfHarness;
let db: DuckDBDatabase;

const batch = Array.from({ length: 100 }, (_, i) => ({
  id: i,
  val: `payload-${i}`,
}));

function buildPreparedSelect(db: DuckDBDatabase) {
  return db
    .select({ id: benchPrepared.id, val: benchPrepared.val })
    .from(benchPrepared)
    .where(eq(benchPrepared.id, sql.placeholder('id')))
    .prepare('perf_prepared_select');
}
let preparedSelect: ReturnType<typeof buildPreparedSelect>;
let mixedId = 1000;

beforeAll(async () => {
  harness = await createPerfHarness();
  db = harness.db;
  preparedSelect = buildPreparedSelect(db);
});

afterAll(async () => {
  await closePerfHarness(harness);
});

describe('mutations', () => {
  bench(
    'insert batch (builder)',
    async () => {
      await db.delete(benchInsert);
      await db.insert(benchInsert).values(batch);
    },
    { time: 700 }
  );

  bench(
    'insert batch returning',
    async () => {
      await db.delete(benchInsert);
      await db.insert(benchInsert).values(batch).returning();
    },
    { time: 700 }
  );

  bench(
    'upsert do update',
    async () => {
      await db.delete(benchInsert);
      await db.insert(benchInsert).values([{ id: 1, val: 'seed' }]);
      await db
        .insert(benchInsert)
        .values([{ id: 1, val: 'updated' }])
        .onConflictDoUpdate({
          target: benchInsert.id,
          set: { val: sql`excluded.val` },
        });
    },
    { time: 700 }
  );

  bench(
    'upsert do nothing',
    async () => {
      await db.delete(benchInsert);
      await db.insert(benchInsert).values([{ id: 1, val: 'seed' }]);
      await db
        .insert(benchInsert)
        .values([{ id: 1, val: 'dup' }])
        .onConflictDoNothing({ target: benchInsert.id });
    },
    { time: 700 }
  );

  bench(
    'transaction: insert + select',
    async () => {
      await db.transaction(async (tx) => {
        await tx.delete(benchInsert);
        await tx.insert(benchInsert).values(batch.slice(0, 20));
        await tx.select().from(benchInsert).limit(5);
      });
    },
    { time: 700 }
  );

  bench(
    'prepared select reuse',
    async () => {
      await preparedSelect.execute({ id: 10 });
    },
    { time: 700 }
  );

  bench(
    'mixed workload (select + insert)',
    async () => {
      await db.select().from(factLarge).orderBy(asc(factLarge.id)).limit(20);
      await db.insert(benchInsert).values([{ id: mixedId++, val: 'mix' }]);
    },
    { time: 700 }
  );

  bench(
    'complex param mapping (struct/map/arrays)',
    async () => {
      await db.delete(benchComplex);
      await db.insert(benchComplex).values({
        id: 1,
        meta: { version: 2, tag: 'alpha' },
        attrs: { region: 'us-east', env: 'dev' },
        nums: [1, 2, 3, 4],
        tags: ['a', 'b', 'c'],
      });
      await db
        .select()
        .from(benchComplex)
        .where(eq(benchComplex.id, 1))
        .limit(1);
    },
    { time: 700 }
  );
});
