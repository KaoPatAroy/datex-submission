'use client';

import { useParams } from 'next/navigation';
import NexusWorkspace from '@/components/nexus-workspace';

export default function DashboardPage() {
  const params = useParams<{ id: string }>();
  return <NexusWorkspace requestedDashboardId={params.id} />;
}
