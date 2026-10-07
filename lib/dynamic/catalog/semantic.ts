import type { Branch, BranchMetric, Table } from '../../contracts';
import type { Sensitivity, Trust } from './physical';
import { digest, freeze, unique } from '../shared';
import { regionDefinitions } from './seed';
import { tableDatasets } from './tables';

export interface CanonicalValue { id: string; label: string; description: string; region?: string; labels?: readonly string[] }
export interface SemanticField {
  id: string; description: string; labels?: readonly string[]; displayLabel?: string; displayUnit?: string;
  kind: 'dimension' | 'measure'; trust: Trust; sensitivity: Sensitivity;
  requiredPermissions: readonly string[]; sourceSystems: readonly string[]; unit?: string;
  binding?: keyof BranchMetric; calculatorId?: string; aggregations: readonly string[];
  additivity?: 'additive' | 'snapshot'; targetFieldId?: string;
  canonicalValues?: readonly CanonicalValue[];
  /** table_rows datasets only: the stored column this field reads, or the registered derivation computing it from a row. */
  column?: string; derived?: string; valueType?: 'string' | 'number';
}
/** How a `table_rows` dataset maps onto one registered store table (no SQL: only registered filters and derivations run). */
export interface TableBinding {
  table: Table; sourceSystem: string; ownerPackId: string;
  /** Store column (or registered derivation id) holding the business date; null = the dataset has no date axis. */
  dateColumn: string | null; dateIsDerived: boolean;
  /** Snapshot tables hold one row set per date: several dates may not be summed together. */
  snapshot: boolean;
  /** Store column holding the branch id (always pushed into the read as a branch filter). */
  branchColumn: string;
  /** Registered joins to other table datasets: the declared keys are the only legal join keys. */
  joins: readonly { to: string; keys: readonly string[] }[];
  /** Timestamp column proving source freshness. */
  observedColumn: string;
}
export interface SemanticDataset {
  id: string; version: 1; description: string; trust: Trust; sensitivity: Sensitivity;
  /** Thai display name shown to users (clarify chips, capability text, answer headers). */
  label?: string;
  readerId: 'branch_evidence' | 'table_rows'; requiredPermissions: readonly string[]; fields: readonly SemanticField[];
  defaultMeasure: string; defaultDimensions: readonly string[]; defaultViews: Readonly<Record<string, readonly string[]>>;
  grain: readonly string[]; timezone: 'Asia/Bangkok';
  budgets: { maxRows: number; maxGroups: number; maxDays: number; maxTopN: number };
  /** Present exactly for `table_rows` datasets. */
  table?: TableBinding;
}
export interface SemanticDatasetCatalog {
  version: 1; datasets: readonly SemanticDataset[]; branches: readonly Branch[]; digest: string;
}

export function trustPolicy(trust: Trust, sensitivity: Sensitivity, uses: readonly string[]):
  { allowed: boolean; outcome?: 'unsupported_concept' | 'semantic_uncertainty'; label?: string } {
  if (trust === 'unknown') return { allowed: false, outcome: 'unsupported_concept' };
  if (trust === 'certified') return { allowed: true };
  const lowRisk = ['public_business', 'internal'].includes(sensitivity) && uses.length > 0 && uses.every(use => use === 'explore');
  if (!lowRisk) return { allowed: false, outcome: 'semantic_uncertainty' };
  return { allowed: true, label: trust === 'inferred' ? 'Inferred interpretation' : 'Unverified field interpretation' };
}

export function createSemanticCatalog(branches: readonly Branch[]): SemanticDatasetCatalog {
  if (new Set(branches.map(b => b.id)).size !== branches.length || branches.some(b => !b.id || !b.region)) {
    throw new Error('Canonical branch identities must be non-empty and unique.');
  }
  const dimension = (id: string, description: string, canonicalValues?: CanonicalValue[], displayLabel?: string): SemanticField => ({
    id, description, kind: 'dimension', trust: 'certified', sensitivity: 'internal',
    requiredPermissions: [], sourceSystems: [], aggregations: [], ...(displayLabel ? { displayLabel } : {}), ...(canonicalValues ? { canonicalValues } : {}) });
  const measure = (id: string, description: string, binding: keyof BranchMetric, sourceSystems: string[],
    unit: string, label: string, displayUnit: string, aggregations: string[], additivity: 'additive' | 'snapshot', targetFieldId?: string): SemanticField => ({
    id, description, labels: [id, label, description], displayLabel: label, displayUnit, binding, sourceSystems, unit, aggregations, additivity, ...(targetFieldId ? { targetFieldId } : {}),
    calculatorId: `branch_performance.${id}.v1`, kind: 'measure', trust: 'certified', sensitivity: 'internal',
    requiredPermissions: sourceSystems.some(s => ['inventory', 'incidents', 'staffing'].includes(s)) ? ['operations.read'] : ['sales.read'] });
  const dataset: SemanticDataset = {
    id: 'branch_performance', version: 1, label: 'ยอดขายและผลงานสาขา', description: 'Registered branch metrics at branch and business date grain.',
    trust: 'certified', sensitivity: 'internal', readerId: 'branch_evidence',
    // The existing reader requires both packs even for a single sales measure.
    requiredPermissions: ['sales.read', 'operations.read'], defaultMeasure: 'net_sales', defaultDimensions: ['branch'],
    defaultViews: { risk: ['gap', 'stock_issues', 'incident_count'] }, grain: ['branch', 'date'], timezone: 'Asia/Bangkok',
    budgets: { maxRows: 12_000, maxGroups: 2_000, maxDays: 62, maxTopN: 100 },
    fields: [
      dimension('branch', 'Exact registered branch identity.', branches.map(b => ({ id: b.id, label: b.name, description: b.name, region: b.region })), 'สาขา'),
      dimension('region', 'Canonical branch region.', unique(branches.map(b => b.region)).sort().map(id => ({
        id, label: id, labels: [id, ...(regionDefinitions.find(region => region.id === id)?.labels ?? [])], description: `Registered region ${id}`,
      })), 'ภูมิภาค'),
      dimension('date', 'ISO business date in the dataset timezone.', undefined, 'วันที่'),
      measure('net_sales', 'Paid sales, excluding cancelled and refunded orders.', 'netSales', ['sales'], 'THB', 'ยอดขายสุทธิ', 'บาท', ['sum'], 'additive', 'target'),
      measure('target', 'Approved daily sales target.', 'target', ['targets'], 'THB', 'เป้าหมาย', 'บาท', ['sum'], 'additive'),
      measure('gap', 'Net sales less target, calculated from the registered inputs.', 'gap', ['sales', 'targets'], 'THB', 'ส่วนต่างจากเป้า', 'บาท', ['gap'], 'additive'),
      measure('achievement', 'Total net sales divided by total positive target, times 100.', 'achievement', ['sales', 'targets'], 'percent', 'สัดส่วนยอดขายเทียบเป้า', '%', ['weighted_ratio'], 'additive'),
      measure('stock_issues', 'Inventory items below minimum at cutoff.', 'stockIssues', ['inventory'], 'items', 'สต็อกต่ำกว่าขั้นต่ำ', 'รายการ', ['sum', 'avg', 'latest', 'max'], 'snapshot'),
      measure('incident_count', 'Open incidents started by cutoff.', 'incidentCount', ['incidents'], 'incidents', 'Incident ที่ยังไม่ปิด', 'รายการ', ['sum', 'avg', 'latest', 'max'], 'snapshot'),
      measure('staffing_actual', 'Actual daily roster count.', 'staffingActual', ['staffing'], 'people', 'กำลังคนจริง', 'คน', ['sum', 'avg', 'latest', 'max'], 'snapshot'),
      measure('staffing_planned', 'Planned daily roster count.', 'staffingPlanned', ['staffing'], 'people', 'กำลังคนตามแผน', 'คน', ['sum', 'avg', 'latest', 'max'], 'snapshot'),
    ],
  };
  const contents = { version: 1 as const, datasets: [dataset, ...tableDatasets(branches)], branches: structuredClone(branches) };
  return freeze({ ...contents, digest: digest(contents) });
}
