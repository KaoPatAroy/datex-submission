'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConversationListResult, ConversationView } from '@/lib/core/conversations';
import { Icon } from '@/components/icons';
import styles from './workspace.module.css';

type Mutation = { type: 'rename'; title: string } | { type: 'pin'; pinned: boolean } | { type: 'archive'; archived: boolean };
type Props = {
  request: <T>(path: string, init?: RequestInit, deadline?: number) => Promise<T>;
  csrfToken?: string; activeId: string | null; disabled: boolean; revision: string;
  onSelect: (id: string) => void; onNew: () => void; onArchived: (id: string) => void;
  onTitles: (titles: Record<string, string>) => void; footer: ReactNode;
};
export const conversationTitle = (title: string) => title === 'New conversation' ? 'บทสนทนาใหม่' : title;

export default function ConversationSidebar({ request, csrfToken, activeId, disabled, revision, onSelect, onNew, onArchived, onTitles, footer }: Props) {
  const [query, setQuery] = useState('');
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [rows, setRows] = useState<ConversationView[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  const load = useCallback(async (next?: string) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ includeArchived: 'true', limit: '25', q: query });
      if (next) params.set('cursor', next);
      const result = await request<ConversationListResult>(`/api/conversations?${params}`, {}, 15_000);
      if (!alive.current || current !== generation.current) return false;
      setRows(previous => next ? [...previous.filter(row => !result.conversations.some(item => item.id === row.id)), ...result.conversations] : result.conversations);
      setLoadedQuery(query);
      setCursor(result.pagination.hasMore ? result.pagination.nextCursor : undefined);
      onTitles(Object.fromEntries(result.conversations.map(row => [row.id, conversationTitle(row.title)])));
      setNeedsRefresh(false);
      return true;
    } catch {
      if (alive.current && current === generation.current) { setNeedsRefresh(true); setError('โหลดบทสนทนาไม่สำเร็จ ลองโหลดอีกครั้งก่อนจัดการรายการ'); }
      return false;
    } finally { if (alive.current && current === generation.current) setLoading(false); }
  }, [query, request, onTitles]);
  useEffect(() => {
    // Invalidate an older query immediately, before the new query's debounce.
    generation.current += 1;
    const timer = setTimeout(() => { setError(null); void load(); }, query ? 250 : 0);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, [load, revision, query]);

  const mutate = useCallback(async (row: ConversationView, mutation: Mutation) => {
    if (mutating || disabled || needsRefresh || !csrfToken) return;
    setMutating(row.id); setError(null);
    try {
      const result = await request<{ conversation: ConversationView }>(`/api/conversations/${encodeURIComponent(row.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ expectedVersion: row.rowVersion, mutation }) });
      if (!alive.current) return;
      setEditing(null);
      onTitles({ [row.id]: conversationTitle(result.conversation.title) });
      if (mutation.type === 'archive' && mutation.archived) onArchived(row.id);
      await load();
    } catch (failure) {
      if (!alive.current) return;
      setNeedsRefresh(true);
      const refreshed = await load();
      if (!alive.current) return;
      const stale = failure instanceof Error && 'code' in failure && failure.code === 'STALE_CONVERSATION';
      setError(stale && refreshed ? 'บทสนทนานี้เปลี่ยนจากอีกหน้าต่างแล้ว โหลดข้อมูลล่าสุดแล้ว โปรดตรวจรายการก่อนลองอีกครั้ง' : refreshed ? 'ยังยืนยันผลการเปลี่ยนแปลงไม่ได้ โหลดสถานะล่าสุดแล้ว โปรดตรวจรายการก่อนลองอีกครั้ง' : 'ยังยืนยันผลการเปลี่ยนแปลงไม่ได้ ต้องโหลดสถานะล่าสุดก่อนลองอีกครั้ง');
    } finally { if (alive.current) setMutating(null); }
  }, [mutating, disabled, needsRefresh, csrfToken, request, onTitles, onArchived, load]);

  const queryPending = query !== loadedQuery;
  const blocked = disabled || Boolean(mutating) || needsRefresh || loading || queryPending;
  function group(items: ConversationView[], label: string) {
    return <section aria-label={label} className={styles.conversationGroup}><h2>{label}</h2>{items.map(row => <div className={styles.conversationItem} key={row.id} data-conversation-id={row.id}>
      <button className={styles.sessionRow} type="button" aria-current={row.id === activeId ? 'page' : undefined} onClick={() => onSelect(row.id)} disabled={disabled || queryPending}><span className={styles.sessionRowTitle}>{conversationTitle(row.title)}</span>{row.updatedAt && <time dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</time>}</button>
      <details className={styles.conversationTools}><summary aria-label={`จัดการบทสนทนา ${conversationTitle(row.title)}`}><Icon name="more" /></summary><div>
        {editing === row.id ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) void mutate(row, { type: 'rename', title: title.trim() }); }}><label>ชื่อบทสนทนา<input autoFocus value={title} maxLength={120} onChange={event => setTitle(event.target.value)} disabled={blocked} /></label><button type="submit" disabled={blocked || !title.trim()}>บันทึกชื่อ</button><button type="button" onClick={() => setEditing(null)} disabled={Boolean(mutating)}>เลิกแก้ไข</button></form> : <button type="button" disabled={blocked} onClick={() => { setEditing(row.id); setTitle(conversationTitle(row.title)); }}>เปลี่ยนชื่อ</button>}
        <button type="button" disabled={blocked} onClick={() => void mutate(row, { type: 'pin', pinned: !row.pinned })}>{row.pinned ? 'เลิกปักหมุด' : 'ปักหมุด'}</button>
        <button type="button" disabled={blocked} onClick={() => void mutate(row, { type: 'archive', archived: !row.archived })}>{row.archived ? 'นำกลับมาใช้งาน' : 'เก็บเข้าคลัง'}</button>
      </div></details>
    </div>)}</section>;
  }
  const pinned = rows.filter(row => row.pinned && !row.archived);
  const active = rows.filter(row => !row.pinned && !row.archived);
  const archived = rows.filter(row => row.archived);
  return <aside className={styles.sessions} aria-label="บทสนทนา">
    <div className={styles.sessionTools}><button className="btn btn-primary" type="button" disabled={disabled} onClick={onNew}><Icon name="plus" />บทสนทนาใหม่</button><input type="search" aria-label="ค้นหาบทสนทนา" placeholder="ค้นหาบทสนทนา" maxLength={200} disabled={Boolean(mutating)} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className={styles.sessionList} aria-busy={loading || queryPending}>
      {error && <div role="alert" className={styles.conversationError}><p>{error}</p><button className="text-button" type="button" disabled={loading || Boolean(mutating)} onClick={() => { setError(null); void load(); }}>โหลดบทสนทนาอีกครั้ง</button></div>}
      {pinned.length > 0 && group(pinned, 'ปักหมุด')}{group(active, 'บทสนทนาล่าสุด')}
      {!rows.length && !loading && !error && <p className={styles.noSessions}>{query ? 'ไม่พบบทสนทนาที่ตรงกับคำค้น' : 'บทสนทนาที่บันทึกไว้จะปรากฏที่นี่'}</p>}
      {(loading || queryPending && !error) && <p role="status" className={styles.noSessions}>กำลังโหลดบทสนทนา…</p>}
      {archived.length > 0 && <details className={styles.archivedConversations} open={Boolean(query) || archived.some(row => row.id === activeId)}><summary>คลังบทสนทนา · {archived.length}</summary>{group(archived, 'เก็บเข้าคลังแล้ว')}</details>}
      {cursor && !queryPending && <button className="text-button" type="button" disabled={loading || Boolean(mutating)} onClick={() => void load(cursor)}>โหลดบทสนทนาเพิ่มเติม</button>}
    </div><div className={styles.sessionFooter}>{footer}</div>
  </aside>;
}
