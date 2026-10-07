const sourceNames: Record<string, string> = {
  sales: 'ยอดขายจริง',
  targets: 'เป้าหมายยอดขาย',
  inventory: 'สต็อกสินค้า',
  incidents: 'Incident',
  staffing: 'กำลังคน',
  hr: 'ข้อมูลฝ่ายบุคคล',
  employees: 'ข้อมูลพนักงาน',
  policies: 'นโยบายองค์กร',
  badges: 'สถานะบัตรพนักงาน',
  workflow: 'คำขอ Onboarding',
};

export function sourceDisplayName(system: string) {
  return sourceNames[system] ?? system;
}

/** Source descriptions are server text; hide record counts and English count words from business readers. */
export function sourceDetailText(detail: string) {
  return detail
    .split(' · ')
    .filter((part) => !/^\d+\s+(?:selected\s+)?records?$/i.test(part.trim()))
    .join(' · ')
    .trim();
}

/** Finite display map for the trusted Source freshness enum (values stay unchanged; `fresh` is not a real-time claim). */
export const freshnessText: Record<'fresh' | 'stale' | 'misaligned' | 'missing', string> = {
  fresh: 'ข้อมูลอยู่ในช่วงเวลาที่กำหนด',
  stale: 'ข้อมูลเก่ากว่าช่วงเวลาที่กำหนด',
  misaligned: 'เวลาของข้อมูลไม่สอดคล้องกัน',
  missing: 'ไม่พบข้อมูลจาก Source',
};
export const freshnessDisplay = (freshness: string) => (freshnessText as Record<string, string>)[freshness] ?? freshness;

/** Trusted evidence-warning producer format `${branch}: ${system} ${freshness}`: shown without the raw enum; any other warning is untouched. */
export function evidenceWarningText(warning: string) {
  const match = /^(.+): ([a-z_]+) (stale|misaligned|missing)$/.exec(warning);
  return match ? `${match[1]}: ${sourceDisplayName(match[2])} — ${freshnessText[match[3] as 'stale' | 'misaligned' | 'missing']}` : warning;
}
