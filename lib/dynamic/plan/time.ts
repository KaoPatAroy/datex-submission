import { businessDateSchema } from '../../contracts';
import type { PlanTime } from './schemas';

export function shiftDate(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}
export function dateList(start: string, end: string, maxDays: number): string[] {
  if (!businessDateSchema.safeParse(start).success || !businessDateSchema.safeParse(end).success || start > end) throw new Error('Invalid date range.');
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > maxDays) throw new Error('Date budget exceeded.');
  return Array.from({ length: days }, (_, i) => shiftDate(start, i));
}
/** Canonical dates only. The model owns all language and relative-date interpretation. */
export function resolveTime(time: PlanTime | null, businessDate: string, maxDays: number): { time: PlanTime; dates: string[] } {
  const resolved: PlanTime = !time || time.source === 'default'
    ? { fieldId: time?.fieldId ?? 'date', timezone: time?.timezone ?? 'Asia/Bangkok', source: 'default', dates: [businessDate] }
    : time;
  const dates = [...resolved.dates];
  if (!dates.length || dates.length > maxDays) throw new Error('Date budget exceeded.');
  if (dates.some(date => !businessDateSchema.safeParse(date).success) || new Set(dates).size !== dates.length ||
    dates.some((date, i) => i > 0 && date <= dates[i - 1])) throw new Error('Invalid canonical dates.');
  return { time: resolved, dates };
}

export function baselineDates(dates: string[], compare: { kind: string; period: string | null }, maxDays: number): string[] {
  if (compare.kind === 'vs_target') return [];
  const last = shiftDate(dates[0], -1);
  const count = compare.kind === 'vs_prior_day' || compare.period === 'day' ? 1 : compare.period === 'week' ? 7 :
    new Date(`${dates[0]}T00:00:00Z`).getUTCDate() === 1 ? new Date(`${last}T00:00:00Z`).getUTCDate() : dates.length;
  return dateList(shiftDate(last, 1 - count), last, maxDays);
}
