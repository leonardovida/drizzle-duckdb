import {
  PgSelectBase,
  PgSelectBuilder,
  type CreatePgSelectFromBuilderMode,
  type SelectedFields,
  type TableLikeHasEmptySelection,
} from 'drizzle-orm/pg-core/query-builders';
import { PgColumn, PgTable, type PgSession } from 'drizzle-orm/pg-core';
import { Subquery, type SQLWrapper } from 'drizzle-orm';
import { PgViewBase } from 'drizzle-orm/pg-core/view-base';
import type {
  GetSelectTableName,
  GetSelectTableSelection,
} from 'drizzle-orm/query-builders/select.types';
import { SQL } from 'drizzle-orm/sql/sql';
import { getSelectSourceFields } from './sql/selection.ts';
import type { DuckDBDialect } from './dialect.ts';
import type { DrizzleTypeError } from 'drizzle-orm/utils';

export class DuckDBSelectBuilder<
  TSelection extends SelectedFields | undefined,
  TBuilderMode extends 'db' | 'qb' = 'db',
> extends PgSelectBuilder<TSelection, TBuilderMode> {
  private _fields: TSelection;
  private _session: PgSession | undefined;
  private _dialect: DuckDBDialect;
  private _withList: Subquery[] = [];
  private _distinct:
    | boolean
    | {
        on: (PgColumn | SQLWrapper)[];
      }
    | undefined;

  constructor(config: {
    fields: TSelection;
    session: PgSession | undefined;
    dialect: DuckDBDialect;
    withList?: Subquery[];
    distinct?:
      | boolean
      | {
          on: (PgColumn | SQLWrapper)[];
        };
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

    return new PgSelectBase({
      table: src,
      fields,
      isPartialSelect,
      session: this._session,
      dialect: this._dialect,
      withList: this._withList,
      distinct: this._distinct,
    }) as any;
  }
}
