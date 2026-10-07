import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../components/nexus-workspace.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('nexus.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let send: ts.FunctionDeclaration | undefined;
let enabled: ts.Expression | undefined;
let rejection: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'sendTurn') send = node;
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'chatEnabled' && node.initializer && ts.isJsxExpression(node.initializer)) enabled = node.initializer.expression;
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'rejection' && node.initializer && ts.isJsxExpression(node.initializer)) rejection = node.initializer.expression;
  ts.forEachChild(node, visit);
}
visit(ast);
const prefix = send!.body!.statements.slice(0, send!.body!.statements.findIndex(node => node.getText(ast).startsWith('const startedAt'))).map(node => node.getText(ast)).join('\n');
function guards(reviewedProposal: unknown, chatRejection: string | null = null) {
  const setChatRejection = vi.fn();
  const context = { session: {}, csrfToken: 'csrf', workspace: {}, turnBusy: false, submissionRef: { current: false }, turnRecovery: null,
    blockedRequestTexts: [], reviewedProposal, setChatRejection, canChat: true, chatRejection };
  const js = ts.transpileModule(`async function send(message:string,recoveryOfTurnId?:string){${prefix}\nreturn true;} globalThis.run=send; globalThis.enabled=${enabled!.getText(ast)}; globalThis.rejection=${rejection!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtime = { ...context, run: undefined as unknown as (message: string) => Promise<boolean>, enabled: false, rejection: null as string | null };
  runInNewContext(js, runtime);
  return runtime;
}
describe('composer while the staged result dialog is open', () => {
  it('visibly blocks send with a reason and does not consume the typed message', async () => {
    const runtime = guards({ id: 'completed-proposal' });
    expect(runtime.enabled).toBe(false);
    expect(runtime.rejection).toContain('ปิดหน้าต่าง');
    expect(await runtime.run('ข้อความที่พิมพ์ไว้')).toBe(false);
    expect(runtime.setChatRejection).not.toHaveBeenCalled();
  });
  it('permits sending after the dialog closes', async () => {
    const runtime = guards(null);
    expect(runtime.enabled).toBe(true);
    expect(await runtime.run('ข้อความที่พิมพ์ไว้')).toBe(true);
  });
  it('does not persist the modal block reason after closing, while preserving an earlier chat error', async () => {
    const open = guards({ id: 'completed-proposal' }, 'earlier network error');
    await open.run('ข้อความที่พิมพ์ไว้');
    const closed = guards(null, open.setChatRejection.mock.calls.at(-1)?.[0] ?? 'earlier network error');
    expect(closed.rejection).toBe('earlier network error');
  });
});
