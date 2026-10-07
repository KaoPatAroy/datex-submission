export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'DomainError'; }
}
export function invariant(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
