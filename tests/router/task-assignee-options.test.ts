import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile } from '@/lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';

let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
beforeEach(async () => { fixture = await createWorkspaceFixture(); });
afterEach(async () => { await fixture.dispose(); });

describe('Workspace task assignee choices', () => {
  it('offers only people accepted by the server recipient policy, using human labels', async () => {
    const workspace = await fixture.service.getWorkspace(actors.executive);
    expect(workspace.taskAssigneeOptions).toEqual([{ id: 'east', label: 'East Manager (ผู้จัดการภาคตะวันออก)' }]);
    // The broader directory remains available for other product features.
    expect(workspace.profiles.map(profile => profile.id)).toContain('hr');
    await fixture.store.transaction(async tx => {
      const east = (await tx.get<Profile>('profiles', 'east'))!;
      await tx.put('profiles', { ...east, permissions: [] });
    });
    expect((await fixture.service.getWorkspace(actors.executive)).taskAssigneeOptions).toEqual([]);
  });

  it('returns no task assignee options for an actor without task permission', async () => {
    expect((await fixture.service.getWorkspace(actors.hr)).taskAssigneeOptions).toEqual([]);
  });
});
