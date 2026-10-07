export const groups: Record<string, string[]>;
export const seconds: Record<string, number>;
export function specName(path: string): string;
export function groupFor(path: string): string | undefined;
export const workflowV2Specs: string[];
export function specEnvironment(path: string): { WORKFLOW_V2_ENABLED: 'true' | 'false' };
