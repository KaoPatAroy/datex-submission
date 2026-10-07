import { createElement } from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ArtifactPreview } from '@/components/biztania/artifact-preview';
import { StagedProposalDialog } from '@/components/biztania/router-panels';
import type { ArtifactRendererSpec } from '@/lib/visualization/contracts';

// Vitest resolves the server React condition; client markup needs the regular React build.
const { require } = vi.hoisted(() => ({ require: process.getBuiltinModule('node:module').createRequire(`${process.cwd()}/tests/pf6-thai-scope.test.ts`) }));
vi.mock('react', () => {
  const React = require(`${process.cwd()}/node_modules/react/cjs/react.development.js`);
  return { ...React, default: React };
});
const Module = require('node:module').Module;
const overridden: { path: string; entry?: NodeJS.Module }[] = [];
for (const name of ['react', 'react-dom']) {
  const path = require.resolve(name), previous = require.cache[path], entry = previous ?? new Module(path);
  entry.filename = path; entry.loaded = true;
  entry.exports = require(`${process.cwd()}/node_modules/${name}/index.js`);
  require.cache[path] = entry;
  overridden.push({ path, entry: previous });
}
const { renderToStaticMarkup } = require(`${process.cwd()}/node_modules/react-dom/server.node.js`) as typeof import('react-dom/server');
afterAll(() => { for (const { path, entry } of overridden) { if (entry) require.cache[path] = entry; else delete require.cache[path]; } });

const spec: ArtifactRendererSpec = {
  version: 1, artifact: { id: 'artifact', version: 1, digest: 'digest' }, kind: 'table', title: 'ผลงานสาขา',
  scope: { regions: ['central', 'east', 'south'], branchIds: ['C01', 'E01', 'S01'], dates: ['2026-10-07'] },
  query: { id: 'query', version: 1, digest: 'digest' }, evidence: { id: 'evidence', version: 1, digest: 'digest' },
  claimGraphDigest: 'digest', grain: [], facts: [], limitations: [], interpretationLabels: [],
  coverage: { expected: 0, read: 0, complete: true }, ranking: null, sources: [], visualization: null, csv: null,
  labels: { fields: {}, units: {}, values: { region: { central: 'central', east: 'east', south: 'south' },
    branch: { C01: 'Demo Central Branch 1', E01: 'Demo East Branch 1', S01: 'Demo South Branch 1' } } },
};

describe('Thai answer and confirmation markup', () => {
  it('renders canonical scope keys with Thai catalog labels and display branch names', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, { spec }));
    expect(html).toContain('ภูมิภาค: ภาคกลาง, ภาคตะวันออก, ภาคใต้');
    expect(html).toContain('สาขา: สาขากลาง 1, สาขาตะวันออก 1, สาขาใต้ 1');
    expect(html).not.toMatch(/central|east|south|Demo .* Branch|C01|E01|S01/);
  });

  it('preserves catalog display labels for named branches and uses Thai for missing branch labels', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, { spec: { ...spec, scope: { ...spec.scope, branchIds: ['E01', 'missing-key'] }, labels: { fields: {}, units: {}, values: { branch: { E01: 'สาขาบางแสน' } } } } }));
    expect(html).toContain('สาขา: สาขาบางแสน, สาขาที่เลือก');
    expect(html).not.toContain('missing-key');
  });

  it.each([{ recipients: [] }, { recipients: ['ผู้จัดการภาคตะวันออก'] }])('renders Monitor confirmation recipients without an empty row: $recipients', ({ recipients }) => {
    const html = renderToStaticMarkup(createElement(StagedProposalDialog, {
      proposal: { id: 'proposal', actionId: 'monitor.create', status: 'pending', conversationId: 'conversation', turnId: 'turn', createdAt: 1, expiresAt: 2000,
        preview: 'ติดตามยอดขาย', details: { recipientIds: recipients }, confirmable: true }, busy: null, onConfirm: () => {}, onCancel: () => {}, onClose: () => {},
    }));
    if (recipients.length) expect(html).toContain('<dt>ผู้รับ</dt><dd>ผู้จัดการภาคตะวันออก</dd>');
    else expect(html).not.toContain('<dt>ผู้รับ</dt>');
  });
});
