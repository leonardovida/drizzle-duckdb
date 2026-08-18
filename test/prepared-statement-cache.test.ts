import type {
  DuckDBConnection,
  DuckDBPreparedStatement,
} from '@duckdb/node-api';
import { expect, test, vi } from 'vitest';
import {
  bindPreparedStatement,
  clearPreparedStatementCache,
  getPreparedStatementCache,
} from '../src/prepared-statement-cache.ts';

function createStatement() {
  return {
    bind: vi.fn(),
    clearBindings: vi.fn(),
    destroySync: vi.fn(),
  } as unknown as DuckDBPreparedStatement;
}

test('reuses statements and evicts the least recently used entry', async () => {
  const statements = [createStatement(), createStatement(), createStatement()];
  const connection = {
    prepare: vi
      .fn()
      .mockResolvedValueOnce(statements[0])
      .mockResolvedValueOnce(statements[1])
      .mockResolvedValueOnce(statements[2]),
  } as unknown as DuckDBConnection;
  const cache = getPreparedStatementCache(connection, 2);

  expect(await cache.getOrPrepare('select 1')).toBe(statements[0]);
  expect(await cache.getOrPrepare('select 2')).toBe(statements[1]);
  expect(await cache.getOrPrepare('select 1')).toBe(statements[0]);
  expect(await cache.getOrPrepare('select 3')).toBe(statements[2]);

  expect(connection.prepare).toHaveBeenCalledTimes(3);
  expect(statements[0]?.destroySync).not.toHaveBeenCalled();
  expect(statements[1]?.destroySync).toHaveBeenCalledTimes(1);
  expect(statements[2]?.destroySync).not.toHaveBeenCalled();
});

test('evicts excess statements immediately when resized', async () => {
  const statements = [createStatement(), createStatement(), createStatement()];
  const connection = {
    prepare: vi
      .fn()
      .mockResolvedValueOnce(statements[0])
      .mockResolvedValueOnce(statements[1])
      .mockResolvedValueOnce(statements[2]),
  } as unknown as DuckDBConnection;
  const cache = getPreparedStatementCache(connection, 3);

  await cache.getOrPrepare('select 1');
  await cache.getOrPrepare('select 2');
  await cache.getOrPrepare('select 3');
  getPreparedStatementCache(connection, 1);

  expect(statements[0]?.destroySync).toHaveBeenCalledTimes(1);
  expect(statements[1]?.destroySync).toHaveBeenCalledTimes(1);
  expect(statements[2]?.destroySync).not.toHaveBeenCalled();
  expect(await cache.getOrPrepare('select 3')).toBe(statements[2]);
  expect(connection.prepare).toHaveBeenCalledTimes(3);
});

test('clears cached statements and preserves the cache instance', async () => {
  const statement = createStatement();
  const connection = {
    prepare: vi.fn().mockResolvedValue(statement),
  } as unknown as DuckDBConnection;
  const cache = getPreparedStatementCache(connection, 1);

  await cache.getOrPrepare('select 1');
  clearPreparedStatementCache(connection);

  expect(statement.destroySync).toHaveBeenCalledTimes(1);
  expect(getPreparedStatementCache(connection, 1)).toBe(cache);
  expect(await cache.getOrPrepare('select 1')).toBe(statement);
  expect(connection.prepare).toHaveBeenCalledTimes(2);
});

test('binds values and clears stale bindings when values are absent', () => {
  const statement = createStatement();
  const values = [42];

  bindPreparedStatement(statement, values);
  bindPreparedStatement(statement, undefined);

  expect(statement.bind).toHaveBeenCalledWith(values);
  expect(statement.clearBindings).toHaveBeenCalledTimes(1);
});
