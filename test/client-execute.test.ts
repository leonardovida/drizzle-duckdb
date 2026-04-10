import { describe, expect, test } from 'vitest';
import {
  executeArrowOnClient,
  executeArraysOnClient,
  executeInBatches,
  executeInBatchesRaw,
  executeOnClient,
  type DuckDBClientLike,
} from '../src/client.ts';

function makeClient(options: {
  arrowValue?: unknown;
  fallbackValue?: unknown;
  rows?: unknown[][];
  jsonRows?: unknown[][];
  columns?: string[];
  deduplicatedColumns?: string[];
  columnTypeIds?: number[];
  onDeduplicatedColumns?: () => void;
  onStreamClose?: () => void;
}): DuckDBClientLike {
  const {
    arrowValue,
    fallbackValue = {},
    rows = [[1], [2], [3]],
    jsonRows = rows,
    columns = ['id'],
    columnTypeIds,
    onStreamClose,
  } = options;
  const deduplicatedColumns = Object.prototype.hasOwnProperty.call(
    options,
    'deduplicatedColumns'
  )
    ? options.deduplicatedColumns
    : ['id'];

  return {
    async run(_query: string, _values?: unknown[]) {
      return {
        toArrow: arrowValue === undefined ? undefined : async () => arrowValue,
        getColumnsObjectJS: async () => fallbackValue,
        getColumnsObjectJson: async () => fallbackValue,
        getRowsJS: async () => rows,
        getRowsJson: async () => jsonRows,
        columnNames: () => columns,
        columnCount: columns.length,
        columnTypeId:
          columnTypeIds === undefined
            ? undefined
            : (index: number) => columnTypeIds[index] ?? -1,
        deduplicatedColumnNames:
          deduplicatedColumns === undefined
            ? undefined
            : () => {
                options.onDeduplicatedColumns?.();
                return deduplicatedColumns;
              },
      };
    },
    async stream(_query: string, _values?: unknown[]) {
      return {
        columnNames: () => columns,
        deduplicatedColumnNames:
          deduplicatedColumns === undefined
            ? undefined
            : () => {
                options.onDeduplicatedColumns?.();
                return deduplicatedColumns;
              },
        async *yieldRowsJs() {
          yield rows;
        },
        close() {
          onStreamClose?.();
        },
      };
    },
  };
}

describe('executeArrowOnClient', () => {
  test('prefers toArrow when available', async () => {
    const result = { arrow: true };
    const client = makeClient({
      arrowValue: result,
      fallbackValue: { fallback: true },
    });

    const data = await executeArrowOnClient(client, 'select 1', []);
    expect(data).toBe(result);
  });

  test('falls back to getColumnsObjectJS when Arrow unavailable', async () => {
    const fallback = { columns: true };
    const client = makeClient({ fallbackValue: fallback });

    const data = await executeArrowOnClient(client, 'select 1', []);
    expect(data).toBe(fallback);
  });

  test('uses JSON column materialization for precise time families', async () => {
    const fallback = { ts_ns: ['2024-03-01 12:34:56.123456789'] };
    const client = makeClient({
      fallbackValue: fallback,
      columns: ['ts_ns'],
      columnTypeIds: [22],
    });

    const data = await executeArrowOnClient(client, 'select 1', []);
    expect(data).toBe(fallback);
  });

  test('releases pooled connections after execution', async () => {
    const connection = makeClient({ fallbackValue: { columns: true } });
    let releaseCalls = 0;
    const pool: DuckDBClientLike = {
      acquire: async () => connection as any,
      release: async () => {
        releaseCalls += 1;
      },
    } as DuckDBClientLike;

    await executeArrowOnClient(pool, 'select 1', []);

    expect(releaseCalls).toBe(1);
  });
});

describe('executeInBatches', () => {
  test('yields chunks respecting rowsPerChunk', async () => {
    const client = makeClient({});
    const chunks: Array<Array<{ id: number }>> = [];

    for await (const chunk of executeInBatches(client, 'select', [], {
      rowsPerChunk: 2,
    })) {
      chunks.push(chunk as Array<{ id: number }>);
    }

    expect(chunks).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });

  test('falls back to the default chunk size for non-positive rowsPerChunk', async () => {
    const client = makeClient({
      rows: [[1], [2], [3]],
    });
    const chunks: Array<Array<{ id: number }>> = [];

    for await (const chunk of executeInBatches(client, 'select', [], {
      rowsPerChunk: 0,
    })) {
      chunks.push(chunk as Array<{ id: number }>);
    }

    expect(chunks).toEqual([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
  });

  test('rounds fractional rowsPerChunk down to an integer', async () => {
    const client = makeClient({
      rows: [[1], [2], [3]],
    });
    const chunks: Array<Array<{ id: number }>> = [];

    for await (const chunk of executeInBatches(client, 'select', [], {
      rowsPerChunk: 1.9,
    })) {
      chunks.push(chunk as Array<{ id: number }>);
    }

    expect(chunks).toEqual([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]);
  });

  test('falls back to the default chunk size for non-finite rowsPerChunk', async () => {
    const rows = Array.from({ length: 100_001 }, (_, index) => [index + 1]);
    const client = makeClient({ rows });
    const chunkSizes: number[] = [];

    for await (const chunk of executeInBatches(client, 'select', [], {
      rowsPerChunk: Number.POSITIVE_INFINITY,
    })) {
      chunkSizes.push(chunk.length);
    }

    expect(chunkSizes).toEqual([100_000, 1]);
  });

  test('closes stream when consumer exits early', async () => {
    let closeCalls = 0;
    const client = makeClient({
      rows: [[1], [2], [3], [4]],
      onStreamClose: () => {
        closeCalls += 1;
      },
    });

    for await (const _chunk of executeInBatches(client, 'select', [], {
      rowsPerChunk: 1,
    })) {
      break;
    }

    expect(closeCalls).toBe(1);
  });
});

describe('executeOnClient', () => {
  test('normalizes node-api duplicate column suffixes for object rows', async () => {
    const client = makeClient({
      rows: [[1, 2]],
      columns: ['id', 'id'],
      deduplicatedColumns: ['id', 'id:1'],
    });

    const rows = await executeOnClient(client, 'select', []);

    expect(rows).toEqual([{ id: 1, id_1: 2 }]);
  });

  test('uses JSON materialization for precise time families', async () => {
    const client = makeClient({
      rows: [[new Date('2024-03-01T12:34:56.123Z')]],
      jsonRows: [['2024-03-01 12:34:56.123456789']],
      columns: ['ts_ns'],
      deduplicatedColumns: ['ts_ns'],
      columnTypeIds: [22],
    });

    const rows = await executeOnClient(client, 'select', []);

    expect(rows).toEqual([
      {
        ts_ns: '2024-03-01 12:34:56.123456789',
      },
    ]);
  });
});

describe('executeArraysOnClient', () => {
  test('normalizes node-api duplicate column suffixes for array results', async () => {
    const client = makeClient({
      rows: [[1, 2]],
      columns: ['id', 'id'],
      deduplicatedColumns: ['id', 'id:1'],
    });

    const result = await executeArraysOnClient(client, 'select', []);

    expect(result).toEqual({
      columns: ['id', 'id_1'],
      rows: [[1, 2]],
    });
  });
});

describe('executeInBatchesRaw', () => {
  test('normalizes node-api duplicate column suffixes when provided', async () => {
    let calls = 0;
    const client = makeClient({
      rows: [[1, 2]],
      columns: ['id', 'id'],
      deduplicatedColumns: ['id', 'id:1'],
      onDeduplicatedColumns: () => {
        calls += 1;
      },
    });
    const chunks: Array<{ columns: string[]; rows: unknown[][] }> = [];

    for await (const chunk of executeInBatchesRaw(client, 'select', [], {
      rowsPerChunk: 10,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ columns: ['id', 'id_1'], rows: [[1, 2]] }]);
    expect(calls).toBe(1);
  });

  test('deduplicates columnNames when deduplicatedColumnNames is unavailable', async () => {
    const client = makeClient({
      rows: [[1, 2]],
      columns: ['id', 'id'],
      deduplicatedColumns: undefined,
    });
    const chunks: Array<{ columns: string[]; rows: unknown[][] }> = [];

    for await (const chunk of executeInBatchesRaw(client, 'select', [], {
      rowsPerChunk: 10,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ columns: ['id', 'id_1'], rows: [[1, 2]] }]);
  });

  test('closes stream when consumer exits early', async () => {
    let closeCalls = 0;
    const client = makeClient({
      rows: [[1], [2], [3], [4]],
      onStreamClose: () => {
        closeCalls += 1;
      },
    });

    for await (const _chunk of executeInBatchesRaw(client, 'select', [], {
      rowsPerChunk: 1,
    })) {
      break;
    }

    expect(closeCalls).toBe(1);
  });

  test('deduplicates fallback column names when node-api does not provide them', async () => {
    const client = makeClient({
      rows: [[1, 2]],
      columns: ['id', 'id'],
      deduplicatedColumns: undefined,
    });
    const chunks: Array<{ columns: string[]; rows: unknown[][] }> = [];

    for await (const chunk of executeInBatchesRaw(client, 'select', [])) {
      chunks.push(chunk);
    }

    expect(chunks[0]?.columns).toEqual(['id', 'id_1']);
  });

  test('releases pooled connections when the consumer exits early', async () => {
    const connection = makeClient({
      rows: [[1], [2], [3]],
    });
    let releaseCalls = 0;
    const pool: DuckDBClientLike = {
      acquire: async () => connection as any,
      release: async () => {
        releaseCalls += 1;
      },
    } as DuckDBClientLike;

    for await (const _chunk of executeInBatchesRaw(pool, 'select', [], {
      rowsPerChunk: 1,
    })) {
      break;
    }

    expect(releaseCalls).toBe(1);
  });
});
