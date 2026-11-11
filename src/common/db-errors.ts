/** True for a Postgres unique violation, optionally on one named constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as any;
  const code = e?.driverError?.code ?? e?.code;
  if (code !== '23505') return false;
  if (!constraint) return true;
  return (e?.driverError?.constraint ?? e?.constraint) === constraint;
}

export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as any;
  return (e?.driverError?.code ?? e?.code) === '23503';
}

/** Escapes `%`, `_` and `\` so user input can be used inside LIKE. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
