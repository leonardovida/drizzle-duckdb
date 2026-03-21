import { expect, test, vi } from 'vitest';
import { prepareParams } from '../src';

test('prepareParams coerces Postgres array literals', () => {
  const warn = vi.fn();
  const result = prepareParams([' {1,2,3} ', 42], {
    warnOnStringArrayLiteral: warn,
  });

  expect(result[0]).toEqual([1, 2, 3]);
  expect(result[1]).toBe(42);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('prepareParams coerces Postgres array literals with leading newlines', () => {
  const warn = vi.fn();
  const result = prepareParams(['\n{1,2,3}'], {
    warnOnStringArrayLiteral: warn,
  });

  expect(result[0]).toEqual([1, 2, 3]);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('prepareParams rejects string literals when configured', () => {
  expect(() =>
    prepareParams(['{hello,world}'], { rejectStringArrayLiterals: true })
  ).toThrow(/stringified array literals/i);
});

test('prepareParams leaves plain strings untouched', () => {
  const warn = vi.fn();
  const input = ['plain string', '{ not an array', 123];
  const result = prepareParams(input, { warnOnStringArrayLiteral: warn });

  expect(result).toEqual(input);
  expect(warn).not.toHaveBeenCalled();
});

test('prepareParams preserves unparsable Postgres array literals', () => {
  const warn = vi.fn();
  const input = ['{hello,world}'];
  const result = prepareParams(input, { warnOnStringArrayLiteral: warn });

  expect(result).toEqual(input);
  expect(warn).toHaveBeenCalledTimes(1);
});
