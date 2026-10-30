-- DuckDB cannot add a column with a NOT NULL constraint, so the default fills existing rows.
ALTER TABLE "accounts" ADD COLUMN "monthly_limit" integer DEFAULT 10000;
