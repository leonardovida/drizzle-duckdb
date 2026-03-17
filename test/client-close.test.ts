import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { expect, test, vi } from 'vitest';
import { closeClientConnection, closeDuckDbInstance } from '../src/client.ts';

test('closeClientConnection prefers async close when available', async () => {
  const close = vi.fn(async () => undefined);
  const closeSync = vi.fn();
  const disconnectSync = vi.fn();

  await closeClientConnection({
    close,
    closeSync,
    disconnectSync,
  } as unknown as DuckDBConnection);

  expect(close).toHaveBeenCalledTimes(1);
  expect(closeSync).not.toHaveBeenCalled();
  expect(disconnectSync).not.toHaveBeenCalled();
});

test('closeClientConnection falls back to disconnectSync', async () => {
  const disconnectSync = vi.fn();

  await closeClientConnection({
    disconnectSync,
  } as unknown as DuckDBConnection);

  expect(disconnectSync).toHaveBeenCalledTimes(1);
});

test('closeDuckDbInstance prefers async close when available', async () => {
  const close = vi.fn(async () => undefined);
  const closeSync = vi.fn();

  await closeDuckDbInstance({
    close,
    closeSync,
  } as unknown as DuckDBInstance);

  expect(close).toHaveBeenCalledTimes(1);
  expect(closeSync).not.toHaveBeenCalled();
});
