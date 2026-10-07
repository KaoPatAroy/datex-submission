import { describe, expect, it } from 'vitest';
import { dashboardSourcesForWidgets } from '../lib/visualization/dashboard-sources';
import type { Dashboard, SourceRef } from '../lib/contracts';
import type { VizWidgetResult } from '../lib/visualization/dashboard-data';
import { tableDatasets } from '../lib/dynamic/catalog/tables';
import { HR_DATASET, HR_HEADCOUNT_MEASURE } from '../lib/dynamic/catalog/hr';

const sources = [
  { id: 'sales:E02:2026-10-01', system: 'sales', observedAt: '', retrievedAt: '', freshness: 'fresh', detail: '' },
  { id: 'inventory:E02:2026-10-01', system: 'inventory', observedAt: '', retrievedAt: '', freshness: 'fresh', detail: '' },
  { id: 'incidents:E02:2026-10-01', system: 'incidents', observedAt: '', retrievedAt: '', freshness: 'fresh', detail: '' },
] as SourceRef[];
const widgets = [{ type: 'viz', title: 'Sales by region', measure: 'net_sales', dimension: 'region' }] as Dashboard['spec']['widgets'];
const widgetData: VizWidgetResult[] = [{ index: 0, status: 'ready', data: {
  kind: 'bar', title: 'Sales by region', measure: 'net_sales', measureLabel: 'ยอดขายสุทธิ', dimension: 'region', dimensionLabel: 'ภูมิภาค',
  unit: 'THB', unitLabel: 'บาท', points: [], total: 0, shown: 0, sort: null, topN: null,
  evidence: { id: 'evidence', version: 1, digest: 'digest' }, limitations: [], sources: ['sales:E02:2026-10-01'],
} }];

describe('Dashboard source presentation', () => {
  it('counts only sources referenced by the Dashboard widgets', () => {
    expect(dashboardSourcesForWidgets(sources, widgets, widgetData).map(source => source.id)).toEqual(['sales:E02:2026-10-01']);
  });

  it('filters stored source metadata for Dashboard cards when per-widget data is not loaded', () => {
    expect(dashboardSourcesForWidgets(sources, widgets).map(source => source.id)).toEqual(['sales:E02:2026-10-01']);
  });

  it('uses the metric source systems for a legacy sales chart', () => {
    const legacySalesChart = [{ type: 'bar_chart', title: 'ยอดขาย', metric: 'net_sales', groupBy: 'branch' }] as Dashboard['spec']['widgets'];
    expect(dashboardSourcesForWidgets(sources, legacySalesChart).map(source => source.id)).toEqual(['sales:E02:2026-10-01']);
  });

  it('counts dynamic catalog measures without per-widget visualization data', () => {
    const catalogMeasures = tableDatasets([]).flatMap(dataset => dataset.fields)
      .filter(field => ['on_hand', 'incident_records'].includes(field.id));
    const dynamicWidgets = [
      { type: 'viz', title: 'คงเหลือ', measure: 'on_hand', dimension: 'product' },
      { type: 'viz', title: 'เหตุการณ์', measure: 'incident_records', dimension: 'kind' },
    ] as Dashboard['spec']['widgets'];

    expect(dashboardSourcesForWidgets(sources, dynamicWidgets).map(source => source.id)).toEqual([
      'inventory:E02:2026-10-01', 'incidents:E02:2026-10-01',
    ]);
    expect(new Set(dashboardSourcesForWidgets(sources, dynamicWidgets).map(source => source.system)))
      .toEqual(new Set(catalogMeasures.flatMap(field => field.sourceSystems)));
  });

  it('uses the registered HR dataset source for its headcount measure', () => {
    const hrSource = { id: 'hr:E02:2026-10-01', system: HR_DATASET.owner, observedAt: '', retrievedAt: '', freshness: 'fresh', detail: '' } as SourceRef;
    const hrWidget = [{ type: 'viz', title: 'พนักงาน', measure: HR_HEADCOUNT_MEASURE.fieldId }] as Dashboard['spec']['widgets'];

    expect(dashboardSourcesForWidgets([...sources, hrSource], hrWidget)).toEqual([hrSource]);
  });

  it('keeps all dashboard sources when a visualization is not ready', () => {
    const notReady: VizWidgetResult[] = [{ index: 0, status: 'unavailable', text: 'unavailable' }];

    expect(dashboardSourcesForWidgets(sources, widgets, notReady).map(source => source.id)).toEqual(sources.map(source => source.id));
  });

  it('keeps all dashboard sources when supplied visualization data omits a widget result', () => {
    expect(dashboardSourcesForWidgets(sources, widgets, []).map(source => source.id)).toEqual(sources.map(source => source.id));
  });
});
