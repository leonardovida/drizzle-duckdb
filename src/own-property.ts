export function assignOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return;
  }

  target[key] = value;
}
