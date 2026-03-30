import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  integer,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';
import { drizzle } from '../src';
import { introspect } from '../src/introspect';
import { expect, test } from 'vitest';

const motherduckToken = process.env.MOTHERDUCK_TOKEN;
const skipMotherduck = !motherduckToken || process.env.SKIP_MOTHERDUCK === '1';
const MOTHERDUCK_TRANSIENT_ERROR_PATTERNS = [
  /DEADLINE_EXCEEDED/i,
  /request timed out/i,
];

function isTransientMotherDuckError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return MOTHERDUCK_TRANSIENT_ERROR_PATTERNS.some((pattern) =>
    pattern.test(error.message)
  );
}

async function runWithMotherDuckRetry<T>(
  operation: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === attempts || !isTransientMotherDuckError(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('MotherDuck operation failed');
}

if (skipMotherduck) {
  test.skip('MotherDuck integration requires MOTHERDUCK_TOKEN');
} else {
  test('runs the MotherDuck nyc.taxi example against sample_data', async () => {
    await runWithMotherDuckRetry(async () => {
      const instance = await DuckDBInstance.create('md:', {
        motherduck_token: motherduckToken,
      });
      const connection: DuckDBConnection = await instance.connect();
      const db = drizzle(connection);

      try {
        await db.execute(sql`
            create or replace temp view taxi_sample as
            select
              vendorid,
              tpep_pickup_datetime,
              passenger_count,
              trip_distance,
              total_amount,
              tip_amount
            from sample_data.nyc.taxi
            limit 50000
          `);

        const taxiSample = pgTable('taxi_sample', {
          vendorId: integer('vendorid'),
          pickupTime: timestamp('tpep_pickup_datetime', {
            withTimezone: false,
          }),
          passengerCount: integer('passenger_count'),
          tripDistance: doublePrecision('trip_distance'),
          totalAmount: doublePrecision('total_amount'),
          tipAmount: doublePrecision('tip_amount'),
        });

        const trips = await db
          .select({
            pickupTime: taxiSample.pickupTime,
            passengerCount: taxiSample.passengerCount,
            tripDistance: taxiSample.tripDistance,
            totalAmount: taxiSample.totalAmount,
            tipAmount: taxiSample.tipAmount,
          })
          .from(taxiSample)
          .limit(5);

        expect(trips.length).toBeGreaterThan(0);
        trips.forEach((trip) => {
          expect(trip.pickupTime).toBeInstanceOf(Date);
          expect(typeof trip.tripDistance).toBe('number');
          expect(typeof trip.totalAmount).toBe('number');
        });

        const tipByPassengers = await db
          .select({
            passengers: taxiSample.passengerCount,
            avgFare: sql<number>`avg(${taxiSample.totalAmount})`,
            avgTip: sql<number>`avg(${taxiSample.tipAmount})`,
          })
          .from(taxiSample)
          .groupBy(taxiSample.passengerCount)
          .orderBy(sql`avg(${taxiSample.tipAmount}) desc`)
          .limit(5);

        expect(tipByPassengers.length).toBeGreaterThan(0);
        expect(Number(tipByPassengers[0].avgTip)).toBeGreaterThan(0);
        for (let i = 1; i < tipByPassengers.length; i++) {
          expect(Number(tipByPassengers[i - 1].avgTip)).toBeGreaterThanOrEqual(
            Number(tipByPassengers[i].avgTip)
          );
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    });
  }, 120_000);

  test('introspection filters to current database and excludes sample_data tables', async () => {
    await runWithMotherDuckRetry(async () => {
      const instance = await DuckDBInstance.create('md:', {
        motherduck_token: motherduckToken,
      });
      const connection: DuckDBConnection = await instance.connect();
      const db = drizzle(connection);

      try {
        // Get the current database name
        const dbRows = await db.execute<{ current_database: string }>(
          sql`SELECT current_database() as current_database`
        );
        const currentDatabase = dbRows[0]?.current_database;
        expect(currentDatabase).toBeDefined();

        // Run introspection with default settings (should filter to current database)
        const result = await introspect(db, {
          schemas: ['main'],
        });

        // Verify that tables from sample_data.nyc are NOT included
        const tableNames = result.files.metaJson.map((t) => t.name);
        expect(tableNames).not.toContain('taxi');
        expect(tableNames).not.toContain('weather');

        // The generated schema should not reference sample_data
        expect(result.files.schemaTs).not.toContain('sample_data');
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    });
  }, 120_000);
}
