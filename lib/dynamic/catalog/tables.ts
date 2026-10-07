import type { Branch } from '../../contracts';
import type { CanonicalValue, SemanticDataset, SemanticField } from './semantic';
import { regionDefinitions } from './seed';

/**
 * Registered table datasets (QUERY-001/002, DYNAMIC-SEMANTIC-001, EVIDENCE-002): one SemanticDataset per synthetic store table that
 * the demo data actually contains and that is not already covered by `branch_performance` (sales + targets + the daily
 * stock/incident/staffing roll-ups) or the certified HR directory. A field is either a stored column or a registered derivation
 * (lib/dynamic/table/derive.ts); nothing here is executable text. Joins list the ONLY legal join keys between two datasets.
 */
export const TABLE_READER_ID = 'table_rows' as const;
const MAX_ROWS = 20_000;
const budgets = (maxDays: number) => ({ maxRows: MAX_ROWS, maxGroups: 2_000, maxDays, maxTopN: 100 });
const unique = <T>(values: readonly T[]) => [...new Set(values)];

const regionValues = (branches: readonly Branch[]): CanonicalValue[] => unique(branches.map(b => b.region)).sort().map(id => ({
  id, label: id, labels: [id, ...(regionDefinitions.find(region => region.id === id)?.labels ?? [])], description: `Registered region ${id}`,
}));

interface FieldInput {
  id: string; description: string; label: string; system: string; permission: string; dataset: string;
  column?: string; derived?: string; valueType?: 'string' | 'number'; canonicalValues?: readonly CanonicalValue[];
}
const dimension = (input: FieldInput): SemanticField => ({
  id: input.id, description: input.description, kind: 'dimension', trust: 'certified', sensitivity: 'internal',
  requiredPermissions: [input.permission], sourceSystems: [input.system], aggregations: [], displayLabel: input.label,
  valueType: input.valueType ?? 'string', ...(input.column ? { column: input.column } : {}), ...(input.derived ? { derived: input.derived } : {}),
  ...(input.canonicalValues ? { canonicalValues: input.canonicalValues } : {}),
});
const measure = (input: FieldInput & { unit: string; displayUnit: string; aggregations: readonly string[]; additivity: 'additive' | 'snapshot' }): SemanticField => ({
  id: input.id, description: input.description, labels: [input.id, input.label, input.description], displayLabel: input.label,
  displayUnit: input.displayUnit, kind: 'measure', trust: 'certified', sensitivity: 'internal', requiredPermissions: [input.permission],
  sourceSystems: [input.system], unit: input.unit, aggregations: input.aggregations, additivity: input.additivity, valueType: 'number',
  calculatorId: `${input.dataset}.${input.id}.v1`, ...(input.column ? { column: input.column } : {}), ...(input.derived ? { derived: input.derived } : {}),
});

/** Table datasets for the given branch registry. Order is stable; the digest of the catalog covers all of it. */
export function tableDatasets(branches: readonly Branch[]): SemanticDataset[] {
  const branchValues: CanonicalValue[] = branches.map(b => ({ id: b.id, label: b.name, description: b.name, region: b.region }));
  const geo = (dataset: string, system: string, permission: string): SemanticField[] => [
    dimension({ id: 'branch', description: 'Exact registered branch identity.', label: 'สาขา', system, permission, dataset, column: 'branchId', canonicalValues: branchValues }),
    dimension({ id: 'region', description: 'Canonical branch region.', label: 'ภูมิภาค', system, permission, dataset, derived: 'region', canonicalValues: regionValues(branches) }),
  ];
  const ops = 'operations.read';

  const inventory: SemanticDataset = {
    id: 'inventory_items', version: 1, label: 'รายละเอียดสต็อกสินค้า', readerId: TABLE_READER_ID, trust: 'certified', sensitivity: 'internal', requiredPermissions: [ops],
    description: 'Item-level stock snapshots by branch, product and date (on-hand against the minimum, shortfall, low-stock items). One snapshot per date: dates are never summed together.',
    defaultMeasure: 'low_stock_items', defaultDimensions: ['branch'], defaultViews: { stock: ['low_stock_items', 'stock_shortfall'] },
    grain: ['branch', 'product', 'date'], timezone: 'Asia/Bangkok', budgets: budgets(31),
    table: { table: 'inventory_snapshots', sourceSystem: 'inventory', ownerPackId: 'operations', dateColumn: 'date', dateIsDerived: false, snapshot: true,
      branchColumn: 'branchId', observedColumn: 'observedAt', joins: [{ to: 'incident_log', keys: ['branch', 'date'] }, { to: 'support_tickets', keys: ['branch'] }] },
    fields: [
      ...geo('inventory_items', 'inventory', ops),
      dimension({ id: 'date', description: 'ISO business date of the snapshot.', label: 'วันที่', system: 'inventory', permission: ops, dataset: 'inventory_items', column: 'date' }),
      dimension({ id: 'product', description: 'Registered product id.', label: 'รหัสสินค้า', system: 'inventory', permission: ops, dataset: 'inventory_items', column: 'productId' }),
      dimension({ id: 'product_name', description: 'Registered product name (lookup over the product catalog).', label: 'สินค้า', system: 'inventory', permission: ops, dataset: 'inventory_items', derived: 'product_name' }),
      dimension({ id: 'category', description: 'Registered product category (lookup over the product catalog).', label: 'หมวดสินค้า', system: 'inventory', permission: ops, dataset: 'inventory_items', derived: 'product_category' }),
      measure({ id: 'on_hand', description: 'Units on hand at the snapshot.', label: 'จำนวนคงเหลือ', displayUnit: 'ชิ้น', unit: 'units', system: 'inventory', permission: ops, dataset: 'inventory_items', column: 'onHand', aggregations: ['sum', 'avg', 'min', 'max'], additivity: 'snapshot' }),
      measure({ id: 'stock_minimum', description: 'Minimum units required at the snapshot.', label: 'จำนวนขั้นต่ำ', displayUnit: 'ชิ้น', unit: 'units', system: 'inventory', permission: ops, dataset: 'inventory_items', column: 'minimum', aggregations: ['sum', 'avg', 'min', 'max'], additivity: 'snapshot' }),
      measure({ id: 'stock_shortfall', description: 'Units missing to reach the minimum (zero when at or above it).', label: 'จำนวนที่ขาดจากขั้นต่ำ', displayUnit: 'ชิ้น', unit: 'units', system: 'inventory', permission: ops, dataset: 'inventory_items', derived: 'stock_shortfall', aggregations: ['sum', 'avg', 'max'], additivity: 'snapshot' }),
      measure({ id: 'low_stock_items', description: 'Product rows whose on-hand is below the minimum.', label: 'รายการสต็อกต่ำกว่าขั้นต่ำ', displayUnit: 'รายการ', unit: 'items', system: 'inventory', permission: ops, dataset: 'inventory_items', derived: 'low_stock_flag', aggregations: ['sum'], additivity: 'snapshot' }),
      measure({ id: 'stock_rows', description: 'Number of product rows read.', label: 'จำนวนรายการสินค้า', displayUnit: 'รายการ', unit: 'items', system: 'inventory', permission: ops, dataset: 'inventory_items', derived: 'row_count', aggregations: ['count'], additivity: 'snapshot' }),
    ],
  };

  const incidents: SemanticDataset = {
    id: 'incident_log', version: 1, label: 'Incident หน้าร้าน', readerId: TABLE_READER_ID, trust: 'certified', sensitivity: 'internal', requiredPermissions: [ops],
    description: 'Individual branch incidents (kind, open/resolved status, duration) by branch and date.',
    defaultMeasure: 'incident_records', defaultDimensions: ['branch'], defaultViews: { open: ['incident_records'] },
    grain: ['incident'], timezone: 'Asia/Bangkok', budgets: budgets(62),
    table: { table: 'incidents', sourceSystem: 'incidents', ownerPackId: 'operations', dateColumn: 'date', dateIsDerived: false, snapshot: false,
      branchColumn: 'branchId', observedColumn: 'updatedAt', joins: [{ to: 'inventory_items', keys: ['branch', 'date'] }, { to: 'support_tickets', keys: ['branch'] }] },
    fields: [
      ...geo('incident_log', 'incidents', ops),
      dimension({ id: 'date', description: 'ISO business date the incident started.', label: 'วันที่', system: 'incidents', permission: ops, dataset: 'incident_log', column: 'date' }),
      dimension({ id: 'kind', description: 'Incident kind.', label: 'ประเภท Incident', system: 'incidents', permission: ops, dataset: 'incident_log', column: 'kind',
        canonicalValues: [{ id: 'payment', label: 'ชำระเงิน', description: 'Payment incident', labels: ['payment', 'ชำระเงิน'] },
          { id: 'stock', label: 'สต็อก', description: 'Stock incident', labels: ['stock', 'สต็อก'] },
          { id: 'operations', label: 'การปฏิบัติการ', description: 'Operations incident', labels: ['operations', 'การปฏิบัติการ'] }] }),
      dimension({ id: 'status', description: 'Incident status.', label: 'สถานะ', system: 'incidents', permission: ops, dataset: 'incident_log', column: 'status',
        canonicalValues: [{ id: 'open', label: 'ยังเปิดอยู่', description: 'Open', labels: ['open', 'ยังเปิดอยู่'] },
          { id: 'resolved', label: 'แก้ไขแล้ว', description: 'Resolved', labels: ['resolved', 'แก้ไขแล้ว'] }] }),
      dimension({ id: 'incident_title', description: 'Registered incident title.', label: 'หัวข้อ Incident', system: 'incidents', permission: ops, dataset: 'incident_log', column: 'title' }),
      measure({ id: 'incident_records', description: 'Number of incident records.', label: 'จำนวน Incident', displayUnit: 'รายการ', unit: 'incidents', system: 'incidents', permission: ops, dataset: 'incident_log', derived: 'row_count', aggregations: ['count'], additivity: 'additive' }),
      measure({ id: 'incident_hours', description: 'Hours between start and end of a resolved incident (open incidents are excluded).', label: 'ระยะเวลา Incident ที่แก้ไขแล้ว', displayUnit: 'ชั่วโมง', unit: 'hours', system: 'incidents', permission: ops, dataset: 'incident_log', derived: 'incident_hours', aggregations: ['sum', 'avg', 'max'], additivity: 'additive' }),
    ],
  };

  const tickets: SemanticDataset = {
    id: 'support_tickets', version: 1, label: 'Ticket ติดตามสาขา', readerId: TABLE_READER_ID, trust: 'certified', sensitivity: 'internal', requiredPermissions: [ops],
    description: 'Follow-up tickets opened for branches (status and creation date); assignee names are not exposed.',
    defaultMeasure: 'ticket_records', defaultDimensions: ['branch'], defaultViews: { open: ['ticket_records'] },
    grain: ['ticket'], timezone: 'Asia/Bangkok', budgets: budgets(62),
    table: { table: 'mock_tickets', sourceSystem: 'tickets', ownerPackId: 'operations', dateColumn: 'created_date', dateIsDerived: true, snapshot: false,
      branchColumn: 'branchId', observedColumn: 'createdAt', joins: [{ to: 'incident_log', keys: ['branch'] }, { to: 'inventory_items', keys: ['branch'] }] },
    fields: [
      ...geo('support_tickets', 'tickets', ops),
      dimension({ id: 'date', description: 'ISO business date the ticket was created.', label: 'วันที่สร้าง', system: 'tickets', permission: ops, dataset: 'support_tickets', derived: 'created_date' }),
      dimension({ id: 'ticket_status', description: 'Ticket status.', label: 'สถานะ Ticket', system: 'tickets', permission: ops, dataset: 'support_tickets', column: 'status',
        canonicalValues: [{ id: 'open', label: 'เปิดอยู่', description: 'Open', labels: ['open', 'เปิดอยู่'] }] }),
      dimension({ id: 'ticket_title', description: 'Registered ticket title.', label: 'หัวข้อ Ticket', system: 'tickets', permission: ops, dataset: 'support_tickets', column: 'title' }),
      measure({ id: 'ticket_records', description: 'Number of tickets.', label: 'จำนวน Ticket', displayUnit: 'รายการ', unit: 'tickets', system: 'tickets', permission: ops, dataset: 'support_tickets', derived: 'row_count', aggregations: ['count'], additivity: 'additive' }),
    ],
  };
  return [inventory, incidents, tickets];
}

/** Datasets that exist as registered table datasets (no branch registry needed): ids only. */
export const TABLE_DATASET_IDS: readonly string[] = ['inventory_items', 'incident_log', 'support_tickets'];
