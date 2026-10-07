import { digest } from '../core/utils';
import { defaultDemoWorkflowPolicy, instantSchema, isoDateSchema } from './contracts';
import type { ISODate, Instant, PolicyPin, VersionedDemoWorkflowPolicy } from './contracts';

const millisecondsPerDay = 86_400_000;
const millisecondsPerSecond = 1_000;

/** The single frozen synthetic policy used by V2 workflow preparation and execution. */
export const demoWorkflowPolicyV1 = defaultDemoWorkflowPolicy;
export type WorkflowTaskPriority = VersionedDemoWorkflowPolicy['tasks']['defaultPriority'];

/** Canonical SHA-256 over the policy's sorted-key serialization. */
export const demoWorkflowPolicyV1Digest = digest(demoWorkflowPolicyV1);

/** Immutable approval pin shared by snapshots, pending actions, and receipts. */
export const demoWorkflowPolicyV1Pin: PolicyPin = Object.freeze({
  id: demoWorkflowPolicyV1.id,
  version: demoWorkflowPolicyV1.version,
  digest: demoWorkflowPolicyV1Digest
});

export function getDemoWorkflowPolicyV1Pin(): PolicyPin {
  return demoWorkflowPolicyV1Pin;
}

const bangkokDateFormatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
  timeZone: demoWorkflowPolicyV1.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function validTimestamp(value: Date, label: string): number {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new RangeError(`${label} must be a valid instant`);
  return timestamp;
}

function utcMidnight(date: ISODate): number {
  const validated = isoDateSchema.parse(date);
  return new Date(`${validated}T00:00:00.000Z`).getTime();
}

/** Convert an instant to its ISO calendar date in the policy timezone. */
export function getBangkokCalendarDate(at: Date): ISODate {
  validTimestamp(at, 'Date input');

  const parts = new Map(bangkokDateFormatter.formatToParts(at).map(part => [part.type, part.value]));
  const year = parts.get('year')?.padStart(4, '0');
  const month = parts.get('month');
  const day = parts.get('day');
  if (!year || !month || !day) throw new RangeError('Could not derive the policy calendar date');

  return isoDateSchema.parse(`${year}-${month}-${day}`);
}

/** Completed-day evidence is eligible only for the configured, closed reporting date. */
export function isConfiguredClosedBusinessDate(date: ISODate, configuredDate: ISODate, at: Date): boolean {
  return isoDateSchema.parse(date) === isoDateSchema.parse(configuredDate)
    && date < getBangkokCalendarDate(at);
}

/** Add whole calendar days to a policy date without applying elapsed-time/DST rules. */
export function addBangkokCalendarDays(date: ISODate, days: number): ISODate {
  if (!Number.isSafeInteger(days)) throw new RangeError('Calendar-day offset must be a safe integer');

  const shifted = new Date(utcMidnight(date) + days * millisecondsPerDay);
  if (!Number.isFinite(shifted.getTime())) throw new RangeError('Calendar-day offset is outside the supported date range');
  return isoDateSchema.parse(shifted.toISOString().slice(0, 10));
}

/** Return endDate minus startDate as a signed count of ISO calendar days. */
export function bangkokCalendarDaysBetween(startDate: ISODate, endDate: ISODate): number {
  return (utcMidnight(endDate) - utcMidnight(startDate)) / millisecondsPerDay;
}

/** Compute a task due date using the reviewed priority offset from the local date. */
export function getTaskDueDate(
  at: Date,
  priority: WorkflowTaskPriority = demoWorkflowPolicyV1.tasks.defaultPriority
): ISODate {
  if (priority !== 'normal' && priority !== 'high') throw new RangeError('Unsupported task priority');

  const offsetDays = priority === 'high'
    ? demoWorkflowPolicyV1.tasks.highDueDays
    : demoWorkflowPolicyV1.tasks.normalDueDays;

  return addBangkokCalendarDays(getBangkokCalendarDate(at), offsetDays);
}

/** Missing activity evidence is ineligible; otherwise require the policy's full inactivity window. */
export function isCrmFollowupEligible(lastActivityDate: ISODate | null, at: Date): boolean {
  if (lastActivityDate === null) return false;

  const today = getBangkokCalendarDate(at);
  const daysSinceActivity = bangkokCalendarDaysBetween(lastActivityDate, today);
  return daysSinceActivity >= demoWorkflowPolicyV1.crmInactiveDays;
}

/** Expiry qualifies from the current Bangkok date through the policy day, inclusive. */
export function isContractReminderEligible(expiryDate: ISODate | null, at: Date): boolean {
  if (expiryDate === null) return false;

  const today = getBangkokCalendarDate(at);
  const daysUntilExpiry = bangkokCalendarDaysBetween(today, expiryDate);
  return daysUntilExpiry >= 0 && daysUntilExpiry <= demoWorkflowPolicyV1.contractReminderDays;
}

function expiresAfter(anchor: Date, seconds: number): Instant {
  const expiry = new Date(validTimestamp(anchor, 'Expiry anchor') + seconds * millisecondsPerSecond);
  if (!Number.isFinite(expiry.getTime())) throw new RangeError('Expiry is outside the supported instant range');
  return instantSchema.parse(expiry.toISOString());
}

/** Pending approvals expire ten minutes after preparation. */
export function pendingActionExpiresAt(createdAt: Date): Instant {
  return expiresAfter(createdAt, demoWorkflowPolicyV1.pendingTtlSeconds);
}

/** Shares expire exactly 24 hours after confirmation. */
export function dashboardShareExpiresAt(confirmedAt: Date): Instant {
  return expiresAfter(confirmedAt, demoWorkflowPolicyV1.shareTtlSeconds);
}
