'use client';

import { useEffect, useState } from 'react';
import type { FollowUpSuggestion, FollowUpSuggestions } from '@/lib/contracts';
import styles from './workspace.module.css';

function validItems(value: unknown, conversationId: string, afterMessageId: string): FollowUpSuggestion[] | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as Partial<FollowUpSuggestions>;
  if (response.status !== 'ready' || response.conversationId !== conversationId || response.afterMessageId !== afterMessageId || !Array.isArray(response.items) || response.items.length > 3) return null;
  const ids = new Set<string>();
  for (const item of response.items) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || ids.has(item.id) ||
      typeof item.label !== 'string' || !item.label.trim() || item.label.length > 180 ||
      typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 1200 ||
      !['read', 'analyze'].includes(item.consequence)) return null;
    ids.add(item.id);
  }
  return response.items;
}

export default function FollowUpPrompts({ conversationId, afterMessageId, onSelect }: {
  conversationId: string; afterMessageId: string; onSelect: (prompt: string) => void;
}) {
  const [result, setResult] = useState<{ status: 'loading' | 'ready' | 'none'; items: FollowUpSuggestion[] }>({ status: 'loading', items: [] });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 15_000);
    async function load() {
      try {
        const query = new URLSearchParams({ afterMessageId });
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/suggestions?${query}`, { credentials: 'include', cache: 'no-store', signal: controller.signal });
        const items = response.ok ? validItems(await response.json(), conversationId, afterMessageId) : null;
        if (active) setResult({ status: items?.length ? 'ready' : 'none', items: items ?? [] });
      } catch { if (active) setResult({ status: 'none', items: [] }); }
      finally { clearTimeout(timer); }
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [conversationId, afterMessageId]);
  return <div data-follow-up-anchor={afterMessageId} data-follow-up-status={result.status}>
    {result.status === 'ready' && <section className={styles.followUps} aria-label="ลองถามต่อ">
      <h3>ลองถามต่อ</h3><p>เลือกเพื่อเติมคำถาม แล้วกดส่งเมื่อพร้อม</p>
      <div>{result.items.map(item => <button key={item.id} type="button" data-suggestion-id={item.id} onClick={() => onSelect(item.prompt)}><span>{item.label}</span><small>{item.consequence === 'read' ? 'อ่านข้อมูล' : 'วิเคราะห์'}</small></button>)}</div>
    </section>}
  </div>;
}
