export interface MonitorPage<TMonitor = unknown> { monitors: TMonitor[]; total: number; nextCursor: string | null }
export const MONITOR_LOAD_ERROR_COPY = 'โหลดรายการ Monitor ไม่สำเร็จ กด “ลองอีกครั้ง” เพื่อตรวจสถานะล่าสุด';
export const MONITOR_AFTER_MUTATION_LOAD_ERROR_COPY = 'โหลดสถานะล่าสุดไม่สำเร็จ — การเปลี่ยนแปลงล่าสุดอาจบันทึกแล้ว โปรดตรวจสอบก่อนทำซ้ำ แล้วลองอีกครั้ง';

export async function requestMonitorPage<TMonitor = unknown>(url: string, options: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MonitorPage<TMonitor> | null> {
  const controller = new AbortController();
  const abortForCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortForCaller, { once: true });
  if (options.signal?.aborted) abortForCaller();
  const timer = setTimeout(() => controller.abort(new DOMException('Monitor request timed out', 'TimeoutError')), options.timeoutMs ?? 12_000);
  try {
    const response = await (options.fetcher ?? fetch)(url, { cache: 'no-store', signal: controller.signal });
    const body = response.ok ? await response.json() as { monitors?: unknown[]; total?: number; nextCursor?: string | null } : null;
    return Array.isArray(body?.monitors) ? {
      monitors: body.monitors as TMonitor[],
      total: typeof body.total === 'number' ? body.total : body.monitors.length,
      nextCursor: body.nextCursor ?? null,
    } : null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortForCaller);
  }
}
