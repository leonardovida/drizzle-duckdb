import {
  PgSelectBase,
  PgSelectBuilder,
  QueryBuilder,
  type SelectedFields,
} from 'drizzle-orm/pg-core/query-builders';
import type { PgSelectHKTBase } from 'drizzle-orm/pg-core/query-builders/select.types';
import { PgAsyncSelectBase } from 'drizzle-orm/pg-core/async/select';
import type { PgAsyncSelectHKT } from 'drizzle-orm/pg-core/async/select';
import type { PgSession } from 'drizzle-orm/pg-core/session';
import { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { Subquery, WithSubquery, type SQLWrapper } from 'drizzle-orm';
import { entityKind, is } from 'drizzle-orm/entity';
import { SelectionProxyHandler } from 'drizzle-orm/selection-proxy';
import { SQL, type Query } from 'drizzle-orm/sql/sql';
import { aliasFields, exposeSubqueryFields } from './sql/selection.ts';
import {
  resolveNullableObjectPaths,
  type SelectionFieldEntry,
} from './sql/result-mapper.ts';
import type { DuckDBDialect } from './dialect.ts';

type DistinctConfig =
  | boolean
  | {
      on: (PgColumn | SQLWrapper)[];
    };

type SelectBaseConfig = {
  table: unknown;
  fields: Record<string, unknown>;
  isPartialSelect: boolean;
  session: PgSession | undefined;
  dialect: DuckDBDialect;
  withList?: Subquery[];
  distinct?: DistinctConfig;
};

type SelectInternals = {
  config: { fields: Record<string, unknown> };
  tableName: string | undefined;
  as(alias: string): Subquery;
  getSelectedFields(): Record<string, unknown>;
  getSQL(): SQL;
};

/**
 * DuckDB resolves duplicate output names in subqueries and CTEs to the first
 * matching column, so selected fields are aliased by their keys. A table
 * selected whole, which can be joined, is aliased by table and column name.
 */
function aliasSelectFields(config: SelectBaseConfig): SelectBaseConfig {
  if (config.isPartialSelect) {
    return { ...config, fields: aliasFields(config.fields as SelectedFields) };
  }
  if (is(config.table, PgTable)) {
    return {
      ...config,
      fields: aliasFields(config.fields as SelectedFields, true),
    };
  }
  return config;
}

/**
 * Keep the fields of `select` qualified by the subquery alias when it becomes
 * a subquery (`.as()`), a CTE (`$with`) or a view. See exposeSubqueryFields().
 */
function qualifySubqueryFields(select: object): void {
  const internals = select as SelectInternals;

  internals.as = (alias) =>
    new Proxy(
      new Subquery(
        internals.getSQL(),
        exposeSubqueryFields(internals.config.fields),
        alias
      ),
      new SelectionProxyHandler({
        alias,
        sqlAliasedBehavior: 'alias',
        sqlBehavior: 'error',
      })
    );

  internals.getSelectedFields = () =>
    new Proxy(
      exposeSubqueryFields(internals.config.fields),
      new SelectionProxyHandler({
        alias: internals.tableName,
        sqlAliasedBehavior: 'alias',
        sqlBehavior: 'error',
      })
    );
}

type SelectPrepareInternals = {
  session: PgSession & {
    prepareQuery(
      query: Query,
      mode: 'arrays',
      name: string | boolean,
      mapper: unknown,
      queryMetadata: unknown,
      cacheConfig: unknown
    ): unknown;
  };
  dialect: DuckDBDialect;
  cacheConfig: unknown;
  joinsNotNullableMap: Record<string, boolean> | undefined;
  _resolveSelection(): SelectionFieldEntry[];
  getSQL(withCastCodecs?: boolean): SQL;
  getUsedTables(sql: SQL): string[];
};

/**
 * Select query of a database or transaction. It differs from drizzle-orm's
 * in its field aliases, and in how it finds the joined objects that become
 * null, which must see through those aliases.
 */
export class DuckDBAsyncSelectBase extends (PgAsyncSelectBase as unknown as new (
  config: SelectBaseConfig
) => object) {
  static readonly [entityKind]: string = 'DuckDBAsyncSelectQueryBuilder';
  private duckMapper: unknown;

  constructor(config: SelectBaseConfig) {
    super(aliasSelectFields(config));
    qualifySubqueryFields(this);
  }

  /** @internal */
  _prepare(name?: string | boolean, generateName = false): unknown {
    const internals = this as unknown as SelectPrepareInternals;
    const fields = internals._resolveSelection();
    const sequel = internals.getSQL(true);
    const query = internals.dialect.sqlToQuery(sequel);
    this.duckMapper ??= internals.dialect.mapperGenerators.rows(
      fields as Parameters<DuckDBDialect['mapperGenerators']['rows']>[0],
      resolveNullableObjectPaths(fields, internals.joinsNotNullableMap)
    );
    return internals.session.prepareQuery(
      query,
      'arrays',
      name ?? generateName,
      this.duckMapper,
      {
        type: 'select',
        tables: () => internals.getUsedTables(sequel),
      },
      internals.cacheConfig
    );
  }
}

/** Select query of a standalone query builder, which cannot run. */
export class DuckDBSelectBase extends (PgSelectBase as unknown as new (
  config: SelectBaseConfig
) => object) {
  static readonly [entityKind]: string = 'DuckDBSelectQueryBuilder';

  constructor(config: SelectBaseConfig) {
    super(aliasSelectFields(config));
    qualifySubqueryFields(this);
  }
}

type SelectBuilderConfig<TSelection> = {
  fields: TSelection;
  session: PgSession | undefined;
  dialect: DuckDBDialect;
  withList?: Subquery[];
  distinct?: DistinctConfig;
};

/**
 * drizzle-orm's select builder, building the driver's select queries. Every
 * select entry point uses it, so field aliases apply to all of them.
 */
export class DuckDBSelectBuilder<
  TSelection extends SelectedFields | undefined,
  THKT extends PgSelectHKTBase = PgAsyncSelectHKT,
> extends PgSelectBuilder<TSelection, THKT> {
  static override readonly [entityKind]: string = 'DuckDBSelectBuilder';

  constructor(config: SelectBuilderConfig<TSelection>) {
    super(
      config,
      (config.session
        ? DuckDBAsyncSelectBase
        : DuckDBSelectBase) as unknown as ConstructorParameters<
        typeof PgSelectBuilder
      >[1]
    );
  }
}

export function createDuckDBSelectBuilder<
  THKT extends PgSelectHKTBase = PgAsyncSelectHKT,
>(
  config: SelectBuilderConfig<SelectedFields | undefined>
): DuckDBSelectBuilder<SelectedFields | undefined, THKT> {
  return new DuckDBSelectBuilder<SelectedFields | undefined, THKT>({
    ...config,
    fields: config.fields ?? undefined,
  });
}

export function createDuckDBSelectMethods<
  THKT extends PgSelectHKTBase = PgAsyncSelectHKT,
>(
  session: PgSession | undefined,
  dialect: DuckDBDialect,
  withList?: Subquery[]
) {
  return {
    select: (fields?: SelectedFields) =>
      createDuckDBSelectBuilder<THKT>({
        fields,
        session,
        dialect,
        withList,
      }),
    selectDistinct: (fields?: SelectedFields) =>
      createDuckDBSelectBuilder<THKT>({
        fields,
        session,
        dialect,
        withList,
        distinct: true,
      }),
    selectDistinctOn: (
      on: (PgColumn | SQLWrapper)[],
      fields?: SelectedFields
    ) =>
      createDuckDBSelectBuilder<THKT>({
        fields,
        session,
        dialect,
        withList,
        distinct: { on },
      }),
  };
}

/** Query builder passed to `$with(...).as(qb => ...)`. */
export class DuckDBQueryBuilder extends QueryBuilder {
  static override readonly [entityKind]: string = 'DuckDBQueryBuilder';

  constructor(private duckDialect: DuckDBDialect) {
    super(duckDialect);
  }

  override with(...queries: WithSubquery[]): ReturnType<QueryBuilder['with']> {
    return createDuckDBSelectMethods(
      undefined,
      this.duckDialect,
      queries
    ) as unknown as ReturnType<QueryBuilder['with']>;
  }

  override select(): ReturnType<QueryBuilder['select']>;
  override select<TSelection extends SelectedFields>(
    fields: TSelection
  ): ReturnType<QueryBuilder['select']>;
  override select(fields?: SelectedFields): ReturnType<QueryBuilder['select']> {
    return createDuckDBSelectMethods(undefined, this.duckDialect).select(
      fields
    ) as unknown as ReturnType<QueryBuilder['select']>;
  }

  override selectDistinct(): ReturnType<QueryBuilder['selectDistinct']>;
  override selectDistinct<TSelection extends SelectedFields>(
    fields: TSelection
  ): ReturnType<QueryBuilder['selectDistinct']>;
  override selectDistinct(
    fields?: SelectedFields
  ): ReturnType<QueryBuilder['selectDistinct']> {
    return createDuckDBSelectMethods(
      undefined,
      this.duckDialect
    ).selectDistinct(fields) as unknown as ReturnType<
      QueryBuilder['selectDistinct']
    >;
  }

  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[]
  ): ReturnType<QueryBuilder['selectDistinctOn']>;
  override selectDistinctOn<TSelection extends SelectedFields>(
    on: (PgColumn | SQLWrapper)[],
    fields: TSelection
  ): ReturnType<QueryBuilder['selectDistinctOn']>;
  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[],
    fields?: SelectedFields
  ): ReturnType<QueryBuilder['selectDistinctOn']> {
    return createDuckDBSelectMethods(
      undefined,
      this.duckDialect
    ).selectDistinctOn(on, fields) as unknown as ReturnType<
      QueryBuilder['selectDistinctOn']
    >;
  }
}
