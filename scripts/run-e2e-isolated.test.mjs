import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allocateDistinctPort,
  findAvailablePort,
  runSpec,
  toPlaywrightSpecArgument,
} from './run-e2e-isolated.mjs';

test('Playwright spec argument is repo-relative with forward slashes', () => {
  const absolutePath = fileURLToPath(new URL('../tests/e2e/action-revision-real.spec.ts', import.meta.url));

  assert.equal(
    toPlaywrightSpecArgument(absolutePath),
    'tests/e2e/action-revision-real.spec.ts',
  );
});

test('allocated local port is available to bind', async () => {
  const port = await findAvailablePort();
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('distinct port selection retries ports already used in this suite', async () => {
  const usedPorts = new Set();
  const candidates = [43121, 43121, 43122];
  const discoverPort = async () => candidates.shift();

  assert.equal(await allocateDistinctPort(usedPorts, discoverPort), 43121);
  assert.equal(await allocateDistinctPort(usedPorts, discoverPort), 43122);
  assert.deepEqual([...usedPorts], [43121, 43122]);
});

test('runSpec forwards termination and waits for the child close event', async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const forwardedSignals = [];
  let settled = false;
  child.kill = (signal) => {
    forwardedSignals.push(signal);
    return true;
  };
  child.unref = () => {};

  const resultPromise = runSpec('playwright-cli', 'tests/e2e/example.spec.ts', {}, {
    spawnChild: () => child,
    signalSource,
    gracefulTimeoutMs: 500,
    forceCloseTimeoutMs: 50,
  }).then((result) => {
    settled = true;
    return result;
  });

  signalSource.emit('SIGTERM');
  await new Promise(setImmediate);
  assert.deepEqual(forwardedSignals, ['SIGTERM']);
  assert.equal(settled, false);

  child.emit('close', null, 'SIGTERM');
  const result = await resultPromise;
  assert.equal(result.terminationSignal, 'SIGTERM');
  assert.equal(result.forceKillSent, false);
});

test('runSpec bounds shutdown and sends SIGKILL when the child stays open', async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const forwardedSignals = [];
  let unrefCalled = false;
  child.kill = (signal) => {
    forwardedSignals.push(signal);
    return true;
  };
  child.unref = () => {
    unrefCalled = true;
  };

  const resultPromise = runSpec('playwright-cli', 'tests/e2e/example.spec.ts', {}, {
    spawnChild: () => child,
    signalSource,
    gracefulTimeoutMs: 5,
    forceCloseTimeoutMs: 5,
  });
  signalSource.emit('SIGINT');

  const result = await resultPromise;
  assert.deepEqual(forwardedSignals, ['SIGINT', 'SIGKILL']);
  assert.equal(result.terminationSignal, 'SIGINT');
  assert.equal(result.forceKillSent, true);
  assert.equal(result.timedOut, true);
  assert.equal(unrefCalled, true);
});
