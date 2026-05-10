import { is } from 'drizzle-orm/entity';
import { sql, Subquery, type SQLWrapper } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PgViewBase } from 'drizzle-orm/pg-core/view-base';
import type { SelectedFields } from 'drizzle-orm/pg-core/query-builders';
import { SQL, isSQLWrapper } from 'drizzle-orm/sql/sql';
import { Column, getTableName } from 'drizzle-orm';
import type { DuckDBDatabase } from './driver.ts';

export const countN = (expr: SQLWrapper = sql`*`) =>
  sql<number>`count(${expr})`.mapWith(Number);

export const sumN = (expr: SQLWrapper) =>
  sql<number>`sum(${expr})`.mapWith(Number);

export const avgN = (expr: SQLWrapper) =>
  sql<number>`avg(${expr})`.mapWith(Number);

export const sumDistinctN = (expr: SQLWrapper) =>
  sql<number>`sum(distinct ${expr})`.mapWith(Number);

export const percentileCont = (p: number, expr: SQLWrapper) =>
  sql<number>`percentile_cont(${p}) within group (order by ${expr})`.mapWith(
    Number
  );

export const median = (expr: SQLWrapper) => percentileCont(0.5, expr);

export const anyValue = <T = unknown>(expr: SQLWrapper) =>
  sql<T>`any_value(${expr})`;

type LanceSqlArgument =
  | SQLWrapper
  | string
  | number
  | boolean
  | readonly unknown[];

export interface LanceVectorSearchOptions {
  k?: number;
  useIndex?: boolean;
  nprobs?: number;
  refineFactor?: number;
  prefilter?: boolean;
  explainVerbose?: boolean;
}

export interface LanceFtsOptions {
  k?: number;
  prefilter?: boolean;
}

export interface LanceHybridSearchOptions {
  k?: number;
  nprobs?: number;
  refineFactor?: number;
  prefilter?: boolean;
  useIndex?: boolean;
  alpha?: number;
  oversampleFactor?: number;
}

type LanceNamedParamSpec<TOptions> = {
  key: keyof TOptions;
  sqlName: string;
};

function lanceNamedParams<TOptions extends object>(
  options: TOptions | undefined,
  specs: LanceNamedParamSpec<TOptions>[]
): SQL {
  if (!options) {
    return sql``;
  }

  const chunks: SQL[] = [];
  for (const { key, sqlName } of specs) {
    const value = options[key];
    if (value !== undefined) {
      chunks.push(sql`${sql.raw(sqlName)} = ${value}`);
    }
  }

  return chunks.length > 0 ? sql`, ${sql.join(chunks, sql`, `)}` : sql``;
}

function lanceArg(value: LanceSqlArgument): SQLWrapper {
  return isSQLWrapper(value) ? value : sql.param(value);
}

const lanceVectorSearchOptions: LanceNamedParamSpec<LanceVectorSearchOptions>[] =
  [
    { key: 'k', sqlName: 'k' },
    { key: 'useIndex', sqlName: 'use_index' },
    { key: 'nprobs', sqlName: 'nprobs' },
    { key: 'refineFactor', sqlName: 'refine_factor' },
    { key: 'prefilter', sqlName: 'prefilter' },
    { key: 'explainVerbose', sqlName: 'explain_verbose' },
  ];

const lanceFtsOptions: LanceNamedParamSpec<LanceFtsOptions>[] = [
  { key: 'k', sqlName: 'k' },
  { key: 'prefilter', sqlName: 'prefilter' },
];

const lanceHybridSearchOptions: LanceNamedParamSpec<LanceHybridSearchOptions>[] =
  [
    { key: 'k', sqlName: 'k' },
    { key: 'nprobs', sqlName: 'nprobs' },
    { key: 'refineFactor', sqlName: 'refine_factor' },
    { key: 'prefilter', sqlName: 'prefilter' },
    { key: 'useIndex', sqlName: 'use_index' },
    { key: 'alpha', sqlName: 'alpha' },
    { key: 'oversampleFactor', sqlName: 'oversample_factor' },
  ];

export function lanceVectorSearch(
  table: LanceSqlArgument,
  vectorColumn: LanceSqlArgument,
  queryVector: LanceSqlArgument,
  options?: LanceVectorSearchOptions
): SQL {
  return sql`lance_vector_search(${lanceArg(table)}, ${lanceArg(
    vectorColumn
  )}, ${lanceArg(queryVector)}${lanceNamedParams(
    options,
    lanceVectorSearchOptions
  )})`;
}

export function lanceFts(
  table: LanceSqlArgument,
  textColumn: LanceSqlArgument,
  queryText: LanceSqlArgument,
  options?: LanceFtsOptions
): SQL {
  return sql`lance_fts(${lanceArg(table)}, ${lanceArg(textColumn)}, ${lanceArg(
    queryText
  )}${lanceNamedParams(options, lanceFtsOptions)})`;
}

export function lanceHybridSearch(
  table: LanceSqlArgument,
  vectorColumn: LanceSqlArgument,
  queryVector: LanceSqlArgument,
  textColumn: LanceSqlArgument,
  queryText: LanceSqlArgument,
  options?: LanceHybridSearchOptions
): SQL {
  return sql`lance_hybrid_search(${lanceArg(table)}, ${lanceArg(
    vectorColumn
  )}, ${lanceArg(queryVector)}, ${lanceArg(textColumn)}, ${lanceArg(
    queryText
  )}${lanceNamedParams(options, lanceHybridSearchOptions)})`;
}

type PartitionOrder =
  | {
      partitionBy?: SQLWrapper | SQLWrapper[];
      orderBy?: SQLWrapper | SQLWrapper[];
    }
  | undefined;

function normalizeArray<T>(value?: T | T[]): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function overClause(options?: PartitionOrder) {
  const partitions = normalizeArray(options?.partitionBy);
  const orders = normalizeArray(options?.orderBy);

  const chunks: SQLWrapper[] = [];

  if (partitions.length > 0) {
    chunks.push(sql`partition by ${sql.join(partitions, sql`, `)}`);
  }

  if (orders.length > 0) {
    chunks.push(sql`order by ${sql.join(orders, sql`, `)}`);
  }

  if (chunks.length === 0) {
    return sql``;
  }

  return sql`over (${sql.join(chunks, sql` `)})`;
}

export const rowNumber = (options?: PartitionOrder) =>
  sql<number>`row_number() ${overClause(options)}`.mapWith(Number);

export const rank = (options?: PartitionOrder) =>
  sql<number>`rank() ${overClause(options)}`.mapWith(Number);

export const denseRank = (options?: PartitionOrder) =>
  sql<number>`dense_rank() ${overClause(options)}`.mapWith(Number);

export const lag = <T = unknown>(
  expr: SQLWrapper,
  offset = 1,
  defaultValue?: SQLWrapper,
  options?: PartitionOrder
) =>
  defaultValue
    ? sql<T>`lag(${expr}, ${offset}, ${defaultValue}) ${overClause(options)}`
    : sql<T>`lag(${expr}, ${offset}) ${overClause(options)}`;

export const lead = <T = unknown>(
  expr: SQLWrapper,
  offset = 1,
  defaultValue?: SQLWrapper,
  options?: PartitionOrder
) =>
  defaultValue
    ? sql<T>`lead(${expr}, ${offset}, ${defaultValue}) ${overClause(options)}`
    : sql<T>`lead(${expr}, ${offset}) ${overClause(options)}`;

type ValueExpr = SQL | SQL.Aliased | AnyPgColumn;
type GroupKey = ValueExpr;
type MeasureMap = Record<string, ValueExpr>;
type NonAggMap = Record<string, ValueExpr>;

function keyAlias(key: SQLWrapper, fallback: string): string {
  if (is(key, SQL.Aliased)) {
    return key.fieldAlias ?? fallback;
  }
  if (is(key, Column)) {
    return `${getTableName(key.table)}.${key.name}`;
  }
  return fallback;
}

export class OlapBuilder {
  private source?: PgTable | Subquery | PgViewBase | SQL;
  private keys: GroupKey[] = [];
  private measureMap: MeasureMap = {};
  private nonAggregates: NonAggMap = {};
  private wrapNonAggWithAnyValue = false;
  private orderByClauses: ValueExpr[] = [];

  constructor(private db: DuckDBDatabase) {}

  from(source: PgTable | Subquery | PgViewBase | SQL): this {
    this.source = source;
    return this;
  }

  groupBy(keys: GroupKey[]): this {
    this.keys = keys;
    return this;
  }

  measures(measures: MeasureMap): this {
    this.measureMap = measures;
    return this;
  }

  selectNonAggregates(
    fields: NonAggMap,
    options: { anyValue?: boolean } = {}
  ): this {
    this.nonAggregates = fields;
    this.wrapNonAggWithAnyValue = options.anyValue ?? false;
    return this;
  }

  orderBy(...clauses: ValueExpr[]): this {
    this.orderByClauses = clauses;
    return this;
  }

  build() {
    if (!this.source) {
      throw new Error('olap: .from() is required');
    }
    if (this.keys.length === 0) {
      throw new Error('olap: .groupBy() is required');
    }
    if (Object.keys(this.measureMap).length === 0) {
      throw new Error('olap: .measures() is required');
    }

    const selection: Record<string, ValueExpr> = {};

    this.keys.forEach((key, idx) => {
      const alias = keyAlias(key, `key_${idx}`);
      selection[alias] = key;
    });

    Object.entries(this.nonAggregates).forEach(([alias, expr]) => {
      selection[alias] = this.wrapNonAggWithAnyValue ? anyValue(expr) : expr;
    });

    Object.assign(selection, this.measureMap);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle's query builder types don't allow reassignment after groupBy
    let query: any = this.db
      .select(selection as SelectedFields)
      .from(this.source!)
      .groupBy(...this.keys);

    if (this.orderByClauses.length > 0) {
      query = query.orderBy(...this.orderByClauses);
    }

    return query;
  }

  run() {
    return this.build();
  }
}

export const olap = (db: DuckDBDatabase) => new OlapBuilder(db);
