#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_ONLY_ENV = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'NINEARM_API_KEY',
  'DEMO_SESSION_SECRET',
  'DEMO_ACCESS_CODE',
];

const LOCKFILES = new Set([
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const API_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const HIGH_SIGNAL_TOKEN_RES = [
  { pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g, rule: 'Supabase secret key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, rule: 'GitHub token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, rule: 'AWS access key ID' },
];
const GENERIC_SECRET_RE = /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*(["'])([^"'\r\n]{16,})\2/gi;
const ENV_ASSIGNMENT_RE = /\b(NINEARM_API_KEY|SUPABASE_SERVICE_ROLE_KEY|DEMO_SESSION_SECRET|DEMO_ACCESS_CODE)\b\s*[:=]\s*(["'])([^"'\r\n]*)\2/g;
const PEM_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const TEST_FIXTURE_MARKER_RE = /(?:^|[-_.])(?:test|fixture|fake|dummy|example|not-for|private-share|secret-which|property-secret)(?:$|[-_.])/i;

const findings = new Map();
const counts = {
  trackedListed: 0,
  trackedScanned: 0,
  trackedSkippedBinary: 0,
  trackedSkippedLockfile: 0,
  trackedReadErrors: 0,
  bundleFilesScanned: 0,
  bundleFilesSkippedBinary: 0,
  bundleReadErrors: 0,
};

function parseArgs(argv) {
  let bundleDir = '.next/static';
  let requireBundle = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bundle-dir') {
      if (!argv[i + 1]) throw new Error('Missing value for --bundle-dir');
      bundleDir = argv[++i];
    } else if (argv[i].startsWith('--bundle-dir=')) {
      bundleDir = argv[i].slice('--bundle-dir='.length);
    } else if (argv[i] === '--require-bundle') {
      requireBundle = true;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return { bundleDir, requireBundle };
}

function addFinding(file, line, rule) {
  const key = `${file}\0${line}\0${rule}`;
  if (!findings.has(key)) findings.set(key, { file, line, rule });
}

function isBinary(buffer) {
  return buffer.includes(0);
}

// Supabase CLI config substitution (secret = "env(NAME)") is a reference to an env var, not a value, but ONLY in the CLI config file;
// an env(...)-shaped literal anywhere else is scanned like any other value.
const SUPABASE_CLI_CONFIG = 'supabase/config.toml';

function isPlaceholder(value, file) {
  const normalized = value.trim().toLowerCase();
  return normalized === ''
    || /^(?:example(?:[-_ ].*)?|changeme(?:[-_ ].*)?|x{3,}|<[^>]*>)$/.test(normalized)
    || (file.replaceAll('\\', '/') === SUPABASE_CLI_CONFIG && /^env\([a-z_][a-z0-9_]*\)$/.test(normalized));
}

function isTestPath(file) {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  return /(^|\/)(?:tests?|__tests__)(\/|$)/.test(normalized)
    || /(^|\/)playwright\.config\.[^/]+$/.test(normalized);
}

function allowedFixture(file, rule, value, lineText) {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  // Local E2E fixture access code (playwright.config.ts, docs); never a hosted credential.
  if (value === 'nexus-test-access') return true;
  // Documented local-only validation values (docs/USER_VALIDATION.md) are namespaced nexus-local-*.
  if (normalized.startsWith('docs/') && /^nexus-local-[a-z0-9-]+$/i.test(value)) return true;
  if (!isTestPath(file)) return false;
  if (rule.startsWith('generic ')
    && /(^|\/)tests\//.test(normalized)
    && TEST_FIXTURE_MARKER_RE.test(value)) return true;
  if (rule === 'DEMO_SESSION_SECRET') {
    return /(?:test|fixture|playwright|e2e)/i.test(value)
      && (normalized.includes('/tests/') || normalized.includes('/__tests__/')
        || /playwright\.config\.[^/]+$/i.test(normalized))
      && /DEMO_SESSION_SECRET/i.test(lineText);
  }
  return false;
}

function decodeJwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role' || payload.role === 'service-role';
  } catch {
    return false;
  }
}

function inspectTrackedLine(file, lineNumber, lineText) {
  let match;
  for (const { pattern, rule } of HIGH_SIGNAL_TOKEN_RES) {
    while ((match = pattern.exec(lineText)) !== null) addFinding(file, lineNumber, rule);
    pattern.lastIndex = 0;
  }

  while ((match = JWT_RE.exec(lineText)) !== null) {
    const serviceRole = decodeJwtRole(match[0])
      || (/SUPABASE_SERVICE_ROLE_KEY/i.test(lineText));
    addFinding(file, lineNumber, serviceRole ? 'Supabase service_role JWT' : 'JWT-like token');
  }
  JWT_RE.lastIndex = 0;

  while ((match = API_TOKEN_RE.exec(lineText)) !== null) {
    addFinding(file, lineNumber, 'sk- API token');
  }
  API_TOKEN_RE.lastIndex = 0;

  if (PEM_RE.test(lineText)) addFinding(file, lineNumber, 'PEM private key');

  while ((match = GENERIC_SECRET_RE.exec(lineText)) !== null) {
    const value = match[3];
    const fixtureRule = /\bDEMO_SESSION_SECRET\b/i.test(lineText)
      ? 'DEMO_SESSION_SECRET'
      : `generic ${match[1].toLowerCase()}`;
    if (!isPlaceholder(value, file) && !allowedFixture(file, fixtureRule, value, lineText)) {
      addFinding(file, lineNumber, `generic ${match[1].toLowerCase()} assignment`);
    }
  }
  GENERIC_SECRET_RE.lastIndex = 0;

  while ((match = ENV_ASSIGNMENT_RE.exec(lineText)) !== null) {
    const envName = match[1];
    const value = match[3];
    if (!isPlaceholder(value, file) && !allowedFixture(file, envName, value, lineText)) {
      const rule = envName === 'SUPABASE_SERVICE_ROLE_KEY' && /\beyJ[A-Za-z0-9_-]+\.eyJ/i.test(value)
        ? 'Supabase service_role JWT'
        : `non-placeholder ${envName} assignment`;
      addFinding(file, lineNumber, rule);
    }
  }
  ENV_ASSIGNMENT_RE.lastIndex = 0;
}

function scanTrackedSources() {
  const listed = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  counts.trackedListed = listed.length;

  for (const relativePath of listed) {
    const baseName = path.posix.basename(relativePath.replaceAll('\\', '/')).toLowerCase();
    if (LOCKFILES.has(baseName)) {
      counts.trackedSkippedLockfile += 1;
      continue;
    }

    let buffer;
    try {
      buffer = readFileSync(path.resolve(relativePath));
    } catch {
      counts.trackedReadErrors += 1;
      addFinding(relativePath, 1, 'source scan read error');
      continue;
    }

    if (isBinary(buffer)) {
      counts.trackedSkippedBinary += 1;
      continue;
    }
    counts.trackedScanned += 1;
    const source = buffer.toString('utf8');
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      inspectTrackedLine(relativePath, index + 1, lines[index]);
    }
  }
}

function parseEnvLocal() {
  const values = new Map();
  try {
    const source = readFileSync(path.resolve('.env.local'), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (SERVER_ONLY_ENV.includes(match[1])) values.set(match[1], value);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return values;
}

function walkJsFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

function scanBundles(bundleDir, requireBundle) {
  let rootStat;
  try {
    rootStat = statSync(bundleDir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      if (requireBundle) addFinding(bundleDir, 1, 'required bundle directory missing');
      else console.log(`Bundle scan skipped: directory not found (${bundleDir}).`);
      return;
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    if (requireBundle) addFinding(bundleDir, 1, 'required bundle path is not a directory');
    else console.log(`Bundle scan skipped: not a directory (${bundleDir}).`);
    return;
  }

  const envValues = parseEnvLocal();
  for (const name of SERVER_ONLY_ENV) {
    if (process.env[name]) envValues.set(name, process.env[name]);
  }

  const files = walkJsFiles(bundleDir);
  for (const fullPath of files) {
    const relative = path.relative(process.cwd(), fullPath).replaceAll('\\', '/');
    let buffer;
    try {
      buffer = readFileSync(fullPath);
    } catch {
      counts.bundleReadErrors += 1;
      addFinding(relative, 1, 'bundle scan read error');
      continue;
    }
    if (isBinary(buffer)) {
      counts.bundleFilesSkippedBinary += 1;
      continue;
    }
    counts.bundleFilesScanned += 1;
    const sourceLines = buffer.toString('utf8').split(/\r?\n/);

    for (let index = 0; index < sourceLines.length; index += 1) {
      const line = sourceLines[index];
      for (const name of SERVER_ONLY_ENV) {
        if (line.includes(name)) addFinding(relative, index + 1, `client bundle server-only env name (${name})`);
      }
      for (const [name, value] of envValues) {
        if (value && line.includes(value)) addFinding(relative, index + 1, `client bundle secret value (${name})`);
      }
    }
  }
  if (requireBundle && counts.bundleFilesScanned === 0) {
    addFinding(bundleDir, 1, 'required bundle contains no JavaScript files scanned');
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    scanTrackedSources();
    scanBundles(options.bundleDir, options.requireBundle);
  } catch (error) {
    console.error(`Release scan failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (const finding of findings.values()) {
    console.log(`${finding.file}:${finding.line} - ${finding.rule} [value masked]`);
  }

  console.log(`Tracked source: ${counts.trackedScanned}/${counts.trackedListed} scanned; ${counts.trackedSkippedBinary} binary and ${counts.trackedSkippedLockfile} lockfiles skipped; ${counts.trackedReadErrors} read errors.`);
  console.log(`Client bundle: ${counts.bundleFilesScanned} JavaScript files scanned; ${counts.bundleFilesSkippedBinary} binary skipped; ${counts.bundleReadErrors} read errors.`);
  console.log(`Release scan: ${findings.size} finding(s).`);
  process.exitCode = findings.size === 0 ? 0 : 1;
}

/** Test seam: the finding rules one tracked-source line produces (the shared findings map is left empty). */
export function trackedLineFindings(file, lineText) {
  findings.clear();
  inspectTrackedLine(file, 1, lineText);
  const rules = [...findings.values()].map(finding => finding.rule);
  findings.clear();
  return rules;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
