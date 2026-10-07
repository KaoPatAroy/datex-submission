'use client';

import { useCallback, useState } from 'react';

interface ShareRow { shareId: string; recipientId: string; recipientName: string; createdAt: string; revision?: number }
type State = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; shares: ShareRow[] };

const formatDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'medium' }); };

/**
 * Owner-visible share list with per-recipient revoke for one Dashboard or one Result. Each row is one EXACT grant: revoking it removes only that
 * recipient's access (idempotent and audited on the server); other recipients and other shared items are untouched. Loaded when the section is opened.
 */
export function ShareManager({ kind, id, onChanged }: { kind: 'dashboard' | 'result'; id: string; onChanged?: () => void }) {
  const base = `/api/${kind === 'dashboard' ? 'dashboards' : 'artifacts'}/${encodeURIComponent(id)}/shares`;
  const [state, setState] = useState<State>({ status: 'idle' });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch(base, { cache: 'no-store' });
      const body = response.ok ? await response.json() as { shares?: ShareRow[] } : null;
      setState(Array.isArray(body?.shares) ? { status: 'ready', shares: body.shares } : { status: 'error', message: 'โหลดรายการแชร์ไม่สำเร็จ' });
    } catch { setState({ status: 'error', message: 'โหลดรายการแชร์ไม่สำเร็จ' }); }
  }, [base]);

  const revoke = async (share: ShareRow) => {
    setBusy(true); setNotice(null);
    try {
      const session = await fetch('/api/session', { cache: 'no-store' });
      const csrf = session.ok ? (await session.json() as { csrfToken?: string }).csrfToken : undefined;
      if (!csrf) throw new Error('session');
      const response = await fetch(`${base}/${encodeURIComponent(share.shareId)}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}' });
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; setNotice(body?.error?.message ?? 'เพิกถอนการแชร์ไม่สำเร็จ โปรดลองอีกครั้ง'); return; }
      setNotice(`เพิกถอนการแชร์ให้ ${share.recipientName} แล้ว — ผู้รับเปิดไม่ได้อีก`);
      setConfirming(null);
      await load();
      onChanged?.();
    } catch { setNotice('เพิกถอนการแชร์ไม่สำเร็จ โปรดลองอีกครั้ง'); } finally { setBusy(false); }
  };

  return <details data-share-manager={kind} onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open && state.status === 'idle') void load(); }}>
    <summary>การแชร์{kind === 'dashboard' ? ' Dashboard นี้' : 'ผลลัพธ์นี้'} · เพิกถอนสิทธิ์ผู้รับ</summary>
    {state.status === 'loading' && <p role="status">กำลังโหลดรายการแชร์…</p>}
    {state.status === 'error' && <p role="alert">{state.message} <button type="button" className="btn btn-small" onClick={() => void load()}>ลองอีกครั้ง</button></p>}
    {state.status === 'ready' && !state.shares.length && <p data-share-empty>ตอนนี้ไม่มีผู้ได้รับแชร์</p>}
    {state.status === 'ready' && state.shares.length > 0 && <ul aria-label="ผู้ได้รับแชร์" style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {state.shares.map((share, position, all) => { const same = all.filter(other => other.recipientId === share.recipientId && other.revision === share.revision); const nth = same.indexOf(share) + 1; return <li key={share.shareId} data-share-id={share.shareId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ flex: 1, minWidth: 200 }}><strong>{share.recipientName}</strong>{share.revision ? ` · ฉบับที่ ${share.revision}` : ''}{same.length > 1 ? ` · การแชร์ครั้งที่ ${nth} จาก ${same.length}` : ''} · แชร์เมื่อ {formatDate(share.createdAt)}</span>
        {confirming === share.shareId
          ? <span role="alertdialog" aria-label={`เพิกถอนการแชร์ให้ ${share.recipientName}`}>เพิกถอนการแชร์ให้ {share.recipientName}? ผู้รับจะเปิดไม่ได้อีก{' '}
            <button type="button" className="btn btn-small btn-danger" data-share-revoke-confirm disabled={busy} onClick={() => void revoke(share)}>เพิกถอน</button>{' '}
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setConfirming(null)}>ไม่เพิกถอน</button></span>
          : <button type="button" className="btn btn-small" data-share-revoke disabled={busy} onClick={() => setConfirming(share.shareId)}>เพิกถอน</button>}
      </li>; })}
    </ul>}
    {notice && <p role="status" data-share-notice>{notice}</p>}
  </details>;
}
