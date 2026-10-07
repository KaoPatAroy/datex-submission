/**
 * Registered policy library access (POLICY-001). Policy documents carry no owner column, so the registry below is the server's
 * ONLY statement of who may read which document: a document id prefix maps to the permission that unlocks it. An id that matches
 * no registered prefix is unreadable (fail closed). Pure data; nothing here reads user text.
 */
export const POLICY_ACCESS: readonly { prefix: string; permission: string; ownerLabel: string }[] = Object.freeze([
  { prefix: 'POL-OPS-', permission: 'operations.read', ownerLabel: 'Operations' },
  { prefix: 'POL-HR-', permission: 'hr.read', ownerLabel: 'HR' },
]);
export function policyPermissionOf(policyId: string): string | null {
  return POLICY_ACCESS.find(entry => policyId.startsWith(entry.prefix))?.permission ?? null;
}
export const policySourceId = (policyId: string, version: string): string => `policy:${policyId}:${version}`;
export const canReadPolicy = (permissions: readonly string[], policyId: string): boolean => {
  const required = policyPermissionOf(policyId);
  return required !== null && permissions.includes(required);
};
