import {
  PgSelectBase,
  PgSelectBuilder,
  QueryBuilder,
  type CreatePgSelectFromBuilderMode,
  type SelectedFields,
  type TableLikeHasEmptySelection,
} from 'drizzle-orm/pg-core/query-builders';
import { PgColumn, PgTable, type PgSession } from 'drizzle-orm/pg-core';
import { Subquery, WithSubquery, type SQLWrapper } from 'drizzle-orm';
import { entityKind } from 'drizzle-orm/entity';
import { SelectionProxyHandler } from 'drizzle-orm/selection-proxy';
import { PgViewBase } from 'drizzle-orm/pg-core/view-base';
import type {
  GetSelectTableName,
  GetSelectTableSelection,
} from 'drizzle-orm/query-builders/select.types';
import { SQL } from 'drizzle-orm/sql/sql';
import {
  aliasFields,
  exposeSubqueryFields,
  getSelectSourceFields,
} from './sql/selection.ts';
import type { DuckDBDialect } from './dialect.ts';
import type { DrizzleTypeError } from 'drizzle-orm/utils';

type DistinctConfig =
  | boolean
  | {
      on: (PgColumn | SQLWrapper)[];
    };

type SelectInternals = {
  config: { fields: Record<string, unknown> };
  tableName: string | undefined;
  as(alias: string): Subquery;
  getSelectedFields(): Record<string, unknown>;
};

/**
 * Keep the fields of `select` qualified by the subquery alias when it becomes
 * a subquery (`.as()`), a CTE (`$with`) or a view. See exposeSubqueryFields().
 */
function qualifySubqueryFields<T>(select: T): T {
  const internals = select as unknown as SelectInternals;
  const baseAs = internals.as.bind(internals);

  internals.as = (alias) => {
    const { sql, usedTables } = baseAs(alias)._;
    return new Proxy(
      new Subquery(
        sql,
        exposeSubqueryFields(internals.config.fields),
        alias,
        false,
        usedTables
      ),
      new SelectionProxyHandler({
        alias,
        sqlAliasedBehavior: 'alias',
        sqlBehavior: 'error',
      })
    );
  };

  internals.getSelectedFields = () =>
    new Proxy(
      exposeSubqueryFields(internals.config.fields),
      new SelectionProxyHandler({
        alias: internals.tableName,
        sqlAliasedBehavior: 'alias',
        sqlBehavior: 'error',
      })
    );

  return select;
}

export class DuckDBSelectBuilder<
  TSelection extends SelectedFields | undefined,
  TBuilderMode extends 'db' | 'qb' = 'db',
> extends PgSelectBuilder<TSelection, TBuilderMode> {
  private _fields: TSelection;
  private _session: PgSession | undefined;
  private _dialect: DuckDBDialect;
  private _withList: Subquery[] = [];
  private _distinct: DistinctConfig | undefined;

  constructor(config: {
    fields: TSelection;
    session: PgSession | undefined;
    dialect: DuckDBDialect;
    withList?: Subquery[];
    distinct?: DistinctConfig;
  }) {
    super(config);
    this._fields = config.fields;
    this._session = config.session;
    this._dialect = config.dialect;
    if (config.withList) {
      this._withList = config.withList;
    }
    this._distinct = config.distinct;
  }

  from<TFrom extends PgTable | Subquery | PgViewBase | SQL>(
    source: TableLikeHasEmptySelection<TFrom> extends true
      ? DrizzleTypeError<"Cannot reference a data-modifying statement subquery if it doesn't contain a `returning` clause">
      : TFrom
  ): CreatePgSelectFromBuilderMode<
    TBuilderMode,
    GetSelectTableName<TFrom>,
    TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
    TSelection extends undefined ? 'single' : 'partial'
  > {
    const isPartialSelect = !!this._fields;
    const src = source as TFrom;

    let fields: SelectedFields;
    if (this._fields) {
      fields = this._fields;
    } else {
      fields = getSelectSourceFields(src, isPartialSelect);
    }

    return qualifySubqueryFields(
      new PgSelectBase({
        table: src,
        fields,
        isPartialSelect,
        session: this._session,
        dialect: this._dialect,
        withList: this._withList,
        distinct: this._distinct,
      })
    ) as unknown as CreatePgSelectFromBuilderMode<
      TBuilderMode,
      GetSelectTableName<TFrom>,
      TSelection extends undefined
        ? GetSelectTableSelection<TFrom>
        : TSelection,
      TSelection extends undefined ? 'single' : 'partial'
    >;
  }
}

/**
 * DuckDB resolves duplicate output names in subqueries and CTEs to the first
 * matching column, so every select entry point aliases fields by their keys.
 */
export function createDuckDBSelectBuilder<
  TBuilderMode extends 'db' | 'qb' = 'db',
>(config: {
  fields: SelectedFields | undefined;
  session: PgSession | undefined;
  dialect: DuckDBDialect;
  withList?: Subquery[];
  distinct?: DistinctConfig;
}): DuckDBSelectBuilder<SelectedFields | undefined, TBuilderMode> {
  return new DuckDBSelectBuilder<SelectedFields | undefined, TBuilderMode>({
    ...config,
    fields: config.fields ? aliasFields(config.fields) : undefined,
  });
}

export function createDuckDBSelectMethods<
  TBuilderMode extends 'db' | 'qb' = 'db',
>(
  session: PgSession | undefined,
  dialect: DuckDBDialect,
  withList?: Subquery[]
) {
  return {
    select: (fields?: SelectedFields) =>
      createDuckDBSelectBuilder<TBuilderMode>({
        fields,
        session,
        dialect,
        withList,
      }),
    selectDistinct: (fields?: SelectedFields) =>
      createDuckDBSelectBuilder<TBuilderMode>({
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
      createDuckDBSelectBuilder<TBuilderMode>({
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
    return createDuckDBSelectMethods<'qb'>(
      undefined,
      this.duckDialect,
      queries
    ) as unknown as ReturnType<QueryBuilder['with']>;
  }

  override select(): PgSelectBuilder<undefined, 'qb'>;
  override select<TSelection extends SelectedFields>(
    fields: TSelection
  ): PgSelectBuilder<TSelection, 'qb'>;
  override select(
    fields?: SelectedFields
  ): PgSelectBuilder<SelectedFields | undefined, 'qb'> {
    return createDuckDBSelectMethods<'qb'>(undefined, this.duckDialect).select(
      fields
    );
  }

  override selectDistinct(): PgSelectBuilder<undefined>;
  override selectDistinct<TSelection extends SelectedFields>(
    fields: TSelection
  ): PgSelectBuilder<TSelection>;
  override selectDistinct(
    fields?: SelectedFields
  ): PgSelectBuilder<SelectedFields | undefined> {
    return createDuckDBSelectMethods(
      undefined,
      this.duckDialect
    ).selectDistinct(fields);
  }

  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[]
  ): PgSelectBuilder<undefined>;
  override selectDistinctOn<TSelection extends SelectedFields>(
    on: (PgColumn | SQLWrapper)[],
    fields: TSelection
  ): PgSelectBuilder<TSelection>;
  override selectDistinctOn(
    on: (PgColumn | SQLWrapper)[],
    fields?: SelectedFields
  ): PgSelectBuilder<SelectedFields | undefined> {
    return createDuckDBSelectMethods(
      undefined,
      this.duckDialect
    ).selectDistinctOn(on, fields);
  }
}
