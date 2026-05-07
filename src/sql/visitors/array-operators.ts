/**
 * AST visitor to transform Postgres array operators to DuckDB functions.
 */

import type {
  AST,
  Binary,
  ExpressionValue,
  Select,
  From,
  Join,
} from 'node-sql-parser';

const OPERATOR_MAP: Record<string, { fn: string; swap?: boolean }> = {
  '@>': { fn: 'array_has_all' },
  '<@': { fn: 'array_has_all', swap: true },
  '&&': { fn: 'array_has_any' },
};

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
        result:
          functionName === 'array_lower'
            ? { type: 'number' as const, value: 1 }
            : lengthExpr,
      },
      {
        type: 'else' as const,
        result: { type: 'null' as const, value: null },
      },
    ],
  };
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
    const mapping = OPERATOR_MAP[binary.operator];

    if (mapping) {
      const fnExpr = {
        type: 'function' as const,
        name: { name: [{ type: 'default', value: mapping.fn }] },
        args: {
          type: 'expr_list' as const,
          value: mapping.swap
            ? [binary.right, binary.left]
            : [binary.left, binary.right],
        },
      };

      if (parent && key) {
        (parent as Record<string, unknown>)[key] = fnExpr;
      }
      transformed = true;
    } else {
      transformed =
        walkExpression(binary.left as ExpressionValue, binary, 'left') ||
        transformed;
      transformed =
        walkExpression(binary.right as ExpressionValue, binary, 'right') ||
        transformed;
    }
  }

  if ('type' in expr && exprObj.type === 'function') {
    transformed =
      transformArrayBoundsFunction(exprObj, parent, key) || transformed;
  }

  if ('type' in expr && exprObj.type === 'unary_expr') {
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

  if (select._next) {
    transformed = walkSelectImpl(select._next) || transformed;
  }

  return transformed;
}

export function transformArrayOperators(ast: AST | AST[]): boolean {
  const statements = Array.isArray(ast) ? ast : [ast];
  let transformed = false;

  for (const stmt of statements) {
    if (stmt.type === 'select') {
      transformed = walkSelectImpl(stmt as Select) || transformed;
    }
  }

  return transformed;
}
