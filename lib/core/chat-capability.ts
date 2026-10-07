import type { Workspace } from '../contracts';

/** Server-owned descriptor id of the AI Concierge chat capability (the UI reads `allowed`; it never parses permission names). */
export const CHAT_CAPABILITY_ID = 'concierge_chat';

type Capability = Workspace['capabilities'][number];

/** Adds the explicit chat capability when missing: allowed exactly when the actor may use at least one registered capability. */
export function withChatCapability(capabilities: Capability[]): Capability[] {
  if (capabilities.some(capability => capability.id === CHAT_CAPABILITY_ID)) return capabilities;
  return [...capabilities, { id: CHAT_CAPABILITY_ID, title: 'AI Concierge', allowed: capabilities.some(capability => capability.allowed), tools: [], templates: [] }];
}

export function canUseChat(workspace: Pick<Workspace, 'capabilities'>): boolean {
  return workspace.capabilities.some(capability => capability.id === CHAT_CAPABILITY_ID && capability.allowed);
}
