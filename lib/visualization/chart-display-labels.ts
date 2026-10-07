import type { ArtifactLabels, SafeVisualizationSpec } from './contracts';

export function chartCategoryLabel(spec: SafeVisualizationSpec, labels: ArtifactLabels | undefined, category: string) {
  return labels?.values[spec.xField]?.[category] ?? spec.categoryLabels?.[category] ?? category;
}

export function chartSeriesLabel(spec: SafeVisualizationSpec, labels: ArtifactLabels | undefined, seriesId: string) {
  return labels?.fields[seriesId] ?? spec.points.find(point => point.series === seriesId)?.seriesLabel ?? seriesId;
}
