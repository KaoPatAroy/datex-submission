// Seeds the template DB once (the first store access costs ~15 s); each spec file then starts from a byte copy.
// Starts the normal server wrapper, waits for its warm-up (GET /api/session opens + seeds the DB), then stops it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAlive, killTree } from './process.mjs';

const statePath = process.env.NEXUS_E2E_SERVER_STATE;
const wrapper = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { env: process.env, stdio: 'inherit', windowsHide: true });
const read = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const deadline = Date.now() + 180_000;
let state = read();
while (!state.startupOk && Date.now() < deadline && wrapper.exitCode === null) { await new Promise(r => setTimeout(r, 200)); state = read(); }
// The server must still be healthy at the moment WE stop it: a crash after readiness (dead pid, wrapper exited, recorded error/close)
// fails the seed here, so the runner's stoppedOnPurpose only ever forgives the exit code of our own deliberate kill.
state = read();
const ok = state.startupOk === true && !state.error && !state.closed && isAlive(state.pid) && wrapper.exitCode === null;
await killTree(state.pid); await killTree(wrapper.pid);
await new Promise(r => setTimeout(r, 1000)); // let SQLite release the files
process.exit(ok ? 0 : 1);
