import type { Reader, Table } from '../contracts';

/** Backend `in` filters, kept below the validated filter and PostgREST page limits. */
export async function listByIds<T>(reader: Reader, table: Table, input: readonly string[]): Promise<T[]> {
  const ids = [...new Set(input)];
  const pages: Promise<T[]>[] = [];
  for (let offset = 0; offset < ids.length; offset += 500) pages.push(reader.list<T>(table, { id: ids.slice(offset, offset + 500) }));
  return (await Promise.all(pages)).flat();
}
