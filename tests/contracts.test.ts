import { describe, expect, it } from 'vitest';
import { dashboardSpecSchema, scopeSchema, widgetSchema } from '../lib/contracts';

const scope = { region: 'East', date: '2026-09-30', branchIds: ['east-01'] };

describe('scopeSchema', () => {
  it('accepts a bounded region, ISO business date, and optional branch list', () => {
    expect(scopeSchema.parse(scope)).toEqual(scope);
    expect(scopeSchema.parse({ region: 'All', date: '2026-09-30' })).toEqual({
      region: 'All',
      date: '2026-09-30',
    });
  });

  it('rejects missing scope, malformed or impossible dates, excessive branch lists, and unknown fields', () => {
    expect(scopeSchema.safeParse({ region: '', date: '2026-09-30' }).success).toBe(false);
    expect(scopeSchema.safeParse({ region: 'East', date: '09/30/2026' }).success).toBe(false);
    expect(scopeSchema.safeParse({ region: 'East', date: '2026-02-30' }).success).toBe(false);
    expect(scopeSchema.safeParse({
      region: 'East',
      date: '2026-09-30',
      branchIds: Array.from({ length: 13 }, (_, index) => `branch-${index}`),
    }).success).toBe(false);
    expect(scopeSchema.safeParse({ ...scope, actorId: 'forged' }).success).toBe(false);
  });
});

describe('widgetSchema', () => {
  it.each([
    { type: 'metric', title: 'Net sales', metric: 'net_sales' },
    { type: 'bar_chart', title: 'Sales by branch', metric: 'net_sales', groupBy: 'branch' },
    { type: 'line_chart', title: 'Sales trend', metric: 'net_sales', comparisonMetric: 'target', groupBy: 'branch' },
    { type: 'table', title: 'Branch metrics', dataset: 'branch_metrics' },
    { type: 'table', title: 'Inventory', dataset: 'inventory' },
    { type: 'table', title: 'Staffing', dataset: 'staffing' },
    { type: 'table', title: 'Open incidents', dataset: 'open_incidents' },
    { type: 'incident_list', title: 'Open incidents', dataset: 'open_incidents' },
    { type: 'text_summary', title: 'Summary' },
  ])('accepts the supported widget shape: $type / $title', (widget) => {
    expect(widgetSchema.safeParse(widget).success).toBe(true);
  });

  it('rejects unsupported widget variants, metrics, datasets, grouping, and extra properties', () => {
    expect(widgetSchema.safeParse({ type: 'pie_chart', title: 'Mix', metric: 'net_sales' }).success).toBe(false);
    expect(widgetSchema.safeParse({ type: 'metric', title: 'Mystery', metric: 'profit' }).success).toBe(false);
    expect(widgetSchema.safeParse({ type: 'table', title: 'Mystery', dataset: 'employees' }).success).toBe(false);
    expect(widgetSchema.safeParse({ type: 'bar_chart', title: 'Sales', metric: 'net_sales', groupBy: 'employee' }).success).toBe(false);
    expect(widgetSchema.safeParse({ type: 'metric', title: 'Sales', metric: 'net_sales', execute: true }).success).toBe(false);
    expect(widgetSchema.safeParse({ type: 'text_summary', title: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('dashboardSpecSchema', () => {
  const validSpec = {
    title: 'East sales overview',
    description: 'Sales and operating evidence for the selected date.',
    scope,
    widgets: [
      { type: 'metric', title: 'Net sales', metric: 'net_sales' },
      { type: 'table', title: 'Branch metrics', dataset: 'branch_metrics' },
    ],
  };

  it('accepts a bounded spec whose widgets and scope are valid', () => {
    expect(dashboardSpecSchema.parse(validSpec)).toEqual(validSpec);
  });

  it('rejects empty, oversized, malformed, or extended dashboard specs', () => {
    expect(dashboardSpecSchema.safeParse({ ...validSpec, widgets: [] }).success).toBe(false);
    expect(dashboardSpecSchema.safeParse({
      ...validSpec,
      widgets: Array.from({ length: 13 }, () => validSpec.widgets[0]),
    }).success).toBe(false);
    expect(dashboardSpecSchema.safeParse({ ...validSpec, title: '' }).success).toBe(false);
    expect(dashboardSpecSchema.safeParse({ ...validSpec, ownerId: 'forged-owner' }).success).toBe(false);
    expect(dashboardSpecSchema.safeParse({
      ...validSpec,
      widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales', region: 'All' }],
    }).success).toBe(false);
  });
});
