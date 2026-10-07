import 'server-only';

import { z } from 'zod';
import type { ToolDescriptor } from '../contracts';
import { AIRuntimeError } from './errors';

export const canonicalToolNames = [
  'sales.query_metrics',
  'operations.query_inventory',
  'incidents.search',
  'staffing.get_summary',
  'dashboard.prepare_create',
  'dashboard.prepare_share',
  'ticket.prepare_create',
  'badge.prepare_revoke',
  'hr.find_employee'
] as const;

export const readDataToolNames = [
  'sales.query_metrics',
  'operations.query_inventory',
  'incidents.search',
  'staffing.get_summary',
  'hr.find_employee'
] as const;

const canonicalNameSet = new Set<string>(canonicalToolNames);

/** Escapes punctuation so the mapping stays injective even for underscores. */
export function canonicalToWireName(name: string): string {
  if (!canonicalNameSet.has(name)) {
    throw new AIRuntimeError('tool_unavailable', 'A requested tool is not available.');
  }
  return registeredWireName(name);
}
/** Names here come from the trusted, actor-filtered runtime catalog, never model input. */
function registeredWireName(name:string):string {
  if(!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(name))throw new AIRuntimeError('invalid_configuration','A registered tool name is invalid.');
  const wire = name.replaceAll('_', '_u').replaceAll('.', '_d');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(wire)) {
    throw new AIRuntimeError('invalid_configuration', 'A tool name cannot be exposed to the AI provider.');
  }
  return wire;
}

export interface ExposedTool {
  descriptor: ToolDescriptor;
  wireName: string;
  inputJsonSchema: Record<string, unknown>;
  strictInputJsonSchema: Record<string, unknown>;
}

function inlineLocalRefs(root: Record<string, unknown>): Record<string, unknown> {
  const definitions = {
    ...(root.$defs && typeof root.$defs === 'object' ? root.$defs as Record<string, unknown> : {}),
    ...(root.definitions && typeof root.definitions === 'object' ? root.definitions as Record<string, unknown> : {})
  };

  const visit = (value: unknown, stack: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map((entry) => visit(entry, stack));
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'string') {
      const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(object.$ref);
      if (!match) throw new Error('unsupported schema reference');
      const key = match[1].replaceAll('~1', '/').replaceAll('~0', '~');
      if (stack.has(key) || !(key in definitions)) throw new Error('recursive schema reference');
      const nextStack = new Set(stack);
      nextStack.add(key);
      return visit(definitions[key], nextStack);
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      if (key === '$defs' || key === 'definitions' || key === '$schema' || key === '$id') continue;
      result[key] = visit(child, stack);
    }
    return result;
  };

  return visit(root, new Set()) as Record<string, unknown>;
}

function makeStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) result[key] = visit(child);

    if (result.type === 'object' || result.properties && typeof result.properties === 'object') {
      const properties = result.properties && typeof result.properties === 'object'
        ? result.properties as Record<string, unknown>
        : {};
      const required = new Set(Array.isArray(result.required) ? result.required.filter((entry): entry is string => typeof entry === 'string') : []);
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (required.has(key)) continue;
        properties[key] = { anyOf: [propertySchema, { type: 'null' }] };
        required.add(key);
      }
      result.properties = properties;
      result.required = [...required];
      result.additionalProperties = false;
    }
    return result;
  };

  return visit(schema) as Record<string, unknown>;
}

function closeObjectSchemas(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = visit(child);
    if (result.type === 'object' || result.properties && typeof result.properties === 'object') {
      result.additionalProperties = false;
    }
    return result;
  };
  return visit(schema) as Record<string, unknown>;
}

function jsonSchemaFor(descriptor: ToolDescriptor): { inputJsonSchema: Record<string, unknown>; strictInputJsonSchema: Record<string, unknown> } {
  let generated: unknown;
  try {
    generated = z.toJSONSchema(descriptor.inputSchema, { target: 'draft-7', io: 'input' });
  } catch {
    throw new AIRuntimeError('invalid_configuration', 'A tool has an unsupported input schema.');
  }
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) {
    throw new AIRuntimeError('invalid_configuration', 'A tool has an unsupported input schema.');
  }

  let inlined: Record<string, unknown>;
  try {
    inlined = inlineLocalRefs(generated as Record<string, unknown>);
  } catch {
    throw new AIRuntimeError('invalid_configuration', 'A tool has an unsupported input schema.');
  }
  if (inlined.type !== 'object') {
    throw new AIRuntimeError('invalid_configuration', 'Tool input schemas must describe an object.');
  }
  const closed = closeObjectSchemas(inlined);
  return { inputJsonSchema: closed, strictInputJsonSchema: makeStrictSchema(closed) };
}

export function exposeTools(descriptors: ToolDescriptor[]): ExposedTool[] {
  const seen = new Set<string>();
  const exposed: ExposedTool[] = [];
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new AIRuntimeError('invalid_configuration', 'The tool registry contains a duplicate tool name.');
    }
    seen.add(descriptor.name);
    if (descriptor.audit !== 'read' && descriptor.audit !== 'prepare') continue;
    if (descriptor.name.endsWith('.execute_create') || descriptor.name.endsWith('.execute_revoke') || descriptor.name.endsWith('.verify')) continue;
    const { inputJsonSchema, strictInputJsonSchema } = jsonSchemaFor(descriptor);
    exposed.push({ descriptor, wireName: registeredWireName(descriptor.name), inputJsonSchema, strictInputJsonSchema });
  }

  const wireNames = new Set(exposed.map((tool) => tool.wireName));
  if (wireNames.size !== exposed.length) {
    throw new AIRuntimeError('invalid_configuration', 'Tool names could not be mapped uniquely.');
  }
  return exposed;
}

function dereferenceSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return schema;
}

export function assertNoAdditionalProperties(value: unknown, schema: Record<string, unknown>): void {
  const visit = (candidate: unknown, schemaNode: unknown): void => {
    if (Array.isArray(candidate) && schemaNode && typeof schemaNode === 'object') {
      const items = (schemaNode as Record<string, unknown>).items;
      if (items) for (const entry of candidate) visit(entry, items);
      return;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !schemaNode || typeof schemaNode !== 'object') return;
    const object = candidate as Record<string, unknown>;
    const node = dereferenceSchema(schemaNode as Record<string, unknown>);
    const properties = node.properties && typeof node.properties === 'object' ? node.properties as Record<string, unknown> : {};
    if (node.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) throw new AIRuntimeError('invalid_model_response', 'The AI returned unexpected tool arguments.');
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in object) visit(object[key], childSchema);
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      const branches = node[keyword];
      if (Array.isArray(branches)) {
        const matching = branches.find((branch) => {
          try {
            visit(candidate, branch);
            return true;
          } catch {
            return false;
          }
        });
        if (matching) return;
      }
    }
  };

  visit(value, schema);
}

export function stripOptionalNulls(value: unknown, schema: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    const itemSchema = schema.items && typeof schema.items === 'object' ? schema.items as Record<string, unknown> : {};
    return value.map((entry) => stripOptionalNulls(entry, itemSchema));
  }
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, unknown> : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : []);
  const schemaAllowsNull = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    const objectNode = node as Record<string, unknown>;
    if (objectNode.type === 'null' || Array.isArray(objectNode.type) && objectNode.type.includes('null')) return true;
    return ['anyOf', 'oneOf'].some((keyword) => Array.isArray(objectNode[keyword])
      && (objectNode[keyword] as unknown[]).some(schemaAllowsNull));
  };
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    const childSchema = properties[key] && typeof properties[key] === 'object' ? properties[key] as Record<string, unknown> : {};
    if (child === null && !required.has(key) && !schemaAllowsNull(childSchema)) continue;
    result[key] = stripOptionalNulls(child, childSchema);
  }
  return result;
}
