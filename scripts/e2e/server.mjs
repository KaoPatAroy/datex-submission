// Playwright supervises this wrapper; the parent runner also tracks the actual Next PID.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { killTree } from './process.mjs';

const statePath = process.env.NEXUS_E2E_SERVER_STATE;
if (!statePath) throw new Error('Missing runner server state path.');
const cli = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [cli, 'start', '--hostname', '127.0.0.1', '--port', process.env.NEXUS_E2E_INNER_PORT ?? process.env.NEXUS_E2E_PORT], {
  env: process.env, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
});
// Next production sets Secure on the session cookie; Playwright's request jar drops it over plain http.
// When an inner port is supplied, front `next start` with a pass-through proxy that only strips `Secure`.
if (process.env.NEXUS_E2E_INNER_PORT) {
  const proxy = createServer((req, res) => {
    if (!state.startupOk) { res.writeHead(503); res.end(); return; } // ready only after warm-up
    const upstream = httpRequest({ host: '127.0.0.1', port: Number(process.env.NEXUS_E2E_INNER_PORT),
      method: req.method, path: req.url, headers: req.headers }, up => {
      const headers = { ...up.headers };
      if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(c => c.replace(/;\s*Secure(?=;|$)/gi, ''));
      res.writeHead(up.statusCode, up.statusMessage, headers);
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.listen(Number(process.env.NEXUS_E2E_PORT), '127.0.0.1');
}
const state = { pid: child.pid, wrapperPid: process.pid, startupOk: false, closed: false };
const save = () => writeFileSync(statePath, JSON.stringify(state));
save();
const upstreamPort = process.env.NEXUS_E2E_INNER_PORT ?? process.env.NEXUS_E2E_PORT;
let warming = false;
const probe = setInterval(async () => {
  if (warming) return;
  warming = true;
  try {
    const response = await fetch(`http://127.0.0.1:${upstreamPort}`, { signal: AbortSignal.timeout(1500) });
    await response.body?.cancel();
    if (response.status < 400) {
      // Cold-start warm-up: unauthenticated GET /api/session opens/seeds the DB without creating a session.
      await (await fetch(`http://127.0.0.1:${upstreamPort}/api/session`, { signal: AbortSignal.timeout(60_000) })).body?.cancel();
      state.startupOk = true; save(); clearInterval(probe);
    }
  } catch { /* Playwright's startup timeout remains authoritative. */ }
  warming = false;
}, 100);
child.once('error', error => { state.error = error.message; save(); clearInterval(probe); process.exitCode = 1; });
child.once('close', (code, signal) => {
  state.closed = true; state.code = code; state.signal = signal; save(); clearInterval(probe);
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearInterval(probe);
  void killTree(child.pid).then(result => { state.cleanup = result; save(); });
});
