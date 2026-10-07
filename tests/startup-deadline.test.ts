import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const componentText = readFileSync(new URL('../components/nexus-workspace.tsx', import.meta.url), 'utf8');
const componentAst = ts.createSourceFile('components/nexus-workspace.tsx', componentText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function only<T>(nodes: T[], label: string): T {
  if (nodes.length !== 1) throw new Error(`Expected exactly one ${label}, found ${nodes.length}.`);
  return nodes[0]!;
}

function textOf(node: ts.Node): string {
  return componentText.slice(node.getStart(componentAst), node.end);
}

const apiErrorNode = only(
  componentAst.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'ApiError'),
  'ApiError class',
);
const apiRequestNode = only(
  componentAst.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'apiRequest'),
  'apiRequest function',
);
const workspaceComponent = only(
  componentAst.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NexusWorkspace'),
  'NexusWorkspace component',
);
const workspaceDeclarations = workspaceComponent.body!.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
const workspaceReadDependencies = ['workspaceReadGeneration', 'readLatestWorkspace'].map(name => only(
  workspaceDeclarations.filter(node => ts.isIdentifier(node.name) && node.name.text === name),
  `${name} bootstrap dependency`,
));
const bootstrapEffects: ts.ArrowFunction[] = [];

function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') {
    const callback = node.arguments[0];
    if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
      let containsBootstrap = false;
      function findBootstrap(child: ts.Node) {
        if (ts.isFunctionDeclaration(child) && child.name?.text === 'bootstrap') containsBootstrap = true;
        ts.forEachChild(child, findBootstrap);
      }
      findBootstrap(callback.body);
      if (containsBootstrap) bootstrapEffects.push(callback);
    }
  }
  ts.forEachChild(node, visit);
}

visit(componentAst);
const bootstrapEffectNode = only(bootstrapEffects, 'initial bootstrap effect');
const runtimeSource = [
  textOf(apiErrorNode),
  textOf(apiRequestNode),
  ...workspaceReadDependencies.map(node => `const ${textOf(node)};`),
  `globalThis.__apiRequest = apiRequest;`,
  `globalThis.__ApiError = ApiError;`,
  `globalThis.__bootstrapEffect = ${textOf(bootstrapEffectNode)};`,
].join('\n');
const runtimeProgram = ts.transpileModule(runtimeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type ApiRequest = <T>(path: string, init?: RequestInit, readDeadlineMs?: number) => Promise<T>;
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function responseWithBody(status: number, body: string | Promise<string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(() => Promise.resolve(body)),
  } as unknown as Response;
}

function createRuntime(fetchImpl: unknown, bindings: Record<string, unknown> = {}) {
  const context: Record<string, unknown> = {
    fetch: fetchImpl,
    AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    // Run the extracted production closure with the hook values it receives on mount.
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    ...bindings,
  };
  runInNewContext(runtimeProgram, context);
  return {
    apiRequest: context.__apiRequest as ApiRequest,
    bootstrapEffect: context.__bootstrapEffect as () => () => void,
  };
}

type BootstrapSnapshot = {
  screens: string[];
  loginErrors: unknown[];
  sessions: unknown[];
  workspaces: unknown[];
  workspaceErrors: unknown[];
};

function startBootstrap(fetchImpl: unknown) {
  const snapshot: BootstrapSnapshot = { screens: [], loginErrors: [], sessions: [], workspaces: [], workspaceErrors: [] };
  const runtime = createRuntime(fetchImpl, {
    bootstrapAttempt: 0,
    applyTurnReadback: () => undefined,
    readRecoveryMemory: () => ({ pending: null, blockedTexts: [], newConversation: false }),
    setScreen: (value: string) => snapshot.screens.push(value),
    setLoginError: (value: unknown) => snapshot.loginErrors.push(value),
    setSession: (value: unknown) => snapshot.sessions.push(value),
    setWorkspace: (value: unknown) => snapshot.workspaces.push(value),
    setWorkspaceError: (value: unknown) => snapshot.workspaceErrors.push(value),
    setTurnRecovery: () => undefined,
    setBlockedRequestTexts: () => undefined,
    setNewConversation: () => undefined,
    setDraft: () => undefined,
  });
  const cleanup = runtime.bootstrapEffect();
  return { snapshot, cleanup };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('production startup request deadline', () => {
  it('aborts a GET stalled before headers at exactly 30 seconds without retrying', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return pending.promise;
    });
    const { apiRequest } = createRuntime(fetchMock);
    let outcome: { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: unknown } | undefined;
    const request = apiRequest('/api/session', {}, 30_000);
    void request.then(
      (value) => { outcome = { kind: 'resolved', value }; },
      (error: unknown) => { outcome = { kind: 'rejected', error }; },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session');
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toMatchObject({ kind: 'rejected', error: { status: 0, code: 'request_timeout' } });
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    pending.resolve(responseWithBody(200, '{"actor":{"id":"late"}}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ kind: 'rejected', error: { code: 'request_timeout' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the same deadline active while reading the response body', async () => {
    const body = deferred<string>();
    const response = responseWithBody(200, body.promise);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return response;
    });
    const { apiRequest } = createRuntime(fetchMock);
    let outcome: { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: unknown } | undefined;
    const request = apiRequest('/api/workspace', {}, 30_000);
    void request.then(
      (value) => { outcome = { kind: 'resolved', value }; },
      (error: unknown) => { outcome = { kind: 'rejected', error }; },
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.text).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toMatchObject({ kind: 'rejected', error: { status: 0, code: 'request_timeout' } });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    body.resolve('{"actor":{"id":"late"}}');
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ kind: 'rejected', error: { code: 'request_timeout' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the deadline after a successful response', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return responseWithBody(200, '{"ok":true}');
    });
    const { apiRequest } = createRuntime(fetchMock);

    await expect(apiRequest('/api/session', {}, 30_000)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline while preserving a normal 401 ApiError', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return responseWithBody(401, '{"error":{"message":"Unauthorized","code":"unauthorized"}}');
    });
    const { apiRequest } = createRuntime(fetchMock);

    await expect(apiRequest('/api/session', {}, 30_000)).rejects.toMatchObject({ status: 401, code: 'unauthorized' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after an immediate fetch failure without retrying', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      void _input;
      void _init;
      throw new Error('offline');
    });
    const { apiRequest } = createRuntime(fetchMock);

    await expect(apiRequest('/api/session', {}, 30_000)).rejects.toMatchObject({ status: 0, code: 'network_error' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not add a deadline or abort signal to existing write requests without opt-in', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return pending.promise;
    });
    const { apiRequest } = createRuntime(fetchMock);
    let settled = false;
    const request = apiRequest('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    void request.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
      cache: 'no-store',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();

    pending.resolve(responseWithBody(200, '{"ok":true}'));
    await expect(request).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('moves bootstrap to login after a session 401 and does not retry or fetch workspace', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return responseWithBody(401, '{"error":{"message":"Unauthorized","code":"unauthorized"}}');
    });
    const bootstrap = startBootstrap(fetchMock);

    await vi.advanceTimersByTimeAsync(0);

    expect(bootstrap.snapshot.screens).toEqual(['checking', 'login']);
    expect(bootstrap.snapshot.sessions.at(-1)).toBeNull();
    expect(bootstrap.snapshot.workspaces.at(-1)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session');
    expect(vi.getTimerCount()).toBe(0);
    bootstrap.cleanup();
  });

  it('moves bootstrap to failed on a session timeout and ignores a late response', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return pending.promise;
    });
    const bootstrap = startBootstrap(fetchMock);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(bootstrap.snapshot.screens).toEqual(['checking']);
    await vi.advanceTimersByTimeAsync(1);

    expect(bootstrap.snapshot.screens).toEqual(['checking', 'failed']);
    expect(bootstrap.snapshot.sessions).toEqual([]);
    expect(bootstrap.snapshot.workspaces).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    pending.resolve(responseWithBody(200, '{"actor":{"id":"late","sessionId":"late-session"}}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(bootstrap.snapshot.screens).toEqual(['checking', 'failed']);
    expect(bootstrap.snapshot.sessions).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    bootstrap.cleanup();
  });

  it('keeps a valid session ready when the initial workspace GET times out', async () => {
    const workspace = deferred<Response>();
    const session = { actor: { id: 'actor-1', sessionId: 'session-1' } };
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      return String(input) === '/api/session'
        ? Promise.resolve(responseWithBody(200, JSON.stringify(session)))
        : workspace.promise;
    });
    const bootstrap = startBootstrap(fetchMock);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/workspace');
    expect(bootstrap.snapshot.screens).toEqual(['checking', 'ready']);
    expect(bootstrap.snapshot.sessions).toEqual([session]);
    expect(vi.getTimerCount()).toBe(1);
    const signal = fetchMock.mock.calls[1]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(bootstrap.snapshot.workspaceErrors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(bootstrap.snapshot.screens).toEqual(['checking', 'ready']);
    expect(bootstrap.snapshot.sessions).toEqual([session]);
    expect(bootstrap.snapshot.workspaces).toEqual([]);
    expect(bootstrap.snapshot.workspaceErrors).toHaveLength(1);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    workspace.resolve(responseWithBody(200, '{"actor":{"id":"late"}}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(bootstrap.snapshot.screens).toEqual(['checking', 'ready']);
    expect(bootstrap.snapshot.workspaces).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    bootstrap.cleanup();
  });
});
