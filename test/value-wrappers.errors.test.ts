import { describe, expect, test } from 'vitest';
import {
  wrapList,
  wrapArray,
  wrapStruct,
  wrapMap,
  wrapBlob,
  wrapJson,
  wrapTimestamp,
  isDuckDBWrapper,
} from '../src/value-wrappers-core.ts';
import { wrapperToNodeApiValue } from '../src/value-wrappers.ts';

describe('Value Wrapper Edge Cases', () => {
  describe('isDuckDBWrapper', () => {
    test('returns true for valid wrapper object', () => {
      const wrapper = wrapList([1, 2, 3], 'INTEGER');
      expect(isDuckDBWrapper(wrapper)).toBe(true);
    });

    test('returns false for plain object', () => {
      expect(isDuckDBWrapper({ data: [1, 2, 3] })).toBe(false);
    });

    test('returns false for null', () => {
      expect(isDuckDBWrapper(null)).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(isDuckDBWrapper(undefined)).toBe(false);
    });

    test('returns false for primitive string', () => {
      expect(isDuckDBWrapper('hello')).toBe(false);
    });

    test('returns false for primitive number', () => {
      expect(isDuckDBWrapper(42)).toBe(false);
    });

    test('returns false for array', () => {
      expect(isDuckDBWrapper([1, 2, 3])).toBe(false);
    });
  });

  describe('Empty collections', () => {
    test('wrapList handles empty array', () => {
      const wrapper = wrapList([], 'INTEGER');
      expect(wrapper.kind).toBe('list');
      expect(wrapper.data).toEqual([]);
    });

    test('wrapArray handles empty array', () => {
      const wrapper = wrapArray([], 'INTEGER', 0);
      expect(wrapper.kind).toBe('array');
      expect(wrapper.data).toEqual([]);
    });

    test('wrapStruct handles empty object', () => {
      const wrapper = wrapStruct({});
      expect(wrapper.kind).toBe('struct');
      expect(wrapper.data).toEqual({});
    });

    test('wrapMap handles empty object', () => {
      const wrapper = wrapMap({}, 'INTEGER');
      expect(wrapper.kind).toBe('map');
      expect(wrapper.data).toEqual({});
    });

    test('wrapBlob handles empty buffer', () => {
      const wrapper = wrapBlob(new Uint8Array(0));
      expect(wrapper.kind).toBe('blob');
      expect(wrapper.data).toEqual(new Uint8Array(0));
    });
  });

  describe('wrapTimestamp edge cases', () => {
    test('wraps Date object correctly', () => {
      const date = new Date('2024-03-15T12:30:45.000Z');
      const wrapper = wrapTimestamp(date, false);
      expect(wrapper.kind).toBe('timestamp');
      // wrapTimestamp stores the original data, conversion happens later
      expect(wrapper.data).toBe(date);
    });

    test('wraps ISO string correctly', () => {
      const wrapper = wrapTimestamp('2024-03-15T12:30:45.000Z', false);
      expect(wrapper.kind).toBe('timestamp');
      expect(wrapper.data).toBe('2024-03-15T12:30:45.000Z');
    });

    test('wraps string without T separator', () => {
      const wrapper = wrapTimestamp('2024-03-15 12:30:45', false);
      expect(wrapper.kind).toBe('timestamp');
      expect(wrapper.data).toBe('2024-03-15 12:30:45');
    });

    test('wraps bigint microseconds directly', () => {
      const micros = BigInt(1710505845000000);
      const wrapper = wrapTimestamp(micros, false);
      expect(wrapper.kind).toBe('timestamp');
      expect(wrapper.data).toBe(micros);
    });

    test('stores number value as-is', () => {
      const millis = 1710505845000;
      const wrapper = wrapTimestamp(millis, false);
      expect(wrapper.kind).toBe('timestamp');
      // wrapTimestamp stores value as-is
      expect(wrapper.data).toBe(millis);
    });
  });

  describe('wrapJson edge cases', () => {
    test('wraps null correctly', () => {
      const wrapper = wrapJson(null);
      expect(wrapper.kind).toBe('json');
      expect(wrapper.data).toBe(null);
    });

    test('wraps nested object', () => {
      const data = { level1: { level2: { level3: 'deep' } } };
      const wrapper = wrapJson(data);
      expect(wrapper.kind).toBe('json');
      expect(wrapper.data).toEqual(data);
    });

    test('wraps array of objects', () => {
      const data = [{ a: 1 }, { b: 2 }];
      const wrapper = wrapJson(data);
      expect(wrapper.kind).toBe('json');
      expect(wrapper.data).toEqual(data);
    });
  });

  describe('Deeply nested structures', () => {
    test('wrapList with nested arrays', () => {
      const data = [
        [1, 2],
        [3, 4],
        [5, 6],
      ];
      const wrapper = wrapList(data, 'INTEGER[]');
      expect(wrapper.kind).toBe('list');
      expect(wrapper.data).toEqual(data);
    });

    test('wrapStruct with nested struct', () => {
      const data = {
        outer: {
          inner: {
            value: 42,
          },
        },
      };
      const wrapper = wrapStruct(data);
      expect(wrapper.kind).toBe('struct');
      expect(wrapper.data).toEqual(data);
    });

    test('wrapMap with nested values', () => {
      const data = {
        key1: { nested: 'value1' },
        key2: { nested: 'value2' },
      };
      const wrapper = wrapMap(data, 'JSON');
      expect(wrapper.kind).toBe('map');
      expect(wrapper.data).toEqual(data);
    });
  });

  describe('wrapperToNodeApiValue', () => {
    // Mock converter for testing
    const mockConverter = (
      val: unknown
    ): import('@duckdb/node-api').DuckDBValue =>
      val as import('@duckdb/node-api').DuckDBValue;

    test('handles list wrapper', () => {
      const wrapper = wrapList([1, 2, 3], 'INTEGER');
      const result = wrapperToNodeApiValue(wrapper, mockConverter);
      expect(result).toBeDefined();
    });

    test('handles array wrapper', () => {
      const wrapper = wrapArray([1, 2, 3], 'INTEGER', 3);
      const result = wrapperToNodeApiValue(wrapper, mockConverter);
      expect(result).toBeDefined();
    });

    test('handles struct wrapper', () => {
      const wrapper = wrapStruct({ name: 'test', value: 42 });
      const result = wrapperToNodeApiValue(wrapper, mockConverter);
      expect(result).toBeDefined();
    });

    test('handles map wrapper', () => {
      const wrapper = wrapMap({ key: 'value' }, 'VARCHAR');
      const result = wrapperToNodeApiValue(wrapper, mockConverter);
      expect(result).toBeDefined();
    });

    test('handles blob wrapper', () => {
      const wrapper = wrapBlob(new Uint8Array([1, 2, 3]));
      const result = wrapperToNodeApiValue(wrapper, mockConverter);
      expect(result).toBeDefined();
    });

    test('handles json wrapper', () => {
      const wrapper = wrapJson({ test: true });
      const result = wrapperToNodeApiValue(wrapper, mockConverter);
      expect(result).toBeDefined();
    });

    test('handles timestamp wrapper', () => {
      const wrapper = wrapTimestamp(new Date(), false);
      const result = wrapperToNodeApiValue(wrapper, mockConverter);
      expect(result).toBeDefined();
    });

    test('throws for unknown wrapper kind', () => {
      const fakeWrapper = {
        [Symbol.for('drizzle-duckdb-wrapper')]: true,
        kind: 'unknown_kind',
        data: null,
      };

      expect(() =>
        wrapperToNodeApiValue(fakeWrapper as any, mockConverter)
      ).toThrow(/unknown wrapper kind/i);
    });
  });
});
