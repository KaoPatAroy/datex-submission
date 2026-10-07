import { describe, expect, it } from 'vitest';
import { createSalesWorkflowBindings } from '../lib/packs/sales-workflows';
import type { DashboardShareSigningOptions } from '../lib/workflows/dashboard-access';
import { demoWorkflowPolicyV1 } from '../lib/workflows/policy';
import {
  createWorkflowActionRuntime,
  type WorkflowRuntimeBinding,
  type WorkflowRuntimeOptions,
} from '../lib/workflows/action-runtime';

const ACTIVE_KEY_VERSION = demoWorkflowPolicyV1.shareSigning.keyVersion;
const RETAINED_KEY_VERSION = ACTIVE_KEY_VERSION + 1;
const APPLICATION_ORIGIN = 'https://biztania.example';
const SECONDARY_SECRET = 'secondary-key-material-not-exposed-2026!';
const ACTIVE_SECRET_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CALLBACK_NAMES = [
  'identify', 'expectedPostconditions', 'validate', 'executeAtomic', 'verify', 'currentStates',
] as const;

function signingOptions(overrides: {
  applicationOrigin?: string;
  allowedKeyVersions?: readonly number[];
  activeKeyBytes?: Uint8Array;
} = {}): DashboardShareSigningOptions {
  return {
    applicationOrigin: overrides.applicationOrigin ?? APPLICATION_ORIGIN,
    sessionSigningSecrets: new Map<number, string | Uint8Array>([
      [ACTIVE_KEY_VERSION, Uint8Array.from(overrides.activeKeyBytes ?? ACTIVE_SECRET_BYTES)],
      [RETAINED_KEY_VERSION, SECONDARY_SECRET],
    ]),
    allowedKeyVersions: [...(overrides.allowedKeyVersions ?? [ACTIVE_KEY_VERSION])],
  };
}

function salesBindings(options: DashboardShareSigningOptions): WorkflowRuntimeBinding[] {
  return createSalesWorkflowBindings({ dashboardShareSigning: options });
}

function dashboardShareBinding(bindings: readonly WorkflowRuntimeBinding[]): WorkflowRuntimeBinding {
  const binding = bindings.find(candidate => candidate.kind === 'dashboard_share');
  if (!binding) throw new Error('Sales bindings did not include dashboard_share');
  return binding;
}

function callbackSources(binding: WorkflowRuntimeBinding): string[] {
  return CALLBACK_NAMES.map(name => Function.prototype.toString.call(binding[name]));
}

function salesPackPin(bindings: readonly WorkflowRuntimeBinding[]) {
  const store = {
    workflowContractVersion: 2,
    workflowTransaction: async () => {
      throw new Error('Configuration pin tests must not execute a workflow transaction');
    },
  } as unknown as WorkflowRuntimeOptions['store'];
  const contextFactory = (() => ({
    evidence: async () => { throw new Error('Configuration pin tests must not load evidence'); },
    latestDashboard: async () => { throw new Error('Configuration pin tests must not load dashboards'); },
  })) as unknown as WorkflowRuntimeOptions['contextFactory'];

  return createWorkflowActionRuntime({
    store,
    bindings,
    businessDate: '2026-10-03',
    getReleaseRevision: () => 'sales-config-pin-test-release-r1',
    getPackPins: packIds => packIds.map(id => ({
      id,
      version: '1.0',
      schemaDigest: 'a'.repeat(64),
      implementationRevision: 'sales-config-pin-test-base-r1',
    })),
    contextFactory,
  }).pins(['sales'])[0];
}

function serializedSecrets(activeKeyBytes: Uint8Array): string[] {
  const bytes = Buffer.from(activeKeyBytes);
  return [
    bytes.toString('utf8'),
    bytes.toString('hex'),
    bytes.toString('base64'),
    Array.from(activeKeyBytes).join(','),
    SECONDARY_SECRET,
  ];
}

function expectSecretsAbsent(value: string, activeKeyBytes: Uint8Array): void {
  for (const secret of serializedSecrets(activeKeyBytes)) {
    if (secret.length > 0) expect(value).not.toContain(secret);
  }
}

describe('Sales dashboard-share configuration pins', () => {
  it('changes opaque revisions and pack pins for origin, allowed-version, and active-key changes', () => {
    const baseBindings = salesBindings(signingOptions());
    const baseBinding = dashboardShareBinding(baseBindings);
    const basePin = salesPackPin(baseBindings);
    const baseRevision = baseBinding.configurationRevision;

    const variants = [
      salesBindings(signingOptions({ applicationOrigin: 'https://shares.biztania.example' })),
      salesBindings(signingOptions({ allowedKeyVersions: [ACTIVE_KEY_VERSION, RETAINED_KEY_VERSION] })),
      salesBindings(signingOptions({
        activeKeyBytes: Uint8Array.from(ACTIVE_SECRET_BYTES, (byte, index) => index === 0 ? byte ^ 0xff : byte),
      })),
    ];
    const variantBindings = variants.map(dashboardShareBinding);
    const revisions = [baseRevision, ...variantBindings.map(binding => binding.configurationRevision)];
    const pins = [basePin, ...variants.map(salesPackPin)];

    expect(revisions.every(revision => typeof revision === 'string' && /^sales-dashboard-share:v1:[a-f0-9]{64}$/.test(revision))).toBe(true);
    expect(new Set(revisions).size).toBe(4);
    expect(new Set(pins.map(pin => pin.implementationRevision)).size).toBe(4);

    for (const binding of variantBindings) {
      expect(callbackSources(binding)).toEqual(callbackSources(baseBinding));
    }
    for (const pin of pins) {
      expect(pin.implementationRevision).toMatch(/^workflow-v2:[a-f0-9]{64}$/);
      expectSecretsAbsent(JSON.stringify(pin), ACTIVE_SECRET_BYTES);
    }
    for (const revision of revisions) {
      expectSecretsAbsent(revision ?? '', ACTIVE_SECRET_BYTES);
    }
  });

  it('keeps the constructed revision and pin stable after caller-owned map, byte-array, list, and origin changes', () => {
    const activeKeyBytes = Uint8Array.from(ACTIVE_SECRET_BYTES);
    const secrets = new Map<number, string | Uint8Array>([
      [ACTIVE_KEY_VERSION, activeKeyBytes],
      [RETAINED_KEY_VERSION, SECONDARY_SECRET],
    ]);
    const allowedKeyVersions: number[] = [ACTIVE_KEY_VERSION];
    const options: DashboardShareSigningOptions = {
      applicationOrigin: APPLICATION_ORIGIN,
      sessionSigningSecrets: secrets,
      allowedKeyVersions,
    };
    const bindings = salesBindings(options);
    const binding = dashboardShareBinding(bindings);
    const revisionBeforeMutation = binding.configurationRevision;

    activeKeyBytes.fill(0);
    secrets.set(ACTIVE_KEY_VERSION, Uint8Array.from({ length: 32 }, () => 255));
    secrets.delete(RETAINED_KEY_VERSION);
    allowedKeyVersions.push(RETAINED_KEY_VERSION);
    options.applicationOrigin = 'https://mutated-after-construction.example';

    const copiedBindings = salesBindings(signingOptions());
    expect(binding.configurationRevision).toBe(revisionBeforeMutation);
    expect(binding.configurationRevision).toBe(dashboardShareBinding(copiedBindings).configurationRevision);
    expect(salesPackPin(bindings).implementationRevision).toBe(salesPackPin(copiedBindings).implementationRevision);
  });

  it('rejects an active signing key shorter than the 32-byte minimum before binding registration', () => {
    const shortOptions = signingOptions({ activeKeyBytes: ACTIVE_SECRET_BYTES.slice(0, 31) });

    expect(() => salesBindings(shortOptions)).toThrowError(expect.objectContaining({
      code: 'WORKFLOW_UNAVAILABLE',
      status: 503,
    }));
  });
});
