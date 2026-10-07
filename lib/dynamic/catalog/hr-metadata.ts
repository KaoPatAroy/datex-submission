/** Browser-safe HR catalog metadata shared with source presentation. */
export const HR_DATASET_METADATA = {
  id: 'hr_employees', version: 1, label: 'รายชื่อพนักงาน',
  suggestions: ['มีพนักงานที่ยังทำงานอยู่กี่คน', 'ค้นหาข้อมูลพนักงานด้วยรหัสพนักงาน'], readerId: 'hr_employee_snapshot', trust: 'certified', sensitivity: 'personal',
  owner: 'hr', requiredPermissions: ['hr.read'], grain: ['employee_id'],
  fields: ['employee_id', 'employee_name', 'branch', 'region', 'active', 'headcount', 'badge_id', 'badge_status', 'badge_type'],
  calculators: ['hr.active_headcount.v1'],
  budgets: { maxRows: 2000, maxGroups: 2000, maxTopN: 100, maxTimeMs: 1000 },
  description: 'Branch-scoped safe employee directory; headcount counts active employees. Badge id, status (active/revoked) and type are available for authorized employees in row lookups only (aggregation=rows). Leave and private fields are unavailable.',
} as const;
