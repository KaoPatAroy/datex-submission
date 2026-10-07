import { describe, expect, it } from 'vitest';
import { canonicalToWireName, exposeTools } from '../lib/ai/tool-schemas';
import { packs } from '../lib/core/packs';

function expectRuntimeErrorCode(operation: () => unknown, code: string) {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code });
}

describe('AI tool exposure contracts', () => {
  const modelDescriptors = packs().flatMap((pack) => pack.tools).filter((tool) => tool.audit === 'read' || tool.audit === 'prepare');
  const exposed = exposeTools(modelDescriptors);
  const byCanonicalName = new Map(exposed.map((tool) => [tool.descriptor.name, tool]));

  it('exposes only the approved read and preparation tools to the model', () => {
    const names = modelDescriptors.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'badge.prepare_revoke',
      'dashboard.prepare_create',
      'dashboard.prepare_share',
      'hr.find_employee',
      'incidents.search',
      'operations.query_inventory',
      'sales.query_metrics',
      'staffing.get_summary',
      'ticket.prepare_create',
    ]);
  });

  it('maps every registered canonical tool to a unique provider-safe name', () => {
    const canonicalNames = modelDescriptors.map((tool) => tool.name);
    const wireNames = canonicalNames.map(canonicalToWireName);

    expect(new Set(wireNames).size).toBe(canonicalNames.length);
    expect(wireNames.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
    expect(wireNames.every((name) => name.length <= 64)).toBe(true);
    expect(canonicalToWireName('sales.query_metrics')).toBe('sales_dquery_umetrics');
    expectRuntimeErrorCode(() => canonicalToWireName('unknown.tool'), 'tool_unavailable');
  });

  it('closes every exposed tool input schema (strict and non-strict) against extra properties', () => {
    expect(exposed.length).toBe(modelDescriptors.length);
    for (const tool of exposed) {
      expect(tool.inputJsonSchema.additionalProperties, tool.descriptor.name).toBe(false);
      expect(tool.strictInputJsonSchema.additionalProperties, tool.descriptor.name).toBe(false);
      expect(tool.wireName).toBe(canonicalToWireName(tool.descriptor.name));
    }
    expect(byCanonicalName.has('sales.query_metrics')).toBe(true);
  });
});
