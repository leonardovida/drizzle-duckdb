/**
 * AST visitor to qualify unqualified column references in JOIN ON clauses.
 *
 * Stock Drizzle renders an aliased SQL field of a subquery or CTE by its bare
 * alias, so `eq(table.col, sq.col)` becomes `"table"."col" = "col"`, which
 * DuckDB rejects as ambiguous. Selects built by this driver already qualify
 * those fields (see exposeSubqueryFields), so this mostly covers raw SQL. The unqualified side is given to the newly joined
 * source unless the qualified side already is that source. When that cannot
 * be decided, the reference is left as it is.
 *
 * Other unqualified references to the same name in SELECT, WHERE, GROUP BY,
 * HAVING and ORDER BY get the qualifier chosen in the ON clause. Names that
 * were given different qualifiers, and USING columns, are left unqualified.
 *
 * Performance optimizations:
 * - Early exit when no unqualified columns found in ON clause
 * - Skip processing if all columns are already qualified
 * - Minimal tree traversal when possible
 */

import type {
  AST,
  Binary,
  ColumnRefItem,
  ExpressionValue,
  Select,
  From,
  Join,
  OrderBy,
  Column,
} from 'node-sql-parser';
import {
  getColumnName,
  isBinaryExpr,
  isQualifiedColumnRef,
  isUnqualifiedColumnRef,
} from './ast-helpers.ts';

type TableSource = {
  name: string;
  alias: string | null;
  schema: string | null;
};

type Qualifier = {
  table: string;
  schema: string | null;
};

function getTableSource(from: From): TableSource | null {
  if ('table' in from && from.table) {
    return {
      name: from.table,
      alias: from.as ?? null,
      schema: 'db' in from ? (from.db ?? null) : null,
    };
  }
  if ('expr' in from && from.as) {
    return {
      name: from.as,
      alias: from.as,
      schema: null,
    };
  }
  return null;
}

function getQualifier(source: TableSource): Qualifier {
  // An alias replaces the schema qualified name: "s"."t" "u" is only "u".
  return source.alias
    ? { table: source.alias, schema: null }
    : { table: source.name, schema: source.schema };
}

function sameQualifier(left: Qualifier, right: Qualifier): boolean {
  return left.table === right.table && left.schema === right.schema;
}

function applyQualifier(col: ColumnRefItem, qualifier: Qualifier): void {
  col.table = qualifier.table;
  if (!('schema' in col) || !col.schema) {
    (col as ColumnRefItem & { schema?: string | null }).schema =
      qualifier.schema;
  }
}

function unwrapColumnRef(
  expr: ExpressionValue | undefined
): ColumnRefItem | null {
  if (!expr || typeof expr !== 'object') return null;
  if ('type' in expr && expr.type === 'column_ref') {
    return expr as ColumnRefItem;
  }
  if ('expr' in expr && expr.expr) {
    return unwrapColumnRef(expr.expr as ExpressionValue);
  }
  if ('ast' in expr && expr.ast && typeof expr.ast === 'object') {
    return null;
  }
  if ('args' in expr && expr.args) {
    const args = expr.args as {
      value?: ExpressionValue[];
      expr?: ExpressionValue;
    };
    if (args.expr) {
      return unwrapColumnRef(args.expr as ExpressionValue);
    }
    if (args.value && args.value.length === 1) {
      return unwrapColumnRef(args.value[0] as ExpressionValue);
    }
  }
  return null;
}

/**
 * Qualifier chosen for each unqualified name. `null` marks a name that was
 * given different qualifiers, so its other references stay unqualified.
 */
type ChosenQualifiers = Map<string, Qualifier | null>;

type JoinSides = {
  /** The source this join adds. */
  joined: Qualifier;
  /** The source before it, when there is exactly one. */
  earlier: Qualifier | null;
};

function recordChoice(
  chosen: ChosenQualifiers,
  name: string,
  qualifier: Qualifier | null
): void {
  const previous = chosen.get(name);
  if (previous === undefined) {
    chosen.set(name, qualifier);
  } else if (
    previous === null ||
    qualifier === null ||
    !sameQualifier(previous, qualifier)
  ) {
    chosen.set(name, null);
  }
}

/**
 * Pick the qualifier for the unqualified side of `qualified = unqualified`.
 * It defaults to the newly joined source. When the qualified column already
 * belongs to that source, the other column comes from an earlier source,
 * which is only known when there is exactly one.
 */
function qualifierForUnqualified(
  qualifiedCol: ColumnRefItem,
  sides: JoinSides
): Qualifier | null {
  return qualifiedCol.table === sides.joined.table
    ? sides.earlier
    : sides.joined;
}

function walkOnClause(
  expr: Binary | ExpressionValue | null | undefined,
  sides: JoinSides,
  chosen: ChosenQualifiers
): boolean {
  if (!expr || typeof expr !== 'object') return false;

  let transformed = false;

  if (isBinaryExpr(expr)) {
    const left = expr.left as ExpressionValue;
    const right = expr.right as ExpressionValue;

    const leftCol = unwrapColumnRef(left);
    const rightCol = unwrapColumnRef(right);

    const leftUnqualified = leftCol ? isUnqualifiedColumnRef(leftCol) : false;
    const rightUnqualified = rightCol
      ? isUnqualifiedColumnRef(rightCol)
      : false;
    const leftQualified = leftCol ? isQualifiedColumnRef(leftCol) : false;
    const rightQualified = rightCol ? isQualifiedColumnRef(rightCol) : false;
    const leftColName = leftCol ? getColumnName(leftCol) : null;
    const rightColName = rightCol ? getColumnName(rightCol) : null;

    if (
      expr.operator === '=' &&
      leftCol &&
      rightCol &&
      leftColName &&
      rightColName
    ) {
      const sameName = leftColName === rightColName;

      if (sameName && leftUnqualified && rightUnqualified) {
        // `"id" = "id"`: one side per source, which is only known for the
        // first join. Other bare "id" references could mean either side.
        if (sides.earlier) {
          applyQualifier(leftCol, sides.earlier);
          applyQualifier(rightCol, sides.joined);
          recordChoice(chosen, leftColName, null);
          transformed = true;
        }
      } else if (
        leftQualified !== rightQualified &&
        (leftUnqualified || rightUnqualified)
      ) {
        const [qualifiedCol, unqualifiedCol, unqualifiedName] = leftQualified
          ? [leftCol, rightCol, rightColName]
          : [rightCol, leftCol, leftColName];
        const qualifier = qualifierForUnqualified(qualifiedCol, sides);

        if (qualifier && (sameName || !unqualifiedName.includes('.'))) {
          applyQualifier(unqualifiedCol, qualifier);
          if (sameName) {
            recordChoice(chosen, unqualifiedName, qualifier);
          }
          transformed = true;
        }
      }
    }

    transformed = walkOnClause(left, sides, chosen) || transformed;
    transformed = walkOnClause(right, sides, chosen) || transformed;
  }

  return transformed;
}

function qualifyAmbiguousInExpression(
  expr: ExpressionValue | null | undefined,
  chosen: ChosenQualifiers
): boolean {
  if (!expr || typeof expr !== 'object') return false;

  let transformed = false;

  if (isUnqualifiedColumnRef(expr)) {
    const colName = getColumnName(expr);
    const qualifier = colName ? chosen.get(colName) : undefined;
    if (qualifier) {
      applyQualifier(expr, qualifier);
      transformed = true;
    }
    return transformed;
  }

  if (isBinaryExpr(expr)) {
    const binary = expr as Binary;
    transformed =
      qualifyAmbiguousInExpression(binary.left as ExpressionValue, chosen) ||
      transformed;
    transformed =
      qualifyAmbiguousInExpression(binary.right as ExpressionValue, chosen) ||
      transformed;
    return transformed;
  }

  if ('args' in expr && expr.args) {
    const args = expr.args as {
      value?: ExpressionValue[];
      expr?: ExpressionValue;
    };
    if (args.value && Array.isArray(args.value)) {
      for (const arg of args.value) {
        transformed = qualifyAmbiguousInExpression(arg, chosen) || transformed;
      }
    }
    if (args.expr) {
      transformed =
        qualifyAmbiguousInExpression(args.expr, chosen) || transformed;
    }
  }

  if ('over' in expr && expr.over && typeof expr.over === 'object') {
    const over = expr.over as {
      partition?: ExpressionValue[];
      orderby?: ExpressionValue[];
    };
    if (Array.isArray(over.partition)) {
      for (const part of over.partition) {
        transformed = qualifyAmbiguousInExpression(part, chosen) || transformed;
      }
    }
    if (Array.isArray(over.orderby)) {
      for (const order of over.orderby) {
        transformed =
          qualifyAmbiguousInExpression(order, chosen) || transformed;
      }
    }
  }

  return transformed;
}

/**
 * Quick check if an ON clause has any unqualified column references.
 * Used for early exit optimization.
 */
function hasUnqualifiedColumns(expr: Binary | null | undefined): boolean {
  if (!expr || typeof expr !== 'object') return false;

  if ('type' in expr && expr.type === 'binary_expr') {
    const left = expr.left as ExpressionValue;
    const right = expr.right as ExpressionValue;
    const leftCol = unwrapColumnRef(left);
    const rightCol = unwrapColumnRef(right);
    if (
      isUnqualifiedColumnRef(left) ||
      isUnqualifiedColumnRef(right) ||
      (leftCol && isUnqualifiedColumnRef(leftCol)) ||
      (rightCol && isUnqualifiedColumnRef(rightCol))
    ) {
      return true;
    }
    if (
      isBinaryExpr(expr.left as Binary) &&
      hasUnqualifiedColumns(expr.left as Binary)
    )
      return true;
    if (
      isBinaryExpr(expr.right as Binary) &&
      hasUnqualifiedColumns(expr.right as Binary)
    )
      return true;
  }

  if ('args' in expr && expr.args) {
    const args = expr.args as {
      value?: ExpressionValue[];
      expr?: ExpressionValue;
    };
    if (args.expr && isUnqualifiedColumnRef(args.expr as ExpressionValue))
      return true;
    if (args.value) {
      for (const arg of args.value) {
        if (isUnqualifiedColumnRef(arg)) return true;
      }
    }
  }

  return false;
}

function outputAliases(select: Select): Set<string> {
  const aliases = new Set<string>();
  if (Array.isArray(select.columns)) {
    for (const col of select.columns as Column[]) {
      if (typeof col.as === 'string') aliases.add(col.as);
    }
  }
  return aliases;
}

function groupByExpressions(select: Select): ExpressionValue[] {
  const groupby = select.groupby as
    | { columns?: ExpressionValue[] | null }
    | ExpressionValue[]
    | null
    | undefined;
  if (Array.isArray(groupby)) return groupby;
  return groupby?.columns ?? [];
}

/**
 * Give unqualified references outside the ON clauses the qualifier their
 * name got in an ON clause. GROUP BY and ORDER BY may name an output alias,
 * so those names are skipped there.
 */
function qualifyChosenNames(select: Select, chosen: ChosenQualifiers): boolean {
  let transformed = false;
  const aliases = outputAliases(select);
  const aliasSafe: ChosenQualifiers = new Map(
    [...chosen].filter(([name]) => !aliases.has(name))
  );

  if (Array.isArray(select.columns)) {
    for (const col of select.columns as Column[]) {
      if ('expr' in col) {
        transformed =
          qualifyAmbiguousInExpression(col.expr, chosen) || transformed;
      }
    }
  }

  transformed =
    qualifyAmbiguousInExpression(select.where, chosen) || transformed;

  for (const expr of groupByExpressions(select)) {
    transformed = qualifyAmbiguousInExpression(expr, aliasSafe) || transformed;
  }

  transformed =
    qualifyAmbiguousInExpression(
      select.having as ExpressionValue | null | undefined,
      chosen
    ) || transformed;

  if (Array.isArray(select.orderby)) {
    for (const order of select.orderby as OrderBy[]) {
      if (order.expr) {
        transformed =
          qualifyAmbiguousInExpression(order.expr, aliasSafe) || transformed;
      }
    }
  }

  return transformed;
}

function walkSelect(select: Select): boolean {
  let transformed = false;

  if (Array.isArray(select.from) && select.from.length >= 2) {
    const hasAnyUnqualified = select.from.some(
      (from) =>
        'join' in from && !!from.on && hasUnqualifiedColumns(from.on as Binary)
    );

    const sources: Qualifier[] = [];
    // A source that cannot be named (for example an unaliased table
    // function) makes "the one earlier source" unknown.
    let unnamedSource = false;
    const chosen: ChosenQualifiers = new Map();

    for (const from of select.from) {
      const source = getTableSource(from);

      if (hasAnyUnqualified && 'join' in from) {
        const join = from as Join;
        if (join.on && source) {
          const sides: JoinSides = {
            joined: getQualifier(source),
            earlier:
              sources.length === 1 && !unnamedSource ? sources[0]! : null,
          };
          transformed = walkOnClause(join.on, sides, chosen) || transformed;
        }
        // USING columns are resolved by DuckDB itself, so they are never
        // qualified.
      }

      if (source) {
        sources.push(getQualifier(source));
      } else {
        unnamedSource = true;
      }

      if ('expr' in from && from.expr && 'ast' in from.expr) {
        transformed = walkSelect(from.expr.ast) || transformed;
      }
    }

    if (chosen.size > 0) {
      transformed = qualifyChosenNames(select, chosen) || transformed;
    }
  }

  if (select.with) {
    for (const cte of select.with) {
      const cteSelect = cte.stmt?.ast ?? cte.stmt;
      if (cteSelect && cteSelect.type === 'select') {
        transformed = walkSelect(cteSelect as Select) || transformed;
      }
    }
  }

  if (select._next) {
    transformed = walkSelect(select._next) || transformed;
  }

  return transformed;
}

/**
 * UPDATE ... FROM and DELETE ... USING compare the target table with the
 * first FROM source in WHERE.
 */
function qualifyWhereAgainstFrom(
  where: ExpressionValue,
  target: TableSource,
  firstFrom: TableSource
): boolean {
  const chosen: ChosenQualifiers = new Map();
  const sides: JoinSides = {
    joined: getQualifier(firstFrom),
    earlier: getQualifier(target),
  };
  const transformed = walkOnClause(where as Binary, sides, chosen);
  return qualifyAmbiguousInExpression(where, chosen) || transformed;
}

export function qualifyJoinColumns(ast: AST | AST[]): boolean {
  const statements = Array.isArray(ast) ? ast : [ast];
  let transformed = false;

  for (const stmt of statements) {
    if (stmt.type === 'select') {
      transformed = walkSelect(stmt as Select) || transformed;
    } else if (stmt.type === 'insert') {
      const insert = stmt as unknown as { values?: unknown };
      if (
        insert.values &&
        typeof insert.values === 'object' &&
        'type' in insert.values &&
        (insert.values as { type: string }).type === 'select'
      ) {
        transformed =
          walkSelect(insert.values as unknown as Select) || transformed;
      }
    } else if (stmt.type === 'update') {
      const update = stmt as unknown as {
        table?: From[];
        from?: From[];
        where?: ExpressionValue;
        returning?: ExpressionValue | ExpressionValue[];
      };
      const mainSource = update.table?.[0]
        ? getTableSource(update.table[0] as From)
        : null;
      const fromSources = update.from ?? [];
      const firstFrom = fromSources[0] ? getTableSource(fromSources[0]) : null;
      if (update.where && mainSource && firstFrom) {
        transformed =
          qualifyWhereAgainstFrom(update.where, mainSource, firstFrom) ||
          transformed;
      }
    } else if (stmt.type === 'delete') {
      const del = stmt as unknown as {
        table?: From[];
        from?: From[];
        where?: ExpressionValue;
      };
      const mainSource = del.table?.[0]
        ? getTableSource(del.table[0] as From)
        : null;
      const fromSources = del.from ?? [];
      const firstFrom = fromSources[0] ? getTableSource(fromSources[0]) : null;
      if (del.where && mainSource && firstFrom) {
        transformed =
          qualifyWhereAgainstFrom(del.where, mainSource, firstFrom) ||
          transformed;
      }
    }
  }

  return transformed;
}
