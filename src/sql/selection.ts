import {
  Column,
  SQL,
  Subquery,
  ViewBaseConfig,
  getTableName,
  is,
  sql,
  type DriverValueDecoder,
} from 'drizzle-orm';
import {
  PgTable,
  customType,
  pgTable,
  type SelectedFields,
} from 'drizzle-orm/pg-core';
import { PgViewBase } from 'drizzle-orm/pg-core/view-base';
import type { ColumnsSelection } from 'drizzle-orm/sql/sql';
import { getTableColumns } from 'drizzle-orm/utils';
import { resolveFieldDecoder } from './result-mapper.ts';

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
      // Tables carry helper methods such as enableRLS; only skip functions so
      // a column that shares one of those names is still selected.
      .filter(([, value]) => typeof value !== 'function')
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

/**
 * A view of `column` named `name`. Drizzle's subquery proxy points its table
 * at the subquery alias, so it renders as "sq"."name".
 */
function renamedColumn(column: Column, name: string): Column {
  return new Proxy(column, {
    get(target, prop, receiver) {
      if (prop === 'name') return name;
      if (prop === 'keyAsName') return false;
      return Reflect.get(target, prop, receiver);
    },
  });
}

// Stand-in table for SQL fields. The subquery proxy replaces its name with the
// subquery alias.
const sqlFieldTable = pgTable('duckdb_sql_field', {});

/** A column named `name` that decodes with `decoder`. */
function sqlFieldColumn(
  name: string,
  decoder: DriverValueDecoder<unknown, unknown>
): Column {
  const builder = customType<{ data: unknown; driverData: unknown }>({
    dataType: () => 'unknown',
    fromDriver: (value) => decoder.mapFromDriverValue(value),
  })(name) as unknown as { build(table: PgTable): Column };
  return builder.build(sqlFieldTable);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Fields a subquery, CTE or view built by this driver exposes to the outer
 * query.
 *
 * Drizzle references an aliased field of a subquery by its bare alias, and
 * aliasFields() aliases every field. A bare "id" is ambiguous as soon as
 * another joined source has an `id` column. Exposing each aliased field as a
 * column named after its alias makes Drizzle render "sq"."id", the way stock
 * pg-core references subquery columns. The field keeps its decoder.
 */
export function exposeSubqueryFields<T extends Record<string, unknown>>(
  fields: T
): T {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (is(value, SQL.Aliased)) {
        const decoder = resolveFieldDecoder(value);
        return [
          key,
          is(decoder, Column)
            ? renamedColumn(decoder, value.fieldAlias)
            : sqlFieldColumn(value.fieldAlias, decoder),
        ];
      }
      if (isPlainObject(value)) {
        return [key, exposeSubqueryFields(value)];
      }
      return [key, value];
    })
  ) as T;
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
