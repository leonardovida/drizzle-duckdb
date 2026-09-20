import { pgTable } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import { duckDbTime } from '../src/columns.ts';
import { normalizeTime } from '../src/sql/result-mapper.ts';

const table = pgTable('time_decoding', { value: duckDbTime('value') });

test.each([
  [0n, '00:00:00.000'],
  [1_234_567n, '00:00:01.234'],
  [86_399_999_999n, '23:59:59.999'],
  [-1_000n, '23:59:59.999'],
  ['12:34:56.123456', '12:34:56.123456'],
] as const)('preserves time decoding for %s', (input, expected) => {
  expect(table.value.mapFromDriverValue(input)).toBe(expected);
  expect(normalizeTime(input)).toBe(expected);
});

test('both time decoders reject values outside the Date range', () => {
  const input = 10n ** 30n;
  expect(() => table.value.mapFromDriverValue(input)).toThrow(RangeError);
  expect(() => normalizeTime(input)).toThrow(RangeError);
});
