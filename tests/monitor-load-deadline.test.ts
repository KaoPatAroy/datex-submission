import { afterEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_LOAD_ERROR_COPY, requestMonitorPage } from '../components/biztania/monitor-data';

describe('Monitor list loading deadline', () => {
  afterEach(() => vi.useRealTimers());

  it('aborts an unresolved first-page request at its deadline', async () => {
    vi.useFakeTimers();
    let settled = false;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    void requestMonitorPage('/api/monitors', { fetcher, timeoutMs: 25 }).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(25);
    expect(settled).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('provides a clear retry message after the deadline', () => {
    expect(MONITOR_LOAD_ERROR_COPY).toContain('โหลดรายการ Monitor ไม่สำเร็จ');
    expect(MONITOR_LOAD_ERROR_COPY).toContain('กดโหลดใหม่');
  });
});
