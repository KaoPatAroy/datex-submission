import { Buffer } from 'node:buffer';
import { z } from 'zod';

export const DEFAULT_NINEARM_BASE_URL = 'https://gateway.9arm.co/v1';
export const DEFAULT_NINEARM_MODEL = 'qwen3.8-27b-fp8';

const probeStatus = z.enum(['passed', 'failed', 'unsupported', 'skipped']);
export const probeCapabilityReportSchema = z.object({
  schemaVersion: z.literal(1),
  baseURL: z.string().url(),
  model: z.string().min(1).max(120),
  generatedAt: z.string().datetime({ offset: true }),
  checks: z.object({
    models: probeStatus,
    nonStreaming: probeStatus,
    streaming: probeStatus,
    nativeToolsChoice: probeStatus,
    toolCalls: probeStatus,
    roleTool: probeStatus,
    reasoningEffort: probeStatus,
    usage: probeStatus
  }).strict(),
  errorChecks: z.object({
    timeout: z.enum(['observed', 'not_observed', 'not_tested']),
    invalidKey: z.enum(['observed', 'not_attempted']),
    rateLimit: z.enum(['observed', 'not_attempted'])
  }).strict(),
  requestCount: z.number().int().min(0).max(8),
  observedModel: z.string().max(120).optional()
}).strict();

export type ProbeCapabilityReport = z.infer<typeof probeCapabilityReportSchema>;

export function normalizeBaseURL(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid base URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('invalid base URL');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function isNativeToolRoundTripSupported(report: ProbeCapabilityReport): boolean {
  return report.checks.nonStreaming === 'passed'
    && report.checks.nativeToolsChoice === 'passed'
    && report.checks.toolCalls === 'passed'
    && report.checks.roleTool === 'passed';
}

export function hasNativeToolCapability(baseURL: string, model: string, serializedReport = process.env.NINEARM_CAPABILITIES_JSON): boolean {
  if (!serializedReport || Buffer.byteLength(serializedReport, 'utf8') > 8_192) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(serializedReport);
  } catch {
    return false;
  }
  const parsed = probeCapabilityReportSchema.safeParse(decoded);
  if (!parsed.success) return false;

  const report = parsed.data;
  if (report.baseURL !== baseURL || report.model !== model || !isNativeToolRoundTripSupported(report)) return false;
  const age = Date.now() - Date.parse(report.generatedAt);
  return age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
}

export function hasStreamingCapability(baseURL: string, model: string, serializedReport = process.env.NINEARM_CAPABILITIES_JSON): boolean {
  if (!serializedReport || Buffer.byteLength(serializedReport, 'utf8') > 8_192) return false;

  let configuredBaseURL: string;
  try {
    configuredBaseURL = normalizeBaseURL(baseURL);
  } catch {
    return false;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(serializedReport);
  } catch {
    return false;
  }
  const parsed = probeCapabilityReportSchema.safeParse(decoded);
  if (!parsed.success) return false;

  const report = parsed.data;
  if (report.baseURL !== configuredBaseURL || report.model !== model || report.checks.streaming !== 'passed') return false;
  const age = Date.now() - Date.parse(report.generatedAt);
  return age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
}
