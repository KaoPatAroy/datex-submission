type Filter = { kind: 'eq' | 'in' | 'is' | 'gt' | 'gte' | 'lte'; column: string; value: unknown };
export type DatabaseRow = Record<string, unknown> & { id: string };
export type ReadCall = {
  table: string;
  filters: Filter[];
  columns: string;
  order?: { column: string; ascending: boolean };
  range?: [number, number];
};
type QueryResult = { data: unknown; error: unknown };
function compareControlledText(left: string, right: string): number {
  // Keep fake .gt/.order internally consistent; this is not a PostgreSQL collation claim.
  return left.localeCompare(right, 'en-US');
}

/** Controlled client seam: these tests prove adapter behavior only, not PostgreSQL SQL semantics. */
export class ControlledSupabaseClient {
  revision = 10;
  readonly rows = new Map<string, DatabaseRow[]>();
  readonly reads: ReadCall[] = [];
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  onRead?: (call: ReadCall, rows: DatabaseRow[]) => void;
  readFailure?: (call: ReadCall) => unknown;
  rpcFailure?: Error;
  rpcResult: QueryResult = { data: null, error: null };

  from(table: string): ControlledQuery {
    return new ControlledQuery(this, table);
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<QueryResult> {
    this.rpcCalls.push({ name, args });
    if (this.rpcFailure) throw this.rpcFailure;
    return this.rpcResult;
  }

  protected candidateRows(call: ReadCall): readonly DatabaseRow[] {
    return this.rows.get(call.table) ?? [];
  }

  async read(call: ReadCall): Promise<QueryResult> {
    this.reads.push({
      ...call,
      filters: [...call.filters],
      ...(call.order ? { order: { ...call.order } } : {}),
      ...(call.range ? { range: [call.range[0], call.range[1]] as [number, number] } : {})
    });
    if (call.table === 'appmeta') {
      const singleton = call.filters.find((filter) => filter.column === 'singleton')?.value;
      const data = singleton === 1 ? { singleton: 1, revision: this.revision } : null;
      return { data, error: null };
    }

    const failure = this.readFailure?.(call);
    if (failure) return { data: null, error: failure };

    const result = this.candidateRows(call).filter((row) => call.filters.every((filter) => {
      const field = filter.column.startsWith('payload->>')
        ? filter.column.slice('payload->>'.length)
        : filter.column;
      const actual = field === 'payload'
        ? row.payload
        : Object.prototype.hasOwnProperty.call(row, field)
          ? row[field]
          : (row.payload as Record<string, unknown> | undefined)?.[field];
      switch (filter.kind) {
        case 'eq': return actual === filter.value;
        case 'in': return Array.isArray(filter.value) && filter.value.includes(actual);
        // Sparse fake rows omit nullable SQL columns; model those omissions as SQL NULL.
        case 'is': return filter.value === null && (actual === null || actual === undefined);
        case 'gt': return typeof actual === 'string' && typeof filter.value === 'string' && compareControlledText(actual, filter.value) > 0;
        case 'gte': return typeof actual === 'string' && typeof filter.value === 'string' && compareControlledText(actual, filter.value) >= 0;
        case 'lte': return typeof actual === 'string' && typeof filter.value === 'string' && compareControlledText(actual, filter.value) <= 0;
      }
    }));
    this.onRead?.(call, result);
    return { data: result, error: null };
  }
}

class ControlledQuery implements PromiseLike<QueryResult> {
  private filters: Filter[] = [];
  private columns = '*';
  private rangeValue: [number, number] | undefined;
  private orderValue: { column: string; ascending: boolean } | undefined;

  constructor(private readonly client: ControlledSupabaseClient, private readonly table: string) {}

  select(columns = '*'): this { this.columns = columns; return this; }
  eq(column: string, value: unknown): this { this.filters.push({ kind: 'eq', column, value }); return this; }
  in(column: string, value: unknown[]): this { this.filters.push({ kind: 'in', column, value }); return this; }
  is(column: string, value: unknown): this { this.filters.push({ kind: 'is', column, value }); return this; }
  gt(column: string, value: unknown): this { this.filters.push({ kind: 'gt', column, value }); return this; }
  gte(column: string, value: unknown): this { this.filters.push({ kind: 'gte', column, value }); return this; }
  lte(column: string, value: unknown): this { this.filters.push({ kind: 'lte', column, value }); return this; }
  order(column = 'id', options: { ascending?: boolean } = {}): this {
    this.orderValue = { column, ascending: options.ascending ?? true };
    return this;
  }
  range(from: number, to: number): this { this.rangeValue = [from, to]; return this; }

  async maybeSingle(): Promise<QueryResult> {
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data as unknown[] : [];
    return { data: Array.isArray(result.data) ? rows[0] ?? null : result.data, error: result.error };
  }

  async single(): Promise<QueryResult> {
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data as unknown[] : [];
    return { data: Array.isArray(result.data) ? rows[0] ?? null : result.data, error: result.error };
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult> {
    const call: ReadCall = {
      table: this.table,
      filters: [...this.filters],
      columns: this.columns,
      ...(this.orderValue ? { order: { ...this.orderValue } } : {}),
      ...(this.rangeValue ? { range: [this.rangeValue[0], this.rangeValue[1]] as [number, number] } : {})
    };
    const result = await this.client.read(call);
    if (Array.isArray(result.data)) {
      let rows = [...result.data] as Array<Record<string, unknown>>;
      if (this.orderValue) {
        const { column, ascending } = this.orderValue;
        rows.sort((left, right) => {
          const leftValue = left[column];
          const rightValue = right[column];
          const comparison = compareControlledText(String(leftValue), String(rightValue));
          return ascending ? comparison : -comparison;
        });
      }
      if (this.rangeValue) {
        const [start, end] = this.rangeValue;
        rows = rows.slice(start, end + 1);
      }
      return { ...result, data: rows };
    }
    return result;
  }
}

