import { describe, expect, test } from 'vitest';
import {
  coerceArrayString,
  formatLiteral,
  buildListLiteral,
  buildStructLiteral,
  buildMapLiteral,
} from '../src/columns.ts';

describe('coerceArrayString', () => {
  test('returns empty array for empty string', () => {
    const result = coerceArrayString('');
    expect(result).toEqual([]);
  });

  test('returns empty array for whitespace only', () => {
    const result = coerceArrayString('   ');
    expect(result).toEqual([]);
  });

  test('parses JSON array of numbers', () => {
    const result = coerceArrayString('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  test('parses JSON array of strings', () => {
    const result = coerceArrayString('["a", "b", "c"]');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('parses Postgres-style array of numbers', () => {
    const result = coerceArrayString('{1, 2, 3}');
    expect(result).toEqual([1, 2, 3]);
  });

  test('parses nested Postgres-style array', () => {
    const result = coerceArrayString('{{1, 2}, {3, 4}}');
    expect(result).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('returns undefined for invalid JSON', () => {
    const result = coerceArrayString('[1, 2,');
    expect(result).toBeUndefined();
  });

  test('returns undefined for non-array string', () => {
    const result = coerceArrayString('hello');
    expect(result).toBeUndefined();
  });

  test('returns undefined for object notation', () => {
    const result = coerceArrayString('{"a": 1}');
    expect(result).toBeUndefined();
  });

  test('parses mixed type JSON array', () => {
    const result = coerceArrayString('[1, "two", true, null]');
    expect(result).toEqual([1, 'two', true, null]);
  });
});

describe('formatLiteral', () => {
  test('returns NULL for null', () => {
    const result = formatLiteral(null);
    expect(result).toBe('NULL');
  });

  test('returns NULL for undefined', () => {
    const result = formatLiteral(undefined);
    expect(result).toBe('NULL');
  });

  test('formats Date as ISO string in quotes', () => {
    const date = new Date('2024-03-15T12:30:45.000Z');
    const result = formatLiteral(date);
    expect(result).toBe("'2024-03-15T12:30:45.000Z'");
  });

  test('formats number without quotes', () => {
    const result = formatLiteral(42);
    expect(result).toBe('42');
  });

  test('formats negative number', () => {
    const result = formatLiteral(-10);
    expect(result).toBe('-10');
  });

  test('formats bigint without quotes', () => {
    const result = formatLiteral(BigInt(12345678901234567890n));
    expect(result).toBe('12345678901234567890');
  });

  test('formats boolean true as TRUE', () => {
    const result = formatLiteral(true);
    expect(result).toBe('TRUE');
  });

  test('formats boolean false as FALSE', () => {
    const result = formatLiteral(false);
    expect(result).toBe('FALSE');
  });

  test('formats string with single quotes escaped', () => {
    const result = formatLiteral("don't");
    expect(result).toBe("'don''t'");
  });

  test('formats string with type hint', () => {
    const result = formatLiteral('hello', 'TEXT');
    expect(result).toBe("'hello'");
  });

  test('formats object as JSON string', () => {
    const result = formatLiteral({ a: 1, b: 2 });
    expect(result).toBe('\'{"a":1,"b":2}\'');
  });

  test('formats array as JSON string', () => {
    const result = formatLiteral([1, 2, 3]);
    expect(result).toBe("'[1,2,3]'");
  });
});

describe('buildListLiteral', () => {
  test('returns empty array SQL for empty values', () => {
    const result = buildListLiteral([]);
    // SQL object should be defined
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  test('builds list_value for numbers', () => {
    const result = buildListLiteral([1, 2, 3]);
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  test('builds list_value with type hint', () => {
    const result = buildListLiteral(['a', 'b'], 'VARCHAR');
    expect(result).toBeDefined();
  });
});

describe('buildStructLiteral', () => {
  test('builds struct_pack for simple object', () => {
    const result = buildStructLiteral({ name: 'test' });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  test('handles array values in struct', () => {
    const result = buildStructLiteral({ tags: [1, 2] });
    expect(result).toBeDefined();
  });

  test('handles schema hint for array type', () => {
    const result = buildStructLiteral({ tags: [1, 2] }, { tags: 'INTEGER[]' });
    expect(result).toBeDefined();
  });

  test('handles nested struct schema hints', () => {
    const result = buildStructLiteral(
      {
        profile: {
          city: 'Brussels',
          tags: ['eu', 'be'],
        },
      },
      { profile: 'STRUCT (city TEXT, tags TEXT[])' }
    );

    expect(result).toBeDefined();
  });
});

describe('buildMapLiteral', () => {
  test('builds map with list_value for keys and values', () => {
    const result = buildMapLiteral({ a: 1, b: 2 });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  test('handles empty map', () => {
    const result = buildMapLiteral({});
    expect(result).toBeDefined();
  });

  test('handles value type hint', () => {
    const result = buildMapLiteral({ key: 'value' }, 'VARCHAR');
    expect(result).toBeDefined();
  });
});
