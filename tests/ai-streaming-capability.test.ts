import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasNativeToolCapability, hasStreamingCapability, type ProbeCapabilityReport } from '../lib/ai/capabilities';

const FIXED_NOW = Date.parse('2026-10-04T00:00:00.000Z');
const BASE_URL = 'https://gateway.9arm.co/v1';
const MODEL = 'qwen3.8-27b-fp8';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type ReportOptions = {
  baseURL?: string;
  model?: string;
  generatedAt?: string;
  streaming?: ProbeCapabilityReport['checks']['streaming'];
  toolCalls?: ProbeCapabilityReport['checks']['toolCalls'];
};

function makeReport(options: ReportOptions = {}): ProbeCapabilityReport {
  return {
    schemaVersion: 1,
    baseURL: options.baseURL ?? BASE_URL,
    model: options.model ?? MODEL,
    generatedAt: options.generatedAt ?? new Date(FIXED_NOW).toISOString(),
    checks: {
      models: 'passed',
      nonStreaming: 'passed',
      streaming: options.streaming ?? 'passed',
      nativeToolsChoice: 'passed',
      toolCalls: options.toolCalls ?? 'passed',
      roleTool: 'passed',
      reasoningEffort: 'passed',
      usage: 'passed',
    },
    errorChecks: {
      timeout: 'not_observed',
      invalidKey: 'not_attempted',
      rateLimit: 'not_attempted',
    },
    requestCount: 4,
  };
}

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streaming provider capability', () => {
  it('accepts a passed probe for the exact normalized endpoint and model', () => {
    const serialized = serialize(makeReport());

    expect(hasStreamingCapability(`${BASE_URL}/`, MODEL, serialized)).toBe(true);
    expect(hasStreamingCapability(`${BASE_URL}/other`, MODEL, serialized)).toBe(false);
    expect(hasStreamingCapability(BASE_URL, 'another-model', serialized)).toBe(false);
  });

  it.each(['failed', 'unsupported', 'skipped'] as const)(
    'rejects streaming probe status %s',
    (streaming) => {
      expect(hasStreamingCapability(BASE_URL, MODEL, serialize(makeReport({ streaming })))).toBe(false);
    },
  );

  it('accepts a report at the seven-day freshness boundary', () => {
    const generatedAt = new Date(FIXED_NOW - SEVEN_DAYS_MS).toISOString();

    expect(hasStreamingCapability(BASE_URL, MODEL, serialize(makeReport({ generatedAt })))).toBe(true);
  });

  it('rejects future and older-than-seven-day reports', () => {
    const future = serialize(makeReport({ generatedAt: new Date(FIXED_NOW + 1).toISOString() }));
    const expired = serialize(makeReport({ generatedAt: new Date(FIXED_NOW - SEVEN_DAYS_MS - 1).toISOString() }));

    expect(hasStreamingCapability(BASE_URL, MODEL, future)).toBe(false);
    expect(hasStreamingCapability(BASE_URL, MODEL, expired)).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect(hasStreamingCapability(BASE_URL, MODEL, '{"schemaVersion":')).toBe(false);
  });

  it('rejects oversized but otherwise valid JSON reports', () => {
    const validJson = serialize(makeReport());
    const paddingLength = 8_193 - Buffer.byteLength(validJson, 'utf8');
    expect(paddingLength).toBeGreaterThan(0);
    const oversizedJson = `${validJson}${' '.repeat(paddingLength)}`;

    expect(Buffer.byteLength(oversizedJson, 'utf8')).toBe(8_193);
    expect(() => JSON.parse(oversizedJson)).not.toThrow();
    expect(hasStreamingCapability(BASE_URL, MODEL, oversizedJson)).toBe(false);
  });

  it('rejects reports outside the strict v1 schema', () => {
    const valid = makeReport();
    const versionTwo = serialize({ ...valid, schemaVersion: 2 });
    const unknownTopLevelField = serialize({ ...valid, extra: true });
    const unknownCheckField = serialize({ ...valid, checks: { ...valid.checks, extra: 'passed' } });

    expect(hasStreamingCapability(BASE_URL, MODEL, versionTwo)).toBe(false);
    expect(hasStreamingCapability(BASE_URL, MODEL, unknownTopLevelField)).toBe(false);
    expect(hasStreamingCapability(BASE_URL, MODEL, unknownCheckField)).toBe(false);
  });

  it('keeps native-tool eligibility independent of a skipped streaming probe', () => {
    const serialized = serialize(makeReport({ streaming: 'skipped' }));

    expect(hasNativeToolCapability(BASE_URL, MODEL, serialized)).toBe(true);
    expect(hasStreamingCapability(BASE_URL, MODEL, serialized)).toBe(false);
  });

  it('does not infer native-tool eligibility from a streaming pass', () => {
    const serialized = serialize(makeReport({ toolCalls: 'failed' }));

    expect(hasStreamingCapability(BASE_URL, MODEL, serialized)).toBe(true);
    expect(hasNativeToolCapability(BASE_URL, MODEL, serialized)).toBe(false);
  });
});
