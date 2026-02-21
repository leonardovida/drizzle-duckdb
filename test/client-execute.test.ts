import { describe, expect, test } from 'vitest';
import {
  executeArrowOnClient,
  executeInBatches,
  executeInBatchesRaw,
  type DuckDBClientLike,
} from '../src/client.ts';

function makeClient(options: {
  arrowValue?: unknown;
  fallbackValue?: unknown;
  rows?: unknown[][];
  onStreamClose?: () => void;
}): DuckDBClientLike {
  const {
    arrowValue,
    fallbackValue = {},
    rows = [[1], [2], [3]],
    onStreamClose,
  } = options;

  return {
    async run(_query: string, _values?: unknown[]) {
      return {
        toArrow: arrowValue === undefined ? undefined : async () => arrowValue,
        getColumnsObjectJS: async () => fallbackValue,
      };
    },
    async stream(_query: string, _values?: unknown[]) {
      return {
        deduplicatedColumnNames: () => ['id'],
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

describe('executeInBatchesRaw', () => {
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
});
