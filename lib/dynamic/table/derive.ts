import type { Branch, Product } from '../../contracts';

/** Server-owned lookup context for derivations (never user text). */
export interface DeriveContext {
  branches: ReadonlyMap<string, Branch>;
  products: ReadonlyMap<string, Product>;
}
export type StoredRow = Readonly<Record<string, unknown>> & { id: string };
export type Derived = string | number | null;

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const stamp = (value: unknown): number | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Registered derivations: pure functions of one stored row plus the registered lookup tables. A SemanticField may only name an
 * id from this registry; there is no expression language, SQL or user-supplied code anywhere in the table path.
 */
export const DERIVATIONS: Readonly<Record<string, (row: StoredRow, context: DeriveContext) => Derived>> = Object.freeze({
  region: (row, context) => context.branches.get(String(row.branchId))?.region ?? null,
  product_name: (row, context) => context.products.get(String(row.productId))?.name ?? null,
  product_category: (row, context) => context.products.get(String(row.productId))?.category ?? null,
  stock_shortfall: row => {
    const onHand = finite(row.onHand), minimum = finite(row.minimum);
    return onHand === null || minimum === null ? null : Math.max(minimum - onHand, 0);
  },
  low_stock_flag: row => {
    const onHand = finite(row.onHand), minimum = finite(row.minimum);
    return onHand === null || minimum === null ? null : onHand < minimum ? 1 : 0;
  },
  row_count: () => 1,
  incident_hours: row => {
    const start = stamp(row.startedAt), end = stamp(row.endedAt);
    return start === null || end === null || end < start ? null : Math.round((end - start) / 36_000) / 100;
  },
  created_date: row => typeof row.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.createdAt) ? row.createdAt.slice(0, 10) : null,
});
