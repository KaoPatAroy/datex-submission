import { describe, expect, it } from 'vitest';
import { chartCategoryLabel, chartSeriesLabel } from '../../lib/visualization/chart-display-labels';
import type { ArtifactLabels, SafeVisualizationSpec } from '../../lib/visualization/contracts';

const spec = {
  xField: 'region',
  categoryLabels: { central: 'central' },
  points: [{ series: 'difference', seriesLabel: 'difference' }],
} as unknown as SafeVisualizationSpec;
const labels: ArtifactLabels = {
  fields: { difference: 'ส่วนต่าง' },
  units: {},
  values: { region: { central: 'ภาคกลาง', east: 'ภาคตะวันออก', south: 'ภาคใต้' } },
};

describe('artifact chart display labels', () => {
  it('uses catalog value labels for categories and field labels for series', () => {
    expect(chartCategoryLabel(spec, labels, 'central')).toBe('ภาคกลาง');
    expect(chartCategoryLabel(spec, labels, 'east')).toBe('ภาคตะวันออก');
    expect(chartCategoryLabel(spec, labels, 'south')).toBe('ภาคใต้');
    expect(chartSeriesLabel(spec, labels, 'difference')).toBe('ส่วนต่าง');
  });
});
