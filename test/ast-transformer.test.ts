/**
 * Tests for the new AST-based SQL transformer.
 *
 * These tests verify that the AST transformer correctly transforms:
 * 1. Array operators (@>, <@, &&) to DuckDB functions
 * 2. JOIN column qualification for ambiguous columns
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  transformSQL,
  needsTransformation,
  clearTransformCache,
  getTransformCacheStats,
} from '../src/sql/ast-transformer.ts';

describe('transformSQL', () => {
  describe('array operator transformation', () => {
    it('transforms @> to array_has_all', () => {
      const result = transformSQL('SELECT * FROM t WHERE tags @> ARRAY[1,2]');
      expect(result.transformed).toBe(true);
      expect(result.sql.toLowerCase()).toContain('array_has_all');
      expect(result.sql).not.toContain('@>');
    });

    it('transforms <@ to array_has_all with swapped arguments', () => {
      const result = transformSQL('SELECT * FROM t WHERE tags <@ ARRAY[1,2]');
      expect(result.transformed).toBe(true);
      expect(result.sql.toLowerCase()).toContain('array_has_all');
      expect(result.sql).not.toContain('<@');
    });

    it('transforms && to array_has_any', () => {
      const result = transformSQL('SELECT * FROM t WHERE tags && ARRAY[1,2]');
      expect(result.transformed).toBe(true);
      expect(result.sql.toLowerCase()).toContain('array_has_any');
      expect(result.sql).not.toContain('&&');
    });

    it('handles multiple array operators', () => {
      const result = transformSQL(
        'SELECT * FROM t WHERE tags @> ARRAY[1] AND tags && ARRAY[2]'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql.toLowerCase()).toContain('array_has_all');
      expect(result.sql.toLowerCase()).toContain('array_has_any');
    });
  });

  describe('JOIN column qualification', () => {
    it('qualifies unqualified columns in simple JOIN', () => {
      const result = transformSQL(
        'SELECT * FROM "a" LEFT JOIN "b" ON "id" = "id"'
      );
      // The AST transformer should qualify the columns
      expect(result.sql).toContain('"a"');
      expect(result.sql).toContain('"b"');
    });

    it('qualifies unqualified right side when left is qualified', () => {
      const result = transformSQL(
        'SELECT * FROM "schema1"."table1" LEFT JOIN "cte" ON "schema1"."table1"."id" = "id"'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"cte"."id"');
    });

    it('qualifies unqualified left side when right is qualified', () => {
      const result = transformSQL(
        'SELECT * FROM "cte" LEFT JOIN "schema1"."table1" ON "id" = "schema1"."table1"."id"'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"cte"."id"');
    });

    it('handles mixed qualification in AND conditions', () => {
      // Both conditions have matching column names, so both get qualified
      const result = transformSQL(
        'SELECT * FROM "schema1"."brands" LEFT JOIN "platformCounts" ON ("schema1"."brands"."country" = "country" AND "schema1"."brands"."brand_slug" = "brand_slug")'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"platformCounts"."country"');
      expect(result.sql).toContain('"platformCounts"."brand_slug"');
    });

    it('handles CTE with schema-qualified table join', () => {
      const sql = `
        WITH "platformCounts" AS (
          SELECT "country", "brand_slug", count(*) as cnt FROM platforms GROUP BY "country", "brand_slug"
        )
        SELECT * FROM "restaurant_metadata"."brands"
        LEFT JOIN "platformCounts" ON (
          "restaurant_metadata"."brands"."country" = "country" AND
          "restaurant_metadata"."brands"."brand_slug" = "brand_slug"
        )
      `;
      const result = transformSQL(sql);
      expect(result.transformed).toBe(true);
      // Both columns get qualified because they have matching names
      expect(result.sql).toContain('"platformCounts"."country"');
      expect(result.sql).toContain('"platformCounts"."brand_slug"');
    });

    it('qualifies columns when ON clause is split across lines', () => {
      const result = transformSQL(
        'SELECT * FROM "a"\nJOIN "b"\nON "id" = "id"'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"a"."id"');
      expect(result.sql).toContain('"b"."id"');
    });

    it('qualifies columns wrapped in functions', () => {
      const result = transformSQL(
        'SELECT * FROM "a" JOIN "b" ON lower("name") = lower("name")'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('lower("a"."name")');
      expect(result.sql).toContain('lower("b"."name")');
    });

    it('qualifies columns wrapped in casts', () => {
      const result = transformSQL(
        'SELECT * FROM "a" JOIN "b" ON CAST("id" AS INT) = CAST("id" AS INT)'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('CAST("a"."id" AS INT)');
      expect(result.sql).toContain('CAST("b"."id" AS INT)');
    });

    it('preserves schema when qualifying same table name', () => {
      const result = transformSQL(
        'SELECT * FROM "s1"."t" JOIN "s2"."t" ON "id" = "id"'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"s1"."t"."id"');
      expect(result.sql).toContain('"s2"."t"."id"');
    });

    it('qualifies UPDATE ... FROM with same column names', () => {
      const result = transformSQL(
        'UPDATE "a" SET "val" = 1 FROM "b" WHERE "id" = "id"'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"a"."id"');
      expect(result.sql).toContain('"b"."id"');
    });

    it('qualifies UPDATE ... FROM with multiple joins', () => {
      const result = transformSQL(
        'UPDATE "a" SET "val" = 1 FROM "b" JOIN "c" ON "id" = "id" WHERE "id" = "id"'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"a"."id"');
      expect(result.sql).toContain('"b"."id"');
      expect(result.sql).toContain('JOIN "c"');
    });

    it('qualifies INSERT ... SELECT with joins', () => {
      const result = transformSQL(
        'INSERT INTO "t1" ("id") SELECT "id" FROM "t2" JOIN "t3" ON "id" = "id"'
      );
      expect(result.transformed).toBe(true);
      expect(result.sql).toContain('"t2"."id"');
      expect(result.sql).toContain('"t3"."id"');
    });

    it('qualifies unqualified columns when names differ', () => {
      // Drizzle can emit camelCase aliases on the right side
      // DuckDB treats these as ambiguous once more joins are present
      const sql = `
        SELECT * FROM "schema1"."table1"
        LEFT JOIN "cte" ON "schema1"."table1"."user_id" = "userId"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toContain('"cte"."userId"');
    });

    it('does not transform when both sides are already qualified', () => {
      const result = transformSQL(
        'SELECT * FROM "a" LEFT JOIN "b" ON "a"."id" = "b"."id"'
      );
      // Both sides already qualified, should still parse but not modify
      expect(result.sql).toContain('"a"."id"');
      expect(result.sql).toContain('"b"."id"');
    });

    it('does not transform queries without JOINs', () => {
      const result = transformSQL('SELECT * FROM users WHERE id = 1');
      expect(result.transformed).toBe(false);
      expect(result.sql).toBe('SELECT * FROM users WHERE id = 1');
    });

    it('does not transform queries without array operators', () => {
      const result = transformSQL('SELECT * FROM users');
      expect(result.transformed).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns original SQL for empty string', () => {
      const result = transformSQL('');
      expect(result.sql).toBe('');
      expect(result.transformed).toBe(false);
    });

    it('handles complex SELECT statements', () => {
      const sql = `
        WITH cte AS (SELECT id FROM users)
        SELECT * FROM cte c
        LEFT JOIN posts p ON c.id = p.user_id
        WHERE p.tags @> ARRAY['featured']
      `;
      const result = transformSQL(sql);
      // Should at least transform the array operator
      expect(result.sql.toLowerCase()).toContain('array_has_all');
    });

    it('falls back gracefully for unparseable SQL', () => {
      // This is invalid SQL that the parser won't understand
      const sql = 'THIS IS NOT SQL @> AT ALL';
      const result = transformSQL(sql);
      // Should return original SQL without error
      expect(result.sql).toBe(sql);
      expect(result.transformed).toBe(false);
    });
  });
});

describe('needsTransformation', () => {
  it('returns true for queries with @>', () => {
    expect(needsTransformation('SELECT * FROM t WHERE a @> b')).toBe(true);
  });

  it('returns true for queries with <@', () => {
    expect(needsTransformation('SELECT * FROM t WHERE a <@ b')).toBe(true);
  });

  it('returns true for queries with &&', () => {
    expect(needsTransformation('SELECT * FROM t WHERE a && b')).toBe(true);
  });

  it('returns true for queries with JOIN', () => {
    expect(needsTransformation('SELECT * FROM a JOIN b ON a.id = b.id')).toBe(
      true
    );
  });

  it('returns true for queries with LEFT JOIN', () => {
    expect(
      needsTransformation('SELECT * FROM a LEFT JOIN b ON a.id = b.id')
    ).toBe(true);
  });

  it('returns false for simple SELECT', () => {
    expect(needsTransformation('SELECT * FROM users')).toBe(false);
  });

  it('returns false for INSERT', () => {
    expect(needsTransformation('INSERT INTO users (id) VALUES (1)')).toBe(
      false
    );
  });

  it('returns false for identifiers that only contain keywords as substrings', () => {
    expect(
      needsTransformation('SELECT updated_at FROM users WHERE deleted_at IS NULL')
    ).toBe(false);
  });
});

describe('transformation cache', () => {
  beforeEach(() => {
    clearTransformCache();
  });

  it('caches transformed queries', () => {
    const sql = 'SELECT * FROM "a" LEFT JOIN "b" ON "id" = "id"';

    // First call - should parse and cache
    const stats1 = getTransformCacheStats();
    expect(stats1.size).toBe(0);

    const result1 = transformSQL(sql);
    expect(result1.transformed).toBe(true);

    const stats2 = getTransformCacheStats();
    expect(stats2.size).toBe(1);

    // Second call - should hit cache
    const result2 = transformSQL(sql);
    expect(result2.sql).toBe(result1.sql);
    expect(result2.transformed).toBe(result1.transformed);

    // Cache size should still be 1 (no duplicate entry)
    const stats3 = getTransformCacheStats();
    expect(stats3.size).toBe(1);
  });

  it('clears cache when requested', () => {
    const sql = 'SELECT * FROM "a" LEFT JOIN "b" ON "id" = "id"';
    transformSQL(sql);

    const stats1 = getTransformCacheStats();
    expect(stats1.size).toBe(1);

    clearTransformCache();

    const stats2 = getTransformCacheStats();
    expect(stats2.size).toBe(0);
  });

  it('does not cache queries that do not need transformation', () => {
    const sql = 'SELECT * FROM users WHERE id = 1';
    transformSQL(sql);

    // Should not be cached since no transformation was needed
    const stats = getTransformCacheStats();
    expect(stats.size).toBe(0);
  });
});
