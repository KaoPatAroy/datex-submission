import type { Badge, Reader, Ticket } from '../contracts';
export interface InboxRecord { id: string; recipientId: string; dashboardId: string; operationKey: string; createdAt: string }
export const MockTicketSystem = { read: (reader: Reader, id: string) => reader.get<Ticket>('mock_tickets',id) };
export const MockInboxSystem = { read: (reader: Reader, id: string) => reader.get<InboxRecord>('mock_messages',id) };
export const MockBadgeSystem = { read: (reader: Reader, id: string) => reader.get<Badge>('mock_badges',id) };
