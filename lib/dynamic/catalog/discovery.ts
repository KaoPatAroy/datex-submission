import { z } from 'zod';
import type { DepartmentPack } from '../../contracts';
import type { WorkflowProjectionDefinition } from '../../storage/workflow-projections';
import { idSchema, refSchema } from '../plan/schemas';
import { digest, freeze } from '../shared';

const fieldSchema = z.object({
  id: idSchema, path: z.string().min(1).max(300), physicalType: z.string().min(1).max(40), nullable: z.boolean(),
  queryable: z.literal(false), declaredQueryable: z.boolean(), trust: z.literal('verified_physical'),
  sensitivity: z.literal('restricted'), status: z.literal('candidate'),
}).strict();
export const discoveryCatalogSchema = z.object({
  version: z.literal(1), revision: z.number().int().positive(), ref: refSchema,
  datasets: z.array(z.object({ id: idSchema, sourceId: idSchema, sourceVersion: z.string().min(1).max(100),
    method: z.enum(['pack_schema', 'projection_manifest']), status: z.literal('candidate'),
    fields: z.array(fieldSchema).max(2000), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(500),
}).strict();
export type DiscoveryCatalog = z.infer<typeof discoveryCatalogSchema>;
type Candidate = DiscoveryCatalog['datasets'][number];

type JsonShape = { type?: string | string[]; properties?: Record<string, JsonShape>; required?: string[];
  items?: JsonShape; anyOf?: JsonShape[]; oneOf?: JsonShape[] };

function jsonFields(schema: JsonShape, prefix = '', inheritedNullable = false, depth = 0): Omit<z.infer<typeof fieldSchema>, 'id'>[] {
  if (depth > 12) throw new Error('Discovery depth budget exceeded.');
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const nullable = inheritedNullable || variants.some(v => v.type === 'null');
    return variants.filter(v => v.type !== 'null').flatMap(v => jsonFields(v, prefix, nullable, depth + 1));
  }
  if (schema.properties) return Object.entries(schema.properties).flatMap(([key, child]) =>
    jsonFields(child, prefix ? `${prefix}.${key}` : key, inheritedNullable || !schema.required?.includes(key), depth + 1));
  if (schema.items) return jsonFields(schema.items, `${prefix}[]`, inheritedNullable, depth + 1);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? 'unknown'];
  return [{ path: prefix || 'value', physicalType: types.filter(t => t !== 'null').join('|'),
    nullable: inheritedNullable || types.includes('null'), queryable: false, declaredQueryable: false,
    trust: 'verified_physical', sensitivity: 'restricted', status: 'candidate' }];
}

/** Consumes the server's registered descriptors; never calls a tool or opens a database. */
export function discoverRegisteredCatalog(input: {
  packs: readonly DepartmentPack[]; workflows: readonly WorkflowProjectionDefinition[]; revision: number;
}): DiscoveryCatalog {
  if (input.packs.length > 100 || input.workflows.length > 300) throw new Error('Discovery dataset budget exceeded.');
  const datasets: Candidate[] = [];
  for (const pack of input.packs) for (const tool of pack.tools) {
    const schema = z.toJSONSchema(tool.resultSchema, { unrepresentable: 'any', io: 'output' }) as JsonShape;
    const id = `pack:${pack.id}:${tool.name}`;
    const byPath = new Map<string, Omit<z.infer<typeof fieldSchema>, 'id'>>();
    for (const field of jsonFields(schema)) {
      const prior = byPath.get(field.path);
      byPath.set(field.path, prior ? { ...field, physicalType: prior.physicalType === field.physicalType ? field.physicalType : 'unknown',
        nullable: prior.nullable || field.nullable } : field);
    }
    datasets.push({ id, sourceId: pack.id, sourceVersion: `${pack.version}:${pack.implementationRevision}`, method: 'pack_schema',
      status: 'candidate', fields: [...byPath.values()].map(field => ({ ...field, id: `field:${digest({ id, path: field.path })}` })), sourceDigest: digest(schema) });
  }
  for (const manifest of input.workflows) {
    const id = `workflow:${manifest.table}`;
    const metadata = { table: manifest.table, columns: manifest.columns, queryFields: manifest.queryFields,
      markerlessV2Discriminators: manifest.markerlessV2Discriminators, projectionEqualities: manifest.projectionEqualities };
    datasets.push({ id, sourceId: 'workflow', sourceVersion: digest(metadata), method: 'projection_manifest', status: 'candidate',
      sourceDigest: digest(metadata), fields: manifest.columns.map(column => ({
        id: `field:${digest({ id, path: column.bodyField })}`, path: column.bodyField, physicalType: column.type,
        nullable: column.nullable, queryable: false, declaredQueryable: column.queryable === true,
        trust: 'verified_physical', sensitivity: 'restricted', status: 'candidate',
      })) });
  }
  if (new Set(datasets.map(d => d.id)).size !== datasets.length || datasets.some(d => new Set(d.fields.map(f => f.id)).size !== d.fields.length)) {
    throw new Error('Duplicate discovery identity.');
  }
  datasets.sort((a, b) => a.id.localeCompare(b.id));
  for (const dataset of datasets) dataset.fields.sort((a, b) => a.id.localeCompare(b.id));
  const payload = { version: 1 as const, revision: input.revision, datasets };
  return freeze(discoveryCatalogSchema.parse({ ...payload, ref: { id: 'physical_candidates', version: input.revision, digest: digest(payload) } }));
}
