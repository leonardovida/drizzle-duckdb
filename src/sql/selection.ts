import {
  Column,
  SQL,
  Subquery,
  ViewBaseConfig,
  getTableName,
  is,
  sql,
} from 'drizzle-orm';
import { PgTable, type SelectedFields } from 'drizzle-orm/pg-core';
import { PgViewBase } from 'drizzle-orm/pg-core/view-base';
import type { ColumnsSelection } from 'drizzle-orm/sql/sql';
import { getTableColumns } from 'drizzle-orm/utils';

interface PgViewBaseInternal<
  TName extends string = string,
  TExisting extends boolean = boolean,
  TSelectedFields extends ColumnsSelection = ColumnsSelection,
> extends PgViewBase<TName, TExisting, TSelectedFields> {
  [ViewBaseConfig]?: {
    selectedFields: SelectedFields;
  };
}

function mapEntries(
  obj: Record<string, unknown>,
  prefix?: string,
  fullJoin = false
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([key]) => key !== 'enableRLS')
      .map(([key, value]) => {
        const qualified = prefix ? `${prefix}.${key}` : key;

        if (fullJoin && is(value, Column)) {
          return [
            key,
            sql`${value}`
              .mapWith(value)
              .as(`${getTableName(value.table)}.${value.name}`),
          ];
        }

        if (fullJoin && is(value, SQL)) {
          const col = value
            .getSQL()
            .queryChunks.find((chunk) => is(chunk, Column));

          const tableName = col?.table && getTableName(col?.table);

          return [key, value.as(tableName ? `${tableName}.${key}` : key)];
        }

        if (is(value, SQL) || is(value, Column)) {
          const aliased = is(value, SQL) ? value : sql`${value}`.mapWith(value);
          return [key, aliased.as(qualified)];
        }

        if (is(value, SQL.Aliased)) {
          return [key, value];
        }

        if (typeof value === 'object' && value !== null) {
          return [
            key,
            mapEntries(value as Record<string, unknown>, qualified, fullJoin),
          ];
        }

        return [key, value];
      })
  );
}

export function aliasFields(
  fields: SelectedFields,
  fullJoin = false
): SelectedFields {
  return mapEntries(fields, undefined, fullJoin) as SelectedFields;
}

export function getSelectSourceFields(
  source: PgTable | Subquery | PgViewBaseInternal | SQL,
  isPartialSelect: boolean
): SelectedFields {
  if (is(source, Subquery)) {
    return Object.fromEntries(
      Object.keys(source._.selectedFields).map((key) => [
        key,
        source[
          key as unknown as keyof typeof source
        ] as unknown as SelectedFields[string],
      ])
    );
  }

  if (is(source, PgViewBase)) {
    return source[ViewBaseConfig]?.selectedFields as SelectedFields;
  }

  if (is(source, SQL)) {
    return {};
  }

  return aliasFields(getTableColumns<PgTable>(source), !isPartialSelect);
}
