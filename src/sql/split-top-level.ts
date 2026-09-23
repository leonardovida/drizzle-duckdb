export function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      current += char;
      if (char === quote) {
        if (input[index + 1] === quote) {
          current += input[++index];
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === delimiter && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
