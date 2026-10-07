import { describe, expect, it } from 'vitest';
import { digest } from '../lib/core/utils';
import { defaultDemoWorkflowPolicy, policyPinSchema } from '../lib/workflows/contracts';
import {
  addBangkokCalendarDays,
  bangkokCalendarDaysBetween,
  dashboardShareExpiresAt,
  demoWorkflowPolicyV1,
  demoWorkflowPolicyV1Digest,
  demoWorkflowPolicyV1Pin,
  getBangkokCalendarDate,
  getDemoWorkflowPolicyV1Pin,
  getTaskDueDate,
  isContractReminderEligible,
  isConfiguredClosedBusinessDate,
  isCrmFollowupEligible,
  pendingActionExpiresAt,
} from '../lib/workflows/policy';

describe('Workflow V2 policy calendar dates', () => {
  it('uses Bangkok local dates when an instant crosses UTC midnight', () => {
    expect(getBangkokCalendarDate(new Date('2026-10-01T16:59:59.999Z'))).toBe('2026-10-01');
    expect(getBangkokCalendarDate(new Date('2026-10-01T17:00:00.000Z'))).toBe('2026-10-02');
  });

  it('accepts only the configured business date after the Bangkok day closes', () => {
    const oneMillisecondBeforeMidnight = new Date('2026-10-04T16:59:59.999Z');
    const bangkokMidnight = new Date('2026-10-04T17:00:00.000Z');
    expect(getBangkokCalendarDate(oneMillisecondBeforeMidnight)).toBe('2026-10-04');
    expect(getBangkokCalendarDate(bangkokMidnight)).toBe('2026-10-05');

    expect(isConfiguredClosedBusinessDate('2026-10-03', '2026-10-03', oneMillisecondBeforeMidnight)).toBe(true);
    expect(isConfiguredClosedBusinessDate('2026-10-04', '2026-10-04', oneMillisecondBeforeMidnight)).toBe(false);
    expect(isConfiguredClosedBusinessDate('2026-10-04', '2026-10-04', bangkokMidnight)).toBe(true);
    expect(isConfiguredClosedBusinessDate('2026-10-05', '2026-10-05', bangkokMidnight)).toBe(false);
    expect(isConfiguredClosedBusinessDate('2026-10-06', '2026-10-06', bangkokMidnight)).toBe(false);
    expect(isConfiguredClosedBusinessDate('2026-10-04', '2026-10-03', bangkokMidnight)).toBe(false);

    expect(Date.parse(pendingActionExpiresAt(bangkokMidnight)) - bangkokMidnight.getTime()).toBe(600_000);
    expect(Date.parse(dashboardShareExpiresAt(bangkokMidnight)) - bangkokMidnight.getTime()).toBe(86_400_000);
  });

  it('rejects an invalid instant when checking configured closed dates', () => {
    expect(() => isConfiguredClosedBusinessDate(
      '2026-10-04',
      '2026-10-04',
      new Date(Number.NaN),
    )).toThrow(RangeError);
  });

  it('adds calendar days across leap day and month boundaries', () => {
    expect(addBangkokCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addBangkokCalendarDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addBangkokCalendarDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(bangkokCalendarDaysBetween('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('applies normal and high task due dates as calendar-day offsets', () => {
    const leapDayMidnightBangkok = new Date('2024-02-28T17:00:00.000Z');
    expect(getBangkokCalendarDate(leapDayMidnightBangkok)).toBe('2024-02-29');
    expect(getTaskDueDate(leapDayMidnightBangkok)).toBe('2024-03-03');
    expect(getTaskDueDate(leapDayMidnightBangkok, 'normal')).toBe('2024-03-03');
    expect(getTaskDueDate(leapDayMidnightBangkok, 'high')).toBe('2024-03-01');

    const monthEndBangkok = new Date('2026-03-30T17:00:00.000Z');
    expect(getTaskDueDate(monthEndBangkok, 'normal')).toBe('2026-04-03');
    expect(getTaskDueDate(monthEndBangkok, 'high')).toBe('2026-04-01');
  });
});

describe('Workflow V2 policy eligibility windows', () => {
  it('includes CRM follow-ups at 14 local calendar days and excludes newer or missing activity dates', () => {
    const afterBangkokMidnight = new Date('2026-03-14T17:00:00.000Z');
    expect(getBangkokCalendarDate(afterBangkokMidnight)).toBe('2026-03-15');
    expect(isCrmFollowupEligible('2026-03-01', afterBangkokMidnight)).toBe(true);
    expect(isCrmFollowupEligible('2026-03-02', afterBangkokMidnight)).toBe(false);
    expect(isCrmFollowupEligible(null, afterBangkokMidnight)).toBe(false);
    expect(isCrmFollowupEligible('2026-03-16', afterBangkokMidnight)).toBe(false);
  });

  it('includes contract expiry today through day 30, and excludes expired or day 31 contracts', () => {
    const localMarchFifteenth = new Date('2026-03-14T17:00:00.000Z');
    expect(isContractReminderEligible('2026-03-14', localMarchFifteenth)).toBe(false);
    expect(isContractReminderEligible('2026-03-15', localMarchFifteenth)).toBe(true);
    expect(isContractReminderEligible('2026-04-14', localMarchFifteenth)).toBe(true);
    expect(isContractReminderEligible('2026-04-15', localMarchFifteenth)).toBe(false);
    expect(isContractReminderEligible(null, localMarchFifteenth)).toBe(false);

    const localLeapDay = new Date('2024-02-28T17:00:00.000Z');
    expect(isContractReminderEligible('2024-03-01', localLeapDay)).toBe(true);
  });

  it('derives pending and share TTLs from the versioned policy in seconds', () => {
    const createdAt = new Date('2026-10-01T05:23:45.000Z');
    const pendingExpiry = pendingActionExpiresAt(createdAt);
    const shareExpiry = dashboardShareExpiresAt(createdAt);

    expect(Date.parse(pendingExpiry) - createdAt.getTime()).toBe(600_000);
    expect(Date.parse(shareExpiry) - createdAt.getTime()).toBe(86_400_000);
  });
});

describe('Workflow V2 versioned policy identity and immutability', () => {
  it('reuses the single version 1 policy and derives a deterministic pin from its canonical digest', () => {
    expect(demoWorkflowPolicyV1).toBe(defaultDemoWorkflowPolicy);
    expect(demoWorkflowPolicyV1.id).toBe('demo-workflow');
    expect(demoWorkflowPolicyV1.version).toBe(1);
    expect(demoWorkflowPolicyV1.timezone).toBe('Asia/Bangkok');
    expect(demoWorkflowPolicyV1Digest).toBe(digest(demoWorkflowPolicyV1));
    expect(demoWorkflowPolicyV1Pin).toEqual({
      id: 'demo-workflow',
      version: 1,
      digest: demoWorkflowPolicyV1Digest,
    });
    expect(getDemoWorkflowPolicyV1Pin()).toEqual(demoWorkflowPolicyV1Pin);
    expect(getDemoWorkflowPolicyV1Pin()).toEqual(getDemoWorkflowPolicyV1Pin());
    expect(policyPinSchema.parse(demoWorkflowPolicyV1Pin)).toEqual(demoWorkflowPolicyV1Pin);

    const changedPolicy = {
      ...demoWorkflowPolicyV1,
      tasks: { ...demoWorkflowPolicyV1.tasks, normalDueDays: 4 },
    };
    expect(digest(changedPolicy)).not.toBe(demoWorkflowPolicyV1Pin.digest);
  });

  it('rejects runtime mutation of the shared policy, nested settings, arrays, and policy pin', () => {
    expect(Object.isFrozen(demoWorkflowPolicyV1)).toBe(true);
    expect(Object.isFrozen(demoWorkflowPolicyV1.tasks)).toBe(true);
    expect(Object.isFrozen(demoWorkflowPolicyV1.requiredOnboardingDocuments)).toBe(true);
    expect(Object.isFrozen(demoWorkflowPolicyV1Pin)).toBe(true);

    expect(Reflect.set(demoWorkflowPolicyV1.tasks, 'normalDueDays', 4)).toBe(false);
    expect(Reflect.set(demoWorkflowPolicyV1.requiredOnboardingDocuments, '0', 'withdrawn')).toBe(false);
    expect(Reflect.set(demoWorkflowPolicyV1Pin, 'version', 2)).toBe(false);
    expect(demoWorkflowPolicyV1.tasks.normalDueDays).toBe(3);
    expect(demoWorkflowPolicyV1.requiredOnboardingDocuments[0]).toBe('identity_document');
    expect(demoWorkflowPolicyV1Pin.version).toBe(1);
  });
});
