import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseRevision, localSourceRevision } from '../lib/core/release';

async function createTemporaryReleaseProject() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-release-identity-'));
  try {
    const lib = join(root, 'lib');
    const helper = join(lib, 'helper.ts');
    const extra = join(lib, 'extra.ts');
    await mkdir(lib);
    await writeFile(helper, 'export const revision = 1;\n', 'utf8');
    await writeFile(join(root, 'package-lock.json'), '{"name":"release-probe","lockfileVersion":3}\n', 'utf8');
    return {
      root,
      helper,
      extra,
      async dispose() {
        const tempRoot = resolve(tmpdir());
        const target = resolve(root);
        const relativePath = relative(tempRoot, target);
        if (relativePath === '' || relativePath === '..' || relativePath.startsWith('..' + sep)
          || relativePath.includes(sep) || !basename(target).startsWith('nexus-release-identity-')) {
          throw new Error('Refusing to remove a release fixture outside its generated temporary directory.');
        }
        await rm(target, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function captureReleaseError() {
  try {
    releaseRevision();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('release identity', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL', '0');
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is stable when unchanged and changes for helper edits, additions, and deletions', async () => {
    const project = await createTemporaryReleaseProject();
    try {
      const initial = localSourceRevision(project.root);
      expect(localSourceRevision(project.root)).toBe(initial);

      await writeFile(project.helper, 'export const revision = 2;\n', 'utf8');
      const edited = localSourceRevision(project.root);
      expect(edited).not.toBe(initial);

      await writeFile(project.extra, 'export const extra = true;\n', 'utf8');
      const added = localSourceRevision(project.root);
      expect(added).not.toBe(edited);

      await rm(project.helper);
      const helperDeleted = localSourceRevision(project.root);
      expect(helperDeleted).not.toBe(added);

      await writeFile(project.helper, 'export const revision = 1;\n', 'utf8');
      await rm(project.extra);
      expect(localSourceRevision(project.root)).toBe(initial);
    } finally {
      await project.dispose();
    }
  });

  it('uses only a valid Vercel Git SHA and rejects missing or invalid SHAs despite a manual override', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'manual-override');
    const fortyCharacterSha = 'A'.repeat(40);
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', fortyCharacterSha);
    expect(releaseRevision()).toBe('git:' + fortyCharacterSha.toLowerCase());

    const sixtyFourCharacterSha = 'B'.repeat(64);
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', sixtyFourCharacterSha);
    expect(releaseRevision()).toBe('git:' + sixtyFourCharacterSha.toLowerCase());

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'G'.repeat(40));
    expect(captureReleaseError()).toMatchObject({ code: 'CONFIGURATION', status: 503 });

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'Z'.repeat(64));
    expect(captureReleaseError()).toMatchObject({ code: 'CONFIGURATION', status: 503 });

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'C'.repeat(41));
    expect(captureReleaseError()).toMatchObject({ code: 'CONFIGURATION', status: 503 });

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'D'.repeat(63));
    expect(captureReleaseError()).toMatchObject({ code: 'CONFIGURATION', status: 503 });

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(captureReleaseError()).toMatchObject({ code: 'CONFIGURATION', status: 503 });

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'not-a-git-sha');
    expect(captureReleaseError()).toMatchObject({ code: 'CONFIGURATION', status: 503 });
  });

  it('changes local source identity when a confirm API route changes', async () => {
    const project = await createTemporaryReleaseProject();
    try {
      const confirmDirectory = join(project.root, 'app', 'api', 'confirm');
      const confirmRoute = join(confirmDirectory, 'route.ts');
      await mkdir(confirmDirectory, { recursive: true });
      await writeFile(confirmRoute, 'export const revision = "confirm-v1";\n', 'utf8');
      const initial = localSourceRevision(project.root);

      await writeFile(confirmRoute, 'export const revision = "confirm-v2";\n', 'utf8');

      expect(localSourceRevision(project.root)).not.toBe(initial);
    } finally {
      await project.dispose();
    }
  });
});
