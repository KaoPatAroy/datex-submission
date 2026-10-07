import { digest, freeze } from '../shared';

export type Trust = 'certified' | 'verified_physical' | 'inferred' | 'unknown';
export type Sensitivity = 'public_business' | 'internal' | 'confidential' | 'personal' | 'restricted';
export interface PhysicalColumn {
  table: string; name: string; type: string; nullable?: boolean; primaryKey?: boolean;
}
export interface PhysicalField {
  id: string; sourceId: string; table: string; path: string; physicalType: string;
  nullable: boolean | 'unknown'; queryable: boolean; keyRole?: 'primary';
  sensitivity: Sensitivity; trust: Trust;
  discovery: { method: 'schema'; version: 1; digest: string };
}
export interface PhysicalDataCatalog {
  version: 1; sourceId: string; fields: readonly PhysicalField[]; digest: string;
}

// Metadata parsing only. This text is never executed or used to construct a query.
function schemaColumns(schema: string): PhysicalColumn[] {
  const columns: PhysicalColumn[] = [];
  const tables = schema.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([\w]+)["`\]]?\s*\(([\s\S]*?)\);/gi);
  for (const [, table, body] of tables) {
    // Split outside SQL literals and balanced CHECK/type parentheses.
    const definitions: string[] = [];
    let depth = 0, quote = '', start = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quote) { if (c === quote) { if (body[i + 1] === quote) i++; else quote = ''; } }
      else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { definitions.push(body.slice(start, i)); start = i + 1; }
    }
    definitions.push(body.slice(start));
    for (const definition of definitions) {
      if (/^\s*(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(definition)) continue;
      const column = definition.match(/^\s*["`\[]?([\w]+)["`\]]?\s+([\w]+)([\s\S]*)$/);
      if (!column) continue;
      columns.push({ table, name: column[1], type: column[2],
        nullable: !/NOT\s+NULL|PRIMARY\s+KEY/i.test(column[3]), primaryKey: /PRIMARY\s+KEY/i.test(column[3]) });
    }
  }
  return columns;
}

export function discoverPhysicalCatalog(input: string | readonly PhysicalColumn[], sourceId = 'sqlite'): PhysicalDataCatalog {
  const columns = typeof input === 'string' ? schemaColumns(input) : input;
  const ids = new Set<string>();
  const fields = columns.map((column): PhysicalField => {
    const id = `${sourceId}.${column.table}.${column.name}`;
    if (ids.has(id)) throw new Error('Duplicate physical field.');
    ids.add(id);
    return { id, sourceId, table: column.table, path: column.name, physicalType: column.type,
      nullable: column.nullable ?? 'unknown', queryable: false,
      ...(column.primaryKey ? { keyRole: 'primary' as const } : {}),
      sensitivity: 'restricted', trust: 'verified_physical',
      discovery: { method: 'schema', version: 1, digest: digest(column) } };
  });
  return freeze({ version: 1, sourceId, fields, digest: digest(fields) });
}
