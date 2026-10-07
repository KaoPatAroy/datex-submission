import { digest } from '../core/utils';

const SHARE_REVOKE_EVENT_ID_PURPOSE = 'dashboard-share-revoke-event/v1';
export const SHARE_REVOKE_EVENT_ID_REVISION = 'dashboard-share-revoke-event:v1';

export function dashboardShareRevokeEventIdV1(executionId: string, shareId: string): string {
  return 'share_revoke_event_' + digest({
    purpose: SHARE_REVOKE_EVENT_ID_PURPOSE,
    executionId,
    shareId
  });
}
