import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function killTree(pid) {
  if (!pid || !isAlive(pid)) return { ok: true, status: 'already exited' };
  if (process.platform === 'win32') {
    const code = await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); resolve(null); }, 5000);
      killer.once('error', () => { clearTimeout(timer); resolve(null); });
      killer.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    for (let attempt = 0; attempt < 40 && isAlive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    return { ok: code === 0 && !isAlive(pid), status: `taskkill /T /F exit=${code}` };
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') return { ok: false, status: error.message }; }
  for (let attempt = 0; attempt < 40 && isAlive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  return { ok: !isAlive(pid), status: 'process group SIGKILL; PID exit checked' };
}

export function runProcess(args, { cwd, env, logPath, signal, timeoutMs = 600_000, spawnChild = spawn }) {
  return new Promise(resolve => {
    const started = Date.now();
    const log = createWriteStream(logPath, { flags: 'wx' });
    let child, timer, settled = false, terminationSignal, timedOut = false, termination;
    const finish = async result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const logClosed = log.closed ? Promise.resolve() : new Promise(resolve => log.once('close', resolve));
      log.end();
      const killResult = termination ? await termination : undefined;
      await logClosed;
      resolve({ ...result, pid: child?.pid, terminationSignal, timedOut, durationMs: Date.now() - started,
        cleanup: killResult ?? { ok: !result.error && !result.signal && !terminationSignal,
          status: result.signal || terminationSignal ? 'signal exit; tree unverified' : 'child closed' } });
    };
    const abort = () => {
      if (terminationSignal) return;
      terminationSignal = signal?.aborted ? String(signal.reason ?? 'aborted') : 'timeout';
      clearTimeout(timer);
      termination = killTree(child?.pid).catch(error => ({ ok: false, status: error.message }));
      timer = setTimeout(() => { void finish({ code: null, error: 'child close unverified after kill' }); }, 10_000);
    };
    log.once('error', error => { abort(); void finish({ error: error.message }); });
    try {
      child = spawnChild(process.execPath, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.once('error', error => finish({ error: error.message }));
      child.once('close', (code, childSignal) => finish({ code, signal: childSignal }));
      timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (error) { finish({ error: error.message }); }
  });
}
