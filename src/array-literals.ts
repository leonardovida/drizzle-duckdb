function parseArrayJson(value: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isPgArrayLiteral(value: string): boolean {
  return value.startsWith('{') && value.endsWith('}');
}

export function coerceArrayString(value: string): unknown[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    return parseArrayJson(trimmed);
  }

  if (isPgArrayLiteral(trimmed)) {
    const json = trimmed.replace(/{/g, '[').replace(/}/g, ']');
    return parseArrayJson(json);
  }

  return undefined;
}

export function parsePgArrayLiteral(value: string): unknown {
  return coerceArrayString(value) ?? value;
}
