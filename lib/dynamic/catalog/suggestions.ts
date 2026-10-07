import type { SemanticDataset } from './semantic';

/**
 * Next-step questions derived from the REGISTERED dataset itself (default measure, default grouping and registered views), so a
 * dataset added to the catalog is suggested without any parallel list. Plain Thai from the dataset's own display labels; no data.
 */
export function datasetSuggestions(dataset: SemanticDataset): string[] {
  const label = (id: string) => dataset.fields.find(field => field.id === id)?.displayLabel;
  const measure = label(dataset.defaultMeasure);
  const group = dataset.defaultDimensions.map(label).filter((item): item is string => !!item).slice(0, 1);
  const out: string[] = [];
  if (measure) out.push(`ดู${measure}${group.length ? `แยกตาม${group[0]}` : ''}`);
  for (const view of Object.values(dataset.defaultViews)) {
    const labels = view.map(label).filter((item): item is string => !!item);
    if (labels.length) out.push(`ดู${labels.join(' และ ')}${group.length ? `แยกตาม${group[0]}` : ''}`);
  }
  return [...new Set(out)].slice(0, 3);
}
