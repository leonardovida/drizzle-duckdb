import { describe, expect, test } from 'vitest';
import {
  parseStructFields,
  parseMapValue,
  splitTopLevel,
  buildDefault,
  toIdentifier,
  normalizeTypeLiteral,
} from '../src/introspect.ts';

describe('normalizeTypeLiteral', () => {
  test('canonicalizes character varying aliases', () => {
    expect(normalizeTypeLiteral('character varying')).toBe('VARCHAR');
    expect(normalizeTypeLiteral('character varying(255)[]')).toBe(
      'VARCHAR(255)[]'
    );
  });

  test('canonicalizes character aliases', () => {
    expect(normalizeTypeLiteral('character(8)')).toBe('CHAR(8)');
  });

  test('canonicalizes timestamp aliases', () => {
    expect(normalizeTypeLiteral('timestamp without time zone')).toBe(
      'TIMESTAMP'
    );
    expect(normalizeTypeLiteral('timestamptz')).toBe(
      'TIMESTAMP WITH TIME ZONE'
    );
  });

  test.each([
    'smallint',
    'int2',
    'int16',
    'tinyint',
    'integer',
    'int',
    'int4',
    'signed',
  ])('canonicalizes integer alias %s', (alias) => {
    expect(normalizeTypeLiteral(alias)).toBe(alias.toUpperCase());
  });
});

describe('parseStructFields', () => {
  test('parses simple struct fields', () => {
    const result = parseStructFields('name VARCHAR, age INTEGER');
    expect(result).toEqual([
      { name: 'name', type: 'VARCHAR' },
      { name: 'age', type: 'INTEGER' },
    ]);
  });

  test('parses nested struct field', () => {
    const result = parseStructFields(
      'name VARCHAR, details STRUCT(a INT, b TEXT)'
    );
    // Check that we got the expected number of fields
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]?.name).toBe('name');
    expect(result[0]?.type).toBe('VARCHAR');
  });

  test('parses quoted field names', () => {
    const result = parseStructFields('"my_field" VARCHAR');
    expect(result).toEqual([{ name: 'my_field', type: 'VARCHAR' }]);
  });

  test('returns empty array for empty string', () => {
    const result = parseStructFields('');
    expect(result).toEqual([]);
  });

  test('skips malformed entries without space', () => {
    const result = parseStructFields('validname VARCHAR, malformed');
    expect(result).toEqual([{ name: 'validname', type: 'VARCHAR' }]);
  });

  test('handles multiple nested levels', () => {
    const result = parseStructFields(
      'data STRUCT(inner STRUCT(value INT)), name TEXT'
    );
    // Should parse at least the first field
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]?.name).toBeDefined();
  });

  test('handles array types in fields', () => {
    const result = parseStructFields('tags VARCHAR[], count INTEGER');
    expect(result).toEqual([
      { name: 'tags', type: 'VARCHAR[]' },
      { name: 'count', type: 'INTEGER' },
    ]);
  });

  test('canonicalizes Postgres string aliases in nested fields', () => {
    const result = parseStructFields(
      'name character varying, tags character varying[]'
    );
    expect(result).toEqual([
      { name: 'name', type: 'VARCHAR' },
      { name: 'tags', type: 'VARCHAR[]' },
    ]);
  });

  test('handles whitespace around fields', () => {
    const result = parseStructFields('  name  VARCHAR  ,  age  INTEGER  ');
    // Should parse at least one field
    expect(result.length).toBeGreaterThanOrEqual(1);
    // First field should have name
    expect(result[0]?.name).toBeDefined();
  });
});

describe('parseMapValue', () => {
  test('extracts value type from simple MAP', () => {
    const result = parseMapValue('MAP(VARCHAR, INTEGER)');
    expect(result).toBe('INTEGER');
  });

  test('extracts array value type from MAP', () => {
    const result = parseMapValue('MAP(VARCHAR, INTEGER[])');
    expect(result).toBe('INTEGER[]');
  });

  test('extracts STRUCT value type from MAP', () => {
    const result = parseMapValue('MAP(TEXT, STRUCT(a INT))');
    expect(result).toBe('STRUCT(a INT)');
  });

  test('returns TEXT for malformed MAP with single part', () => {
    const result = parseMapValue('MAP(VARCHAR)');
    expect(result).toBe('TEXT');
  });

  test('returns TEXT for empty MAP', () => {
    const result = parseMapValue('MAP()');
    expect(result).toBe('TEXT');
  });

  test('handles nested MAP in value', () => {
    const result = parseMapValue('MAP(TEXT, MAP(TEXT, INT))');
    expect(result).toBe('MAP(TEXT, INT)');
  });

  test('canonicalizes Postgres string aliases in map values', () => {
    const result = parseMapValue('MAP(character varying, character varying[])');
    expect(result).toBe('VARCHAR[]');
  });
});

describe('splitTopLevel', () => {
  test('splits simple comma-separated values', () => {
    const result = splitTopLevel('a, b, c', ',');
    expect(result).toEqual(['a', ' b', ' c']);
  });

  test('preserves nested parentheses', () => {
    const result = splitTopLevel('a(1,2), b', ',');
    expect(result).toEqual(['a(1,2)', ' b']);
  });

  test('handles multiple nesting levels', () => {
    const result = splitTopLevel('MAP(K, STRUCT(a, b)), TEXT', ',');
    expect(result).toEqual(['MAP(K, STRUCT(a, b))', ' TEXT']);
  });

  test('handles unbalanced close parens gracefully', () => {
    const result = splitTopLevel('a), b', ',');
    expect(result).toEqual(['a)', ' b']);
  });

  test('returns single element for empty delimiter match', () => {
    const result = splitTopLevel('abc', ',');
    expect(result).toEqual(['abc']);
  });

  test('returns single empty element for empty string', () => {
    const result = splitTopLevel('', ',');
    expect(result).toEqual([]);
  });

  test('handles different delimiters', () => {
    const result = splitTopLevel('a;b;c', ';');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('handles deeply nested structures', () => {
    const result = splitTopLevel(
      'STRUCT(a STRUCT(b STRUCT(c INT))), TEXT',
      ','
    );
    expect(result).toEqual(['STRUCT(a STRUCT(b STRUCT(c INT)))', ' TEXT']);
  });
});

describe('buildDefault', () => {
  test('returns empty string for null', () => {
    const result = buildDefault(null);
    expect(result).toBe('');
  });

  test('returns empty string for empty string', () => {
    const result = buildDefault('');
    expect(result).toBe('');
  });

  test('returns empty string for NULL literal', () => {
    const result = buildDefault('NULL');
    expect(result).toBe('');
  });

  test('handles nextval sequence', () => {
    const result = buildDefault("nextval('my_seq')");
    expect(result).toBe(".default(sql`nextval('my_seq')`)");
  });

  test('handles current_timestamp', () => {
    const result = buildDefault('current_timestamp');
    expect(result).toBe('.defaultNow()');
  });

  test('handles current_timestamp()', () => {
    const result = buildDefault('current_timestamp()');
    expect(result).toBe('.defaultNow()');
  });

  test('handles now()', () => {
    const result = buildDefault('now()');
    expect(result).toBe('.defaultNow()');
  });

  test('handles boolean true', () => {
    const result = buildDefault('true');
    expect(result).toBe('.default(true)');
  });

  test('handles boolean false', () => {
    const result = buildDefault('false');
    expect(result).toBe('.default(false)');
  });

  test('handles numeric value', () => {
    const result = buildDefault('42');
    expect(result).toBe('.default(42)');
  });

  test('handles negative numeric value', () => {
    const result = buildDefault('-10');
    expect(result).toBe('.default(-10)');
  });

  test('handles float numeric value', () => {
    const result = buildDefault('3.14');
    expect(result).toBe('.default(3.14)');
  });

  test('handles string literal', () => {
    const result = buildDefault("'hello'");
    expect(result).toBe('.default("hello")');
  });

  test('handles string literal with escaped quotes', () => {
    const result = buildDefault("'don''t'");
    expect(result).toBe('.default("don\'t")');
  });

  test('returns empty string for complex expressions', () => {
    const result = buildDefault('some_function(x, y)');
    expect(result).toBe('');
  });

  test('handles whitespace around value', () => {
    const result = buildDefault('  42  ');
    expect(result).toBe('.default(42)');
  });
});

describe('toIdentifier', () => {
  test('converts snake_case to camelCase', () => {
    const result = toIdentifier('my_table');
    expect(result).toBe('myTable');
  });

  test('handles leading numbers by prefixing with t', () => {
    const result = toIdentifier('123_bad');
    expect(result).toBe('t123Bad');
  });

  test('replaces special characters with underscores', () => {
    const result = toIdentifier('my-table-name');
    expect(result).toBe('myTableName');
  });

  test('handles single word', () => {
    const result = toIdentifier('table');
    expect(result).toBe('table');
  });

  test('handles empty string', () => {
    const result = toIdentifier('');
    expect(result).toBe('item');
  });

  test('handles all special characters', () => {
    const result = toIdentifier('!!!');
    expect(result).toBe('item');
  });

  test('lowercases all parts', () => {
    const result = toIdentifier('MY_TABLE_NAME');
    expect(result).toBe('myTableName');
  });

  test('handles multiple underscores', () => {
    const result = toIdentifier('my__double__underscore');
    expect(result).toBe('myDoubleUnderscore');
  });

  test('handles mixed case input', () => {
    const result = toIdentifier('MyMixed_Case');
    expect(result).toBe('mymixedCase');
  });

  test('handles numbers in middle', () => {
    const result = toIdentifier('table_2_name');
    expect(result).toBe('table2Name');
  });
});
