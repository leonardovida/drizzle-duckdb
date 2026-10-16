/**
 * Text fallback for array_lower(arr, 1) and array_upper(arr, 1).
 *
 * The AST visitor handles statements node-sql-parser can read and re-print.
 * Drizzle also emits statements it cannot, such as DELETE ... RETURNING
 * without WHERE, INSERT ... SELECT ... RETURNING and WITH ... DELETE. Those
 * reached DuckDB unchanged and failed because it has no array_lower or
 * array_upper. This pass rewrites only the call itself and copies every other
 * character, so literals, parameters and identifiers cannot change.
 */

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$[A-Za-z_]*\$/;

/** Index just past a string, quoted identifier or comment at `index`. */
function skipQuotedOrComment(query: string, index: number): number {
  const char = query[index];
  if (char === "'" || char === '"') {
    for (let i = index + 1; i < query.length; i += 1) {
      if (query[i] === char) {
        if (query[i + 1] === char) {
          i += 1;
          continue;
        }
        return i + 1;
      }
    }
    return query.length;
  }
  if (char === '-' && query[index + 1] === '-') {
    const end = query.indexOf('\n', index + 2);
    return end === -1 ? query.length : end + 1;
  }
  if (char === '/' && query[index + 1] === '*') {
    const end = query.indexOf('*/', index + 2);
    return end === -1 ? query.length : end + 2;
  }
  if (char === '$') {
    // $1 parameters do not match: a dollar-quote tag cannot start with a digit.
    const tag = DOLLAR_TAG.exec(query.slice(index, index + 64))?.[0];
    if (tag) {
      const end = query.indexOf(tag, index + tag.length);
      return end === -1 ? query.length : end + tag.length;
    }
  }
  return index;
}

/**
 * Split the arguments of the call whose `(` is at `open`. Returns undefined
 * when the parentheses do not balance.
 */
function readArguments(
  query: string,
  open: number
): { args: string[]; end: number } | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < query.length; ) {
    const skipped = skipQuotedOrComment(query, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const char = query[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === ')') {
      if (depth === 0) {
        args.push(query.slice(start, i));
        return { args, end: i + 1 };
      }
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      args.push(query.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  return undefined;
}

function arrayBoundsSql(name: string, arr: string): string {
  if (name === 'array_lower') {
    return `CASE WHEN array_length(${arr}) > 0 THEN 1 ELSE NULL END`;
  }
  // NULLIF can evaluate its argument twice. Bind the length once when the
  // expression may be volatile, as the AST visitor does.
  return arr.includes('(')
    ? `list_extract(list_transform(list_value(array_length(${arr})), __drizzle_array_length -> nullif(__drizzle_array_length, 0)), 1)`
    : `nullif(array_length(${arr}), 0)`;
}

/**
 * Rewrite first-dimension array_lower and array_upper calls. Returns the
 * query unchanged when there is nothing to rewrite.
 */
export function rewriteArrayBoundsText(query: string): string {
  let output = '';
  let copied = 0;

  for (let i = 0; i < query.length; ) {
    const skipped = skipQuotedOrComment(query, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (!IDENTIFIER_CHAR.test(query[i]!)) {
      i += 1;
      continue;
    }

    let end = i;
    while (end < query.length && IDENTIFIER_CHAR.test(query[end]!)) end += 1;
    const word = query.slice(i, end).toLowerCase();
    const qualified = i > 0 && query[i - 1] === '.';
    if (qualified || (word !== 'array_lower' && word !== 'array_upper')) {
      i = end;
      continue;
    }

    let open = end;
    while (open < query.length && /\s/.test(query[open]!)) open += 1;
    const call = query[open] === '(' ? readArguments(query, open) : undefined;
    if (!call || call.args.length !== 2 || call.args[1]!.trim() !== '1') {
      i = end;
      continue;
    }

    const arr = rewriteArrayBoundsText(call.args[0]!.trim());
    output += query.slice(copied, i) + arrayBoundsSql(word, arr);
    copied = call.end;
    i = call.end;
  }

  return copied === 0 ? query : output + query.slice(copied);
}
