import type { DuckDBConnection } from '@duckdb/node-api';
import { describe, expect, test } from 'vitest';
import {
  executeInBatches,
  executeInBatchesRaw,
  type DuckDBConnectionPool,
  type ExecuteBatchesRawChunk,
} from '../src/client.ts';
import type { PgDuckClient } from '../src/pgduck.ts';

const columns = ['id', 'id', '__proto__'];
const outputColumns = ['id', 'id_1', '__proto__'];
const rows = Array.from({ length: 5 }, (_, index) => [
  BigInt(index),
  index === 0 ? null : `row-${index}`,
  { items: [index, null] },
]);

function source(
  backend: 'native' | 'pg',
  batches: unknown[][][],
  failure?: Error
) {
  const events: string[] = [];
  const connection =
    backend === 'pg'
      ? ({
          async query() {
            events.push('query');
            if (failure) throw failure;
            return {
              fields: columns.map((name) => ({ name })),
              rows: batches.flat(),
            };
          },
        } satisfies PgDuckClient)
      : ({
          async stream() {
            events.push('stream');
            return {
              columnNames: () => columns,
              async *yieldRowsJs() {
                try {
                  for (const [index, batch] of batches.entries()) {
                    events.push(`read-${index}`);
                    yield batch;
                  }
                  if (failure) throw failure;
                } finally {
                  events.push('iterator-close');
                }
              },
              close() {
                events.push('result-close');
              },
            };
          },
        } as unknown as DuckDBConnection);
  const pool: DuckDBConnectionPool = {
    async acquire() {
      events.push('acquire');
      return connection;
    },
    release(released) {
      expect(released).toBe(connection);
      events.push('release');
    },
  };
  return { pool, events };
}

describe.each(['native', 'pg'] as const)('%s batch boundaries', (backend) => {
  test.each([0, 4, 5])(
    'keeps raw and object rows ordered for %i input rows',
    async (count) => {
      const input = rows.slice(0, count);
      // Native chunks cross output boundaries and can be empty. pg returns
      // the same rows in one materialized result.
      const batches = [
        [],
        input.slice(0, 1),
        [],
        input.slice(1, 4),
        input.slice(4),
      ];
      const rawSource = source(backend, batches);
      const raw: ExecuteBatchesRawChunk[] = [];
      for await (const batch of executeInBatchesRaw(
        rawSource.pool,
        'select',
        [],
        {
          rowsPerChunk: 2,
        }
      )) {
        raw.push(batch);
      }
      const expectedSizes = count === 0 ? [] : count === 4 ? [2, 2] : [2, 2, 1];
      expect(raw.map((batch) => batch.rows.length)).toEqual(expectedSizes);
      expect(raw.flatMap((batch) => batch.rows)).toEqual(input);
      for (const [index, row] of raw.flatMap((batch) => batch.rows).entries()) {
        expect(row).toBe(input[index]);
      }
      for (const batch of raw) expect(batch.columns).toEqual(outputColumns);
      expect(
        rawSource.events.filter((event) => event === 'release')
      ).toHaveLength(1);

      const objectSource = source(backend, batches);
      const objects = [];
      for await (const batch of executeInBatches(
        objectSource.pool,
        'select',
        [],
        {
          rowsPerChunk: 2,
        }
      )) {
        objects.push(batch);
      }
      expect(objects.map((batch) => batch.length)).toEqual(expectedSizes);
      expect(objects.flat()).toEqual(
        input.map((row) =>
          Object.fromEntries(
            outputColumns.map((name, index) => [name, row[index]])
          )
        )
      );
      for (const [index, row] of objects.flat().entries()) {
        expect(Object.hasOwn(row, '__proto__')).toBe(true);
        expect(row['__proto__']).toBe(input[index]![2]);
      }
      expect(
        objectSource.events.filter((event) => event === 'release')
      ).toHaveLength(1);
    }
  );

  test('acquires lazily and releases once on early return without reading ahead', async () => {
    const { pool, events } = source(backend, [rows.slice(0, 3), rows.slice(3)]);
    const iterator = executeInBatchesRaw(pool, 'select', [], {
      rowsPerChunk: 2,
    });
    expect(events).toEqual([]);
    expect(await iterator.next()).toEqual({
      done: false,
      value: { columns: outputColumns, rows: rows.slice(0, 2) },
    });
    expect(events).toEqual(
      backend === 'native'
        ? ['acquire', 'stream', 'read-0']
        : ['acquire', 'query']
    );
    await iterator.return();
    expect(events).toEqual(
      backend === 'native'
        ? [
            'acquire',
            'stream',
            'read-0',
            'iterator-close',
            'result-close',
            'release',
          ]
        : ['acquire', 'query', 'release']
    );
  });
});

test.each([1, 3])(
  'native source failure discards the partial batch after %i rows',
  async (count) => {
    const failure = new Error('source failed');
    const { pool, events } = source('native', [rows.slice(0, count)], failure);
    const emitted: unknown[][] = [];
    const consume = async () => {
      for await (const batch of executeInBatchesRaw(pool, 'select', [], {
        rowsPerChunk: 2,
      })) {
        emitted.push(...batch.rows);
      }
    };
    await expect(consume()).rejects.toBe(failure);
    expect(emitted).toEqual(count === 1 ? [] : rows.slice(0, 2));
    expect(events.slice(-3)).toEqual([
      'iterator-close',
      'result-close',
      'release',
    ]);
  }
);

test('pg materialization failure retains its identity and releases the lease', async () => {
  const failure = new Error('query failed');
  const { pool, events } = source('pg', [rows], failure);
  const iterator = executeInBatchesRaw(pool, 'select', [], { rowsPerChunk: 2 });
  await expect(iterator.next()).rejects.toBe(failure);
  expect(events).toEqual(['acquire', 'query', 'release']);
});
