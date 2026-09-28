/**
 * Stress tests for the AST-based SQL transformer.
 *
 * These tests exercise complex SQL patterns to ensure the AST transformer
 * handles edge cases correctly without breaking valid SQL.
 */

import { describe, expect, it } from 'vitest';
import { transformSQL } from '../src/sql/ast-transformer.ts';

describe('AST Transformer Stress Tests', () => {
  describe('deeply nested subqueries', () => {
    it('handles 3 levels of nested subqueries with array operators', () => {
      const sql = `
        SELECT * FROM (
          SELECT * FROM (
            SELECT * FROM (
              SELECT id, tags FROM products WHERE tags @> ARRAY['featured']
            ) AS level3
          ) AS level2
        ) AS level1 WHERE id > 10
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles nested subqueries with JOINs at each level', () => {
      const sql = `
        SELECT * FROM (
          SELECT * FROM "a" LEFT JOIN "b" ON "id" = "id"
        ) AS sub1
        LEFT JOIN (
          SELECT * FROM "c" LEFT JOIN "d" ON "key" = "key"
        ) AS sub2 ON sub1.id = sub2.id
      `;
      const result = transformSQL(sql);
      // Should parse and process without errors
      expect(result.sql).toBeTruthy();
    });

    it('handles correlated subqueries in WHERE', () => {
      const sql = `
        SELECT * FROM products p
        WHERE p.tags @> (
          SELECT ARRAY_AGG(tag) FROM tags t
          WHERE t.category_id = p.category_id
        )
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });

  describe('complex CTEs', () => {
    it('handles multiple CTEs with cross-references', () => {
      const sql = `
        WITH
          base AS (SELECT id, name, tags FROM products),
          filtered AS (SELECT * FROM base WHERE tags @> ARRAY['active']),
          aggregated AS (SELECT COUNT(*) as cnt FROM filtered)
        SELECT * FROM filtered
        LEFT JOIN aggregated ON 1=1
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles recursive CTE pattern', () => {
      const sql = `
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, name, 1 as level
          FROM categories
          WHERE parent_id IS NULL
          UNION ALL
          SELECT c.id, c.parent_id, c.name, t.level + 1
          FROM categories c
          INNER JOIN tree t ON c.parent_id = t.id
        )
        SELECT * FROM tree
        LEFT JOIN products p ON "category_id" = "category_id"
      `;
      const result = transformSQL(sql);
      // Should handle the UNION ALL and recursive pattern
      expect(result.sql).toBeTruthy();
    });

    it('handles CTEs with same column names joining each other', () => {
      const sql = `
        WITH
          sales AS (SELECT region, SUM(amount) as total FROM orders GROUP BY region),
          targets AS (SELECT region, target FROM goals),
          comparison AS (
            SELECT s.region, s.total, t.target
            FROM sales s
            INNER JOIN targets t ON s.region = t.region
          )
        SELECT * FROM regions r
        LEFT JOIN comparison c ON "region" = "region"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles 5 CTEs with chain of dependencies', () => {
      const sql = `
        WITH
          cte1 AS (SELECT id, val FROM base_table),
          cte2 AS (SELECT id, val FROM cte1 WHERE val > 10),
          cte3 AS (SELECT id, val FROM cte2 WHERE val < 100),
          cte4 AS (SELECT id, val FROM cte3),
          cte5 AS (SELECT id, val, 'processed' as status FROM cte4)
        SELECT * FROM cte1
        LEFT JOIN cte5 ON "id" = "id"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });
  });

  describe('multiple array operators in single query', () => {
    it('handles all three array operators in one query', () => {
      const sql = `
        SELECT * FROM products
        WHERE tags @> ARRAY['featured']
          AND categories <@ ARRAY['electronics', 'computers', 'accessories']
          AND attributes && ARRAY['new', 'sale']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles array operators in HAVING clause', () => {
      const sql = `
        SELECT category, ARRAY_AGG(tag) as all_tags
        FROM products
        GROUP BY category
        HAVING ARRAY_AGG(tag) @> ARRAY['premium']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles array operators in SELECT expressions', () => {
      const sql = `
        SELECT
          id,
          tags @> ARRAY['featured'] AS is_featured,
          tags && ARRAY['sale', 'discount'] AS has_promotion
        FROM products
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles nested array operator expressions', () => {
      const sql = `
        SELECT * FROM products
        WHERE (tags @> ARRAY['a'] AND tags @> ARRAY['b'])
           OR (tags && ARRAY['c'] AND NOT tags @> ARRAY['d'])
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });

  describe('complex JOIN patterns', () => {
    it('handles 5-way join with same column names', () => {
      const sql = `
        SELECT * FROM "a"
        LEFT JOIN "b" ON "id" = "id"
        INNER JOIN "c" ON "id" = "id"
        RIGHT JOIN "d" ON "id" = "id"
        FULL JOIN "e" ON "id" = "id"
      `;
      const result = transformSQL(sql);
      // Should process all joins
      expect(result.sql).toBeTruthy();
    });

    it('handles self-join with aliases', () => {
      const sql = `
        SELECT e1.name as employee, e2.name as manager
        FROM employees e1
        LEFT JOIN employees e2 ON e1.manager_id = e2.id
        WHERE e1.department_id = e2.department_id
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles join with multiple conditions using AND', () => {
      const sql = `
        SELECT * FROM "orders" o
        LEFT JOIN "products" p ON "product_id" = "product_id" AND "region" = "region" AND "year" = "year"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles join with OR conditions', () => {
      const sql = `
        SELECT * FROM "a"
        LEFT JOIN "b" ON "id" = "id" OR "alt_id" = "alt_id"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles join with mixed qualified and unqualified columns', () => {
      const sql = `
        SELECT * FROM "orders" o
        LEFT JOIN "customers" c ON o.customer_id = c.id AND "status" = "status"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles CROSS JOIN followed by regular JOIN', () => {
      const sql = `
        SELECT * FROM "dates"
        CROSS JOIN "regions"
        LEFT JOIN "sales" ON "date" = "date" AND "region" = "region"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });
  });

  describe('UNION/INTERSECT/EXCEPT with transformations', () => {
    it('handles UNION with array operators in both branches', () => {
      const sql = `
        SELECT id, tags FROM products WHERE tags @> ARRAY['featured']
        UNION
        SELECT id, tags FROM archived_products WHERE tags @> ARRAY['featured']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles UNION ALL with JOINs in each branch', () => {
      const sql = `
        SELECT * FROM "a" LEFT JOIN "b" ON "id" = "id"
        UNION ALL
        SELECT * FROM "c" LEFT JOIN "d" ON "id" = "id"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles INTERSECT with nested subqueries', () => {
      const sql = `
        SELECT id FROM (SELECT * FROM products WHERE tags @> ARRAY['a']) sub1
        INTERSECT
        SELECT id FROM (SELECT * FROM products WHERE tags && ARRAY['b']) sub2
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles EXCEPT with CTEs', () => {
      const sql = `
        WITH all_products AS (SELECT id FROM products)
        SELECT id FROM all_products WHERE id > 100
        EXCEPT
        SELECT id FROM discontinued_products WHERE tags @> ARRAY['obsolete']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });

  describe('window functions with array operators', () => {
    it('handles array operators alongside window functions', () => {
      const sql = `
        SELECT
          id,
          tags,
          ROW_NUMBER() OVER (PARTITION BY category ORDER BY created_at) as rn,
          SUM(price) OVER (PARTITION BY category) as category_total
        FROM products
        WHERE tags @> ARRAY['active']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
      // Window function should be preserved
      expect(result.sql.toLowerCase()).toContain('over');
    });

    it('handles complex window with frame specification', () => {
      const sql = `
        SELECT
          date,
          sales,
          AVG(sales) OVER (
            PARTITION BY region
            ORDER BY date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
          ) as rolling_avg
        FROM daily_sales
        LEFT JOIN "regions" ON "region" = "region"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });
  });

  describe('CASE expressions with transformations', () => {
    it('handles array operators in CASE WHEN', () => {
      const sql = `
        SELECT
          id,
          CASE
            WHEN tags @> ARRAY['premium'] THEN 'Premium'
            WHEN tags && ARRAY['sale', 'discount'] THEN 'On Sale'
            ELSE 'Regular'
          END as product_tier
        FROM products
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles nested CASE expressions', () => {
      const sql = `
        SELECT
          CASE
            WHEN status = 'active' THEN
              CASE
                WHEN tags @> ARRAY['featured'] THEN 'Featured Active'
                ELSE 'Regular Active'
              END
            ELSE 'Inactive'
          END as display_status
        FROM products
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });

  describe('aggregations with transformations', () => {
    it('handles array operators with GROUP BY', () => {
      const sql = `
        SELECT
          category,
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE tags @> ARRAY['premium']) as premium_count
        FROM products
        WHERE tags && ARRAY['active', 'visible']
        GROUP BY category
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles complex aggregation with multiple JOINs', () => {
      const sql = `
        SELECT
          c.name as category,
          COUNT(DISTINCT p.id) as product_count,
          SUM(s.quantity) as total_sold
        FROM categories c
        LEFT JOIN products p ON "category_id" = "category_id"
        LEFT JOIN sales s ON "product_id" = "product_id"
        WHERE p.tags @> ARRAY['available']
        GROUP BY c.name
        HAVING SUM(s.quantity) > 100
      `;
      const result = transformSQL(sql);
      expect(result.transformed).toBe(true);
    });
  });

  describe('special characters and edge cases', () => {
    it('handles table names with special characters', () => {
      const sql = `
        SELECT * FROM "my-table-with-dashes"
        LEFT JOIN "another_table_with_underscores" ON "id" = "id"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles column names with spaces', () => {
      const sql = `
        SELECT * FROM "a"
        LEFT JOIN "b" ON "my column" = "my column"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles schema-qualified table names', () => {
      const sql = `
        SELECT * FROM "schema1"."table1"
        LEFT JOIN "schema2"."table2" ON "id" = "id"
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles very long identifiers', () => {
      const longName = 'a'.repeat(100);
      const sql = `
        SELECT * FROM "${longName}"
        LEFT JOIN "b" ON "id" = "id"
        WHERE tags @> ARRAY['test']
      `;
      const result = transformSQL(sql);
      expect(result.transformed).toBe(true);
    });

    it('handles empty ARRAY literals', () => {
      const sql = `
        SELECT * FROM products
        WHERE tags @> ARRAY[]::text[]
      `;
      const result = transformSQL(sql);
      // Should handle without crashing
      expect(result.sql).toBeTruthy();
    });

    it('preserves string literals containing operator-like text', () => {
      const sql = `
        SELECT * FROM products
        WHERE name = 'Product @> Special'
          AND description LIKE '%&&%'
          AND tags @> ARRAY['real-operator']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
      // String literals should be preserved
      expect(result.sql).toContain("'Product @> Special'");
    });
  });

  describe('subqueries in various positions', () => {
    it('handles subquery in SELECT list', () => {
      const sql = `
        SELECT
          p.id,
          p.name,
          (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id) as order_count
        FROM products p
        WHERE p.tags @> ARRAY['active']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles subquery in FROM with array operator', () => {
      const sql = `
        SELECT * FROM (
          SELECT id, tags FROM products WHERE tags @> ARRAY['featured']
        ) AS featured_products
        LEFT JOIN categories c ON featured_products.category_id = c.id
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles EXISTS with array operator', () => {
      const sql = `
        SELECT * FROM categories c
        WHERE EXISTS (
          SELECT 1 FROM products p
          WHERE p.category_id = c.id
            AND p.tags @> ARRAY['active']
        )
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles IN with subquery', () => {
      const sql = `
        SELECT * FROM products
        WHERE category_id IN (
          SELECT id FROM categories WHERE tags && ARRAY['featured']
        )
        AND tags @> ARRAY['available']
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });

  describe('ORDER BY and LIMIT with transformations', () => {
    it('handles ORDER BY with ambiguous column after JOIN', () => {
      const sql = `
        SELECT * FROM "orders" o
        LEFT JOIN "products" p ON "product_id" = "product_id"
        ORDER BY "created_at" DESC
        LIMIT 100
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });

    it('handles complex ORDER BY expressions', () => {
      const sql = `
        SELECT * FROM products
        WHERE tags @> ARRAY['active']
        ORDER BY
          CASE WHEN featured THEN 0 ELSE 1 END,
          created_at DESC NULLS LAST
        LIMIT 50 OFFSET 100
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });

  describe('INSERT/UPDATE/DELETE with array operators', () => {
    it('handles INSERT with SELECT containing array operator', () => {
      const sql = `
        INSERT INTO featured_products (id, name)
        SELECT id, name FROM products
        WHERE tags @> ARRAY['featured']
      `;
      const result = transformSQL(sql);
      // INSERT-SELECT should still transform the SELECT part
      expect(result.sql).toBeTruthy();
    });

    it('handles UPDATE with array operator in WHERE', () => {
      const sql = `
        UPDATE products
        SET status = 'archived'
        WHERE tags @> ARRAY['discontinued']
      `;
      const result = transformSQL(sql);
      // UPDATE WHERE should ideally be transformed
      // Note: Current implementation focuses on SELECT
      expect(result.sql).toBeTruthy();
    });

    it('handles DELETE with array operator in WHERE', () => {
      const sql = `
        DELETE FROM products
        WHERE tags @> ARRAY['temporary']
      `;
      const result = transformSQL(sql);
      expect(result.sql).toBeTruthy();
    });
  });

  describe('parser edge cases and fallbacks', () => {
    it('handles DuckDB-specific syntax gracefully', () => {
      // DuckDB has some syntax the Postgres parser might not understand
      const sql = `
        SELECT * FROM read_parquet('file.parquet')
        WHERE tags @> ['a', 'b']
      `;
      const result = transformSQL(sql);
      // Should return original if parser fails
      expect(result.sql).toBeTruthy();
    });

    it('handles comments in SQL', () => {
      const sql = `
        -- This is a comment with @> in it
        SELECT * FROM products
        WHERE tags @> ARRAY['test'] -- Another @> comment
        /* Block comment with && */
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });

    it('handles multiple statements (should process first)', () => {
      const sql = `
        SELECT * FROM products WHERE tags @> ARRAY['a'];
        SELECT * FROM categories WHERE tags && ARRAY['b'];
      `;
      const result = transformSQL(sql);
      // Parser behavior with multiple statements varies
      expect(result.sql).toBeTruthy();
    });

    it('handles extremely nested parentheses', () => {
      const sql = `
        SELECT * FROM products
        WHERE ((((tags @> ARRAY['a'])))) AND (((id > 0)))
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });

  describe('realistic complex queries', () => {
    it('handles e-commerce analytics query', () => {
      const sql = `
        WITH
          active_products AS (
            SELECT p.*, c.name as category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.tags @> ARRAY['active', 'visible']
          ),
          sales_summary AS (
            SELECT
              product_id,
              SUM(quantity) as total_qty,
              SUM(amount) as total_revenue
            FROM orders
            WHERE order_date >= '2024-01-01'
            GROUP BY product_id
          )
        SELECT
          ap.*,
          COALESCE(ss.total_qty, 0) as units_sold,
          COALESCE(ss.total_revenue, 0) as revenue,
          CASE
            WHEN ap.tags && ARRAY['premium'] THEN 'Premium'
            ELSE 'Standard'
          END as tier
        FROM active_products ap
        LEFT JOIN sales_summary ss ON "product_id" = "product_id"
        WHERE ap.tags && ARRAY['featured', 'new']
        ORDER BY revenue DESC
        LIMIT 100
      `;
      const result = transformSQL(sql);
      expect(result.transformed).toBe(true);
    });

    it('handles data warehouse style query with multiple JOINs', () => {
      const sql = `
        SELECT
          d.date,
          r.region_name,
          p.product_name,
          c.category_name,
          SUM(f.quantity) as quantity,
          SUM(f.revenue) as revenue
        FROM fact_sales f
        LEFT JOIN dim_date d ON "date_id" = "date_id"
        LEFT JOIN dim_region r ON "region_id" = "region_id"
        LEFT JOIN dim_product p ON "product_id" = "product_id"
        LEFT JOIN dim_category c ON "category_id" = "category_id"
        WHERE f.tags @> ARRAY['valid']
          AND d.year = 2024
          AND r.region_name IN ('North', 'South')
        GROUP BY d.date, r.region_name, p.product_name, c.category_name
        HAVING SUM(f.revenue) > 1000
        ORDER BY d.date, revenue DESC
      `;
      const result = transformSQL(sql);
      expect(result.transformed).toBe(true);
    });

    it('handles time series analysis query', () => {
      const sql = `
        WITH daily_metrics AS (
          SELECT
            DATE_TRUNC('day', timestamp) as day,
            COUNT(*) as events,
            COUNT(DISTINCT user_id) as unique_users
          FROM events
          WHERE tags && ARRAY['pageview', 'click']
          GROUP BY DATE_TRUNC('day', timestamp)
        )
        SELECT
          day,
          events,
          unique_users,
          AVG(events) OVER (
            ORDER BY day
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
          ) as events_7day_avg
        FROM daily_metrics
        ORDER BY day
      `;
      const result = transformSQL(sql);
      // Native array operators alone do not need a rewrite.
      expect(result).toEqual({ sql, transformed: false });
    });
  });
});
