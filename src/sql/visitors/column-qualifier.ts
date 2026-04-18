/**
 * AST visitor to qualify unqualified column references in JOIN ON clauses.
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
  return {
    table: source.alias ?? source.name,
    schema: source.schema,
  };
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

function walkOnClause(
  expr: Binary | ExpressionValue | null | undefined,
  leftQualifier: Qualifier,
  rightQualifier: Qualifier,
  ambiguousColumns: Set<string>
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
      leftColName &&
      rightColName &&
      leftColName === rightColName
    ) {
      if (leftUnqualified && rightUnqualified) {
        applyQualifier(leftCol!, leftQualifier);
        applyQualifier(rightCol!, rightQualifier);
        ambiguousColumns.add(leftColName);
        transformed = true;
      } else if (leftQualified && rightUnqualified) {
        applyQualifier(rightCol!, rightQualifier);
        ambiguousColumns.add(rightColName);
        transformed = true;
      } else if (leftUnqualified && rightQualified) {
        applyQualifier(leftCol!, leftQualifier);
        ambiguousColumns.add(leftColName);
        transformed = true;
      }
    }

    if (
      expr.operator === '=' &&
      leftCol &&
      rightCol &&
      leftColName &&
      rightColName &&
      leftColName !== rightColName
    ) {
      if (leftQualified && rightUnqualified && !rightColName.includes('.')) {
        applyQualifier(rightCol, rightQualifier);
        transformed = true;
      } else if (
        leftUnqualified &&
        rightQualified &&
        !leftColName.includes('.')
      ) {
        applyQualifier(leftCol, leftQualifier);
        transformed = true;
      }
    }

    transformed =
      walkOnClause(
        isBinaryExpr(expr.left as Binary)
          ? (expr.left as Binary)
          : (expr.left as ExpressionValue),
        leftQualifier,
        rightQualifier,
        ambiguousColumns
      ) || transformed;
    transformed =
      walkOnClause(
        isBinaryExpr(expr.right as Binary)
          ? (expr.right as Binary)
          : (expr.right as ExpressionValue),
        leftQualifier,
        rightQualifier,
        ambiguousColumns
      ) || transformed;
  }

  return transformed;
}

function qualifyAmbiguousInExpression(
  expr: ExpressionValue | null | undefined,
  defaultQualifier: Qualifier,
  ambiguousColumns: Set<string>
): boolean {
  if (!expr || typeof expr !== 'object') return false;

  let transformed = false;

  if (isUnqualifiedColumnRef(expr)) {
    const colName = getColumnName(expr);
    if (colName && ambiguousColumns.has(colName)) {
      applyQualifier(expr, defaultQualifier);
      transformed = true;
    }
    return transformed;
  }

  if (isBinaryExpr(expr)) {
    const binary = expr as Binary;
    transformed =
      qualifyAmbiguousInExpression(
        binary.left as ExpressionValue,
        defaultQualifier,
        ambiguousColumns
      ) || transformed;
    transformed =
      qualifyAmbiguousInExpression(
        binary.right as ExpressionValue,
        defaultQualifier,
        ambiguousColumns
      ) || transformed;
    return transformed;
  }

  if ('args' in expr && expr.args) {
    const args = expr.args as {
      value?: ExpressionValue[];
      expr?: ExpressionValue;
    };
    if (args.value && Array.isArray(args.value)) {
      for (const arg of args.value) {
        transformed =
          qualifyAmbiguousInExpression(
            arg,
            defaultQualifier,
            ambiguousColumns
          ) || transformed;
      }
    }
    if (args.expr) {
      transformed =
        qualifyAmbiguousInExpression(
          args.expr,
          defaultQualifier,
          ambiguousColumns
        ) || transformed;
    }
  }

  if ('over' in expr && expr.over && typeof expr.over === 'object') {
    const over = expr.over as {
      partition?: ExpressionValue[];
      orderby?: ExpressionValue[];
    };
    if (Array.isArray(over.partition)) {
      for (const part of over.partition) {
        transformed =
          qualifyAmbiguousInExpression(
            part,
            defaultQualifier,
            ambiguousColumns
          ) || transformed;
      }
    }
    if (Array.isArray(over.orderby)) {
      for (const order of over.orderby) {
        transformed =
          qualifyAmbiguousInExpression(
            order,
            defaultQualifier,
            ambiguousColumns
          ) || transformed;
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

function walkSelect(select: Select): boolean {
  let transformed = false;
  const ambiguousColumns = new Set<string>();

  if (Array.isArray(select.from) && select.from.length >= 2) {
    const firstSource = getTableSource(select.from[0]);
    const defaultQualifier = firstSource ? getQualifier(firstSource) : null;
    let prevSource = firstSource;

    let hasAnyUnqualified = false;
    for (const from of select.from) {
      if ('join' in from) {
        const join = from as Join;
        if (join.on && hasUnqualifiedColumns(join.on)) {
          hasAnyUnqualified = true;
          break;
        }
      }
    }

    if (!hasAnyUnqualified) {
      for (const from of select.from) {
        if ('expr' in from && from.expr && 'ast' in from.expr) {
          transformed = walkSelect(from.expr.ast) || transformed;
        }
      }
    } else {
      for (const from of select.from) {
        if ('join' in from) {
          const join = from as Join;
          const currentSource = getTableSource(join);

          if (join.on && prevSource && currentSource) {
            const leftQualifier = getQualifier(prevSource);
            const rightQualifier = getQualifier(currentSource);

            transformed =
              walkOnClause(
                join.on,
                leftQualifier,
                rightQualifier,
                ambiguousColumns
              ) || transformed;
          }

          if (join.using && prevSource && currentSource) {
            for (const usingCol of join.using) {
              if (typeof usingCol === 'string') {
                ambiguousColumns.add(usingCol);
              } else if ('value' in usingCol) {
                ambiguousColumns.add(
                  String((usingCol as { value: unknown }).value)
                );
              }
            }
          }

          prevSource = currentSource;
        } else {
          const source = getTableSource(from);
          if (source) {
            prevSource = source;
          }
        }

        if ('expr' in from && from.expr && 'ast' in from.expr) {
          transformed = walkSelect(from.expr.ast) || transformed;
        }
      }

      if (ambiguousColumns.size > 0 && defaultQualifier) {
        if (Array.isArray(select.columns)) {
          for (const col of select.columns as Column[]) {
            if ('expr' in col) {
              transformed =
                qualifyAmbiguousInExpression(
                  col.expr,
                  defaultQualifier,
                  ambiguousColumns
                ) || transformed;
            }
          }
        }

        transformed =
          qualifyAmbiguousInExpression(
            select.where,
            defaultQualifier,
            ambiguousColumns
          ) || transformed;

        if (Array.isArray(select.orderby)) {
          for (const order of select.orderby as OrderBy[]) {
            if (order.expr) {
              transformed =
                qualifyAmbiguousInExpression(
                  order.expr,
                  defaultQualifier,
                  ambiguousColumns
                ) || transformed;
            }
          }
        }
      }
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
      const defaultQualifier = mainSource ? getQualifier(mainSource) : null;
      const fromSources = update.from ?? [];
      const firstFrom = fromSources[0] ? getTableSource(fromSources[0]) : null;
      if (update.where && defaultQualifier && firstFrom) {
        const ambiguous = new Set<string>();
        transformed =
          walkOnClause(
            update.where as Binary,
            defaultQualifier,
            getQualifier(firstFrom),
            ambiguous
          ) || transformed;
        transformed =
          qualifyAmbiguousInExpression(
            update.where,
            defaultQualifier,
            ambiguous
          ) || transformed;
      }
      if (Array.isArray(update.returning) && defaultQualifier) {
        for (const ret of update.returning) {
          transformed =
            qualifyAmbiguousInExpression(
              ret,
              defaultQualifier,
              new Set<string>()
            ) || transformed;
        }
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
      const defaultQualifier = mainSource ? getQualifier(mainSource) : null;
      const fromSources = del.from ?? [];
      const firstFrom = fromSources[0] ? getTableSource(fromSources[0]) : null;
      if (del.where && defaultQualifier && firstFrom) {
        const ambiguous = new Set<string>();
        transformed =
          walkOnClause(
            del.where as Binary,
            defaultQualifier,
            getQualifier(firstFrom),
            ambiguous
          ) || transformed;
        transformed =
          qualifyAmbiguousInExpression(
            del.where,
            defaultQualifier,
            ambiguous
          ) || transformed;
      } else if (del.where && defaultQualifier) {
        transformed =
          qualifyAmbiguousInExpression(
            del.where,
            defaultQualifier,
            new Set<string>()
          ) || transformed;
      }
    }
  }

  return transformed;
}
