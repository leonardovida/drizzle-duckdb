/** Preserve the millisecond precision of bigint TIME values decoded via Date. */
export function timeFromMicros(value: bigint): string {
  const date = new Date(Number(value) / 1000);
  return date.toISOString().split('T')[1]!.replace('Z', '');
}
