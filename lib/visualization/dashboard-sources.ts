import type { Analysis, Dashboard, SourceRef } from '../contracts';
import type { VizWidgetResult } from './dashboard-data';
import { HR_DATASET_METADATA } from '../dynamic/catalog/hr-metadata';
import { tableDatasets } from '../dynamic/catalog/tables';

const METRIC_SOURCES: Record<string, readonly string[]> = {
  net_sales: ['sales'], target: ['targets'], gap: ['sales', 'targets'], achievement: ['sales', 'targets'],
  stock_issues: ['inventory'], incident_count: ['incidents'], staffing_actual: ['staffing'], staffing_planned: ['staffing'],
};

const CATALOG_MEASURE_SOURCES = new Map(tableDatasets([]).flatMap(dataset => dataset.fields
  .filter(field => field.kind === 'measure')
  .map(field => [field.id, field.sourceSystems] as const)));
const HR_FIELD_IDS = new Set<string>(HR_DATASET_METADATA.fields);

function measureSystems(measure: string): readonly string[] | null {
  return METRIC_SOURCES[measure] ?? CATALOG_MEASURE_SOURCES.get(measure) ?? (HR_FIELD_IDS.has(measure) ? [HR_DATASET_METADATA.owner] : null);
}

function widgetSystems(widget: Dashboard['spec']['widgets'][number]): readonly string[] | null {
  if (widget.type === 'viz') {
    const measures = [...new Set([widget.measure, ...(widget.measures ?? []), ...(widget.lineMeasures ?? [])])];
    const systems = measures.map(measureSystems);
    return systems.some(value => value === null) ? null : [...new Set(systems.flatMap(value => value ?? []))];
  }
  if (widget.type === 'metric' || widget.type === 'bar_chart' || widget.type === 'line_chart') return measureSystems(widget.metric);
  if (widget.type === 'table') {
    if (widget.dataset === 'inventory') return ['inventory'];
    if (widget.dataset === 'staffing') return ['staffing'];
    if (widget.dataset === 'open_incidents') return ['incidents'];
    if (widget.dataset === 'branch_metrics') return ['sales', 'targets', 'inventory', 'incidents', 'staffing'];
    return null;
  }
  if (widget.type === 'incident_list') return ['incidents'];
  if (widget.type === 'text_summary') return [];
  return null;
}

export function dashboardSourcesForWidgets(
  sources: SourceRef[], widgets: Dashboard['spec']['widgets'], vizData?: VizWidgetResult[], analysis?: Analysis | null,
) {
  const usedSourceIds = new Set<string>();
  const usedSystems = new Set<string>();
  let keepAllSources = false;
  for (const claim of [
    ...(analysis?.facts ?? []), ...(analysis?.relationships ?? []), ...(analysis?.hypotheses ?? []), ...(analysis?.missingEvidence ?? []),
  ]) claim.sourceIds.forEach(id => usedSourceIds.add(id));
  const vizByIndex = new Map((vizData ?? []).map(result => [result.index, result]));
  widgets.forEach((widget, index) => {
    if (widget.type === 'viz') {
      const result = vizByIndex.get(index);
      if (vizData !== undefined) {
        if (result?.status === 'ready') result.data.sources.forEach(id => usedSourceIds.add(id));
        else keepAllSources = true;
        return;
      }
    }
    const systems = widgetSystems(widget);
    if (systems === null) keepAllSources = true;
    else systems.forEach(system => usedSystems.add(system));
  });
  if (keepAllSources) return sources;
  for (const system of usedSystems) {
    const matching = sources.filter(source => source.system === system);
    if (!matching.length) return sources;
    matching.forEach(source => usedSourceIds.add(source.id));
  }
  return sources.filter(source => usedSourceIds.has(source.id));
}
