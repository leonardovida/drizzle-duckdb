/**
 * AST visitor to rewrite Postgres first dimension array bounds helpers,
 * array_lower(arr, 1) and array_upper(arr, 1), which DuckDB does not have.
 *
 * The @>, <@ and && operators are left alone: DuckDB supports them on
 * LIST and ARRAY values with the same semantics as array_has_all and
 * array_has_any.
 */

import type {
  AST,
  Binary,
  ExpressionValue,
  Select,
  From,
  Join,
  OrderBy,
} from 'node-sql-parser';

function getFunctionName(expr: Record<string, unknown>): string | undefined {
  const name = expr.name as { name?: Array<{ value?: unknown }> } | undefined;
  const firstNamePart = name?.name?.[0]?.value;
  return typeof firstNamePart === 'string'
    ? firstNamePart.toLowerCase()
    : undefined;
}

function getFunctionArgs(expr: Record<string, unknown>): unknown[] | undefined {
  const args = expr.args as { value?: unknown[] } | undefined;
  return Array.isArray(args?.value) ? args.value : undefined;
}

function isFirstArrayDimension(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const expr = value as { type?: unknown; value?: unknown };
  return expr.type === 'number' && Number(expr.value) === 1;
}

function arrayLengthExpr(arrayExpr: unknown) {
  return {
    type: 'function' as const,
    name: { name: [{ type: 'default', value: 'array_length' }] },
    args: {
      type: 'expr_list' as const,
      value: [arrayExpr],
    },
  };
}

function arrayBoundsExpr(functionName: string, arrayExpr: unknown) {
  const lengthExpr = arrayLengthExpr(arrayExpr);

  // Evaluate the expression once. Duplicating it also duplicates parameters
  // and literals, which the SQL preservation guard correctly rejects.
  if (functionName === 'array_upper') {
    const nullIf = (value: unknown) => ({
      type: 'function' as const,
      name: { name: [{ type: 'default', value: 'nullif' }] },
      args: {
        type: 'expr_list' as const,
        value: [value, { type: 'number' as const, value: 0 }],
      },
    });
    // DuckDB expands NULLIF as CASE and can evaluate its argument twice.
    // Bind the length in a one-element list so a volatile expression still
    // runs once per row. Scalar subqueries can cache it for the whole query.
    if (hasPotentiallyVolatileExpression(arrayExpr)) {
      const call = (name: string, args: unknown[]) => ({
        type: 'function',
        name: { name: [{ type: 'default', value: name }] },
        args: { type: 'expr_list', value: args },
      });
      const length = {
        type: 'column_ref',
        table: null,
        column: '__drizzle_array_length',
      };
      return call('list_extract', [
        call('list_transform', [
          call('list_value', [lengthExpr]),
          {
            type: 'binary_expr',
            operator: '->',
            left: length,
            right: nullIf(length),
          },
        ]),
        { type: 'number', value: 1 },
      ]);
    }
    return {
      type: 'function' as const,
      name: { name: [{ type: 'default', value: 'nullif' }] },
      args: {
        type: 'expr_list' as const,
        value: [lengthExpr, { type: 'number' as const, value: 0 }],
      },
    };
  }

  return {
    type: 'case' as const,
    expr: null,
    args: [
      {
        type: 'when' as const,
        cond: {
          type: 'binary_expr' as const,
          operator: '>',
          left: arrayLengthExpr(arrayExpr),
          right: { type: 'number' as const, value: 0 },
        },
        result: { type: 'number' as const, value: 1 },
      },
      {
        type: 'else' as const,
        result: { type: 'null' as const, value: null },
      },
    ],
  };
}

function hasPotentiallyVolatileExpression(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const expression = value as Record<string, unknown>;
  return (
    expression.type === 'function' ||
    'ast' in expression ||
    Object.values(expression).some(hasPotentiallyVolatileExpression)
  );
}

function transformArrayBoundsFunction(
  expr: Record<string, unknown>,
  parent?: object,
  key?: string
): boolean {
  const functionName = getFunctionName(expr);
  if (functionName !== 'array_lower' && functionName !== 'array_upper') {
    return false;
  }

  const args = getFunctionArgs(expr);
  if (!args || args.length !== 2 || !isFirstArrayDimension(args[1])) {
    return false;
  }

  if (!parent || !key) {
    return false;
  }

  (parent as Record<string, unknown>)[key] = arrayBoundsExpr(
    functionName,
    args[0]
  );
  return true;
}

function walkExpression(
  expr: ExpressionValue | null | undefined,
  parent?: object,
  key?: string
): boolean {
  if (!expr || typeof expr !== 'object') return false;

  let transformed = false;
  const exprObj = expr as Record<string, unknown>;

  if ('type' in expr && exprObj.type === 'binary_expr') {
    const binary = expr as Binary;
    transformed =
      walkExpression(binary.left as ExpressionValue, binary, 'left') ||
      transformed;
    transformed =
      walkExpression(binary.right as ExpressionValue, binary, 'right') ||
      transformed;
  }

  if ('type' in expr && exprObj.type === 'function') {
    transformed =
      transformArrayBoundsFunction(exprObj, parent, key) || transformed;
  }

  if (
    'type' in expr &&
    (exprObj.type === 'unary_expr' || exprObj.type === 'cast')
  ) {
    if ('expr' in exprObj) {
      transformed =
        walkExpression(exprObj.expr as ExpressionValue, exprObj, 'expr') ||
        transformed;
    }
  }

  if ('type' in expr && exprObj.type === 'case') {
    if ('expr' in exprObj && exprObj.expr) {
      transformed =
        walkExpression(exprObj.expr as ExpressionValue, exprObj, 'expr') ||
        transformed;
    }
    if ('args' in exprObj && Array.isArray(exprObj.args)) {
      for (let i = 0; i < exprObj.args.length; i++) {
        const whenClause = exprObj.args[i] as Record<string, unknown>;
        if (whenClause.cond) {
          transformed =
            walkExpression(
              whenClause.cond as ExpressionValue,
              whenClause,
              'cond'
            ) || transformed;
        }
        if (whenClause.result) {
          transformed =
            walkExpression(
              whenClause.result as ExpressionValue,
              whenClause,
              'result'
            ) || transformed;
        }
      }
    }
  }

  if ('args' in expr && exprObj.args) {
    const args = exprObj.args as Record<string, unknown>;
    if ('value' in args && Array.isArray(args.value)) {
      for (let i = 0; i < args.value.length; i++) {
        transformed =
          walkExpression(
            args.value[i] as ExpressionValue,
            args.value,
            String(i)
          ) || transformed;
      }
    } else if ('expr' in args) {
      transformed =
        walkExpression(args.expr as ExpressionValue, args, 'expr') ||
        transformed;
    }
  }

  if ('ast' in exprObj && exprObj.ast) {
    const subAst = exprObj.ast as Select;
    if (subAst.type === 'select') {
      transformed = walkSelectImpl(subAst) || transformed;
    }
  }

  if ('type' in expr && exprObj.type === 'expr_list') {
    if ('value' in exprObj && Array.isArray(exprObj.value)) {
      for (let i = 0; i < exprObj.value.length; i++) {
        transformed =
          walkExpression(
            exprObj.value[i] as ExpressionValue,
            exprObj.value,
            String(i)
          ) || transformed;
      }
    }
  }

  // ARRAY[...] constructors keep their items in expr_list.
  if ('type' in expr && exprObj.type === 'array' && exprObj.expr_list) {
    transformed =
      walkExpression(
        exprObj.expr_list as ExpressionValue,
        exprObj,
        'expr_list'
      ) || transformed;
  }

  return transformed;
}

function walkList(list: ExpressionValue[]): boolean {
  let transformed = false;
  for (let i = 0; i < list.length; i++) {
    transformed = walkExpression(list[i], list, String(i)) || transformed;
  }
  return transformed;
}

function walkOrderBy(orderby: OrderBy[] | null | undefined): boolean {
  if (!Array.isArray(orderby)) return false;
  let transformed = false;
  for (const order of orderby) {
    transformed =
      walkExpression(order.expr as ExpressionValue, order, 'expr') ||
      transformed;
  }
  return transformed;
}

type UpdateStatement = {
  set?: Array<{ value?: ExpressionValue }>;
  from?: From[] | null;
  where?: ExpressionValue | null;
};

function walkUpdate(update: UpdateStatement): boolean {
  let transformed = false;
  for (const item of update.set ?? []) {
    transformed = walkExpression(item.value, item, 'value') || transformed;
  }
  transformed = walkFrom(update.from) || transformed;
  transformed = walkExpression(update.where, update, 'where') || transformed;
  return transformed;
}

function walkFrom(from: From[] | null | undefined): boolean {
  if (!from || !Array.isArray(from)) return false;

  let transformed = false;

  for (const f of from) {
    if ('join' in f) {
      const join = f as Join;
      transformed = walkExpression(join.on, join, 'on') || transformed;
    }
    if ('expr' in f && f.expr && 'ast' in f.expr) {
      transformed = walkSelectImpl(f.expr.ast) || transformed;
    }
  }

  return transformed;
}

function walkSelectImpl(select: Select): boolean {
  let transformed = false;

  if (select.with) {
    for (const cte of select.with) {
      const cteSelect = cte.stmt?.ast ?? cte.stmt;
      if (cteSelect && cteSelect.type === 'select') {
        transformed = walkSelectImpl(cteSelect as Select) || transformed;
      }
    }
  }

  if (Array.isArray(select.from)) {
    transformed = walkFrom(select.from) || transformed;
  }

  transformed = walkExpression(select.where, select, 'where') || transformed;

  if (select.having) {
    if (Array.isArray(select.having)) {
      for (let i = 0; i < select.having.length; i++) {
        transformed =
          walkExpression(select.having[i], select.having, String(i)) ||
          transformed;
      }
    } else {
      transformed =
        walkExpression(select.having as ExpressionValue, select, 'having') ||
        transformed;
    }
  }

  if (Array.isArray(select.columns)) {
    for (const col of select.columns) {
      if ('expr' in col) {
        transformed = walkExpression(col.expr, col, 'expr') || transformed;
      }
    }
  }

  // The parser returns GROUP BY as { columns: [...] }.
  const groupby = select.groupby as
    | { columns?: ExpressionValue[] | null }
    | null
    | undefined;
  if (Array.isArray(groupby?.columns)) {
    transformed = walkList(groupby.columns) || transformed;
  }

  transformed = walkOrderBy(select.orderby) || transformed;

  if (select._next) {
    transformed = walkSelectImpl(select._next) || transformed;
  }

  return transformed;
}

export function transformArrayBounds(ast: AST | AST[]): boolean {
  const statements = Array.isArray(ast) ? ast : [ast];
  let transformed = false;

  for (const stmt of statements) {
    if (stmt.type === 'select') {
      transformed = walkSelectImpl(stmt as Select) || transformed;
    } else if (stmt.type === 'update') {
      transformed =
        walkUpdate(stmt as unknown as UpdateStatement) || transformed;
    }
  }

  return transformed;
}
