import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

/**
 * Static scan for "the server reads user language". Two detectors share one walk:
 *  1. Brand detector (type-aware): any expression typed `UserText` (lib/router/user-text.ts) that is a member receiver,
 *     regex/String/JSON.parse input, template span, comparison operand against a literal, switch/in operand, or cast away.
 *  2. Taint detector (transitional, name based): until ingress returns `UserText` (U9), identifiers named like the raw
 *     message seed a taint that flows through assignments and string-method chains; keyword-style string methods or
 *     regex tests on tainted values are reported.
 * Both ignore functions in PERMANENT_ALLOWED_FUNCTIONS (span location, hashing, storage, size checks).
 */
export const SCANNED_DIRS = ['lib/core', 'lib/packs', 'lib/router', 'lib/dynamic', 'lib/server'] as const;

/** Enclosing function names allowed to touch raw user text (evidence span location, digest, storage, size check, planner call). */
export const PERMANENT_ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'resolveSpan', 'titleFromFirstMessage', 'digest', 'exactSourceTextRef', 'buildTurnPlannerInput', 'requestQueryPlan', 'assertUserTextSize',
]);
/** Files allowed wholesale: exact-key Map.get scripted planner; the evidence-span resolver module (normalize.ts). */
export const PERMANENT_ALLOWED_FILES: ReadonlySet<string> = new Set(['lib/router/scripted-turn-planner.ts', 'lib/dynamic/plan/normalize.ts']);

const SEED_NAMES = new Set(['message', 'userMessage', 'rawMessage', 'userText', 'utterance', 'userPrompt', 'prompt', 'request']);
/** String/RegExp methods that interpret text. */
const KEYWORD_METHODS = new Set([
  'match', 'matchAll', 'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'split', 'toLowerCase', 'toLocaleLowerCase',
  'toUpperCase', 'toLocaleUpperCase', 'replace', 'replaceAll', 'search', 'normalize', 'test', 'exec', 'localeCompare',
]);
const ARG_METHODS = new Set(['test', 'exec', 'includes', 'indexOf', 'startsWith', 'endsWith', 'match', 'search', 'localeCompare']);
const BRAND_PROPERTY = '__userText';

export interface Violation { file: string; line: number; rule: string; snippet: string }
export const keyOf = (v: Pick<Violation, 'file' | 'line'>) => `${v.file}:${v.line}`;

export function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(join(dir, entry.name)); }
      else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

export function compilerOptionsFor(root: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022, lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'], strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, isolatedModules: true,
    jsx: ts.JsxEmit.ReactJSX, baseUrl: root, paths: { '@/*': ['./*'] },
  };
}

function enclosingNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) && cur.name && ts.isIdentifier(cur.name)) names.push(cur.name.text);
    else if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) {
      const parent = cur.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) names.push(parent.name.text);
      else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) names.push(parent.name.text);
    }
  }
  return names;
}

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node);

function functionName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return null;
}

/** Same-file call-graph taint: a function receiving a tainted argument gets that parameter seeded on the next pass. */
function scanSourceFile(sf: ts.SourceFile, relFile: string, checker: ts.TypeChecker): Violation[] {
  const localFunctions = new Set<string>();
  const collect = (n: ts.Node) => { const name = functionName(n); if (name) localFunctions.add(name); ts.forEachChild(n, collect); };
  collect(sf);
  const paramSeeds = new Map<string, Set<number>>();
  let found: Violation[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const before = [...paramSeeds.values()].reduce((n, s) => n + s.size, 0);
    found = scanOnce(sf, relFile, checker, localFunctions, paramSeeds);
    if ([...paramSeeds.values()].reduce((n, s) => n + s.size, 0) === before) break;
  }
  return found;
}

function scanOnce(sf: ts.SourceFile, relFile: string, checker: ts.TypeChecker, localFunctions: ReadonlySet<string>, paramSeeds: Map<string, Set<number>>): Violation[] {
  const found: Violation[] = [];
  const hasBrand = (node: ts.Node): boolean => {
    try {
      const type = checker.getTypeAtLocation(node);
      return (type.isUnionOrIntersection() ? type.types : [type]).some(t => t.getProperty(BRAND_PROPERTY) !== undefined)
        || type.getProperty(BRAND_PROPERTY) !== undefined;
    } catch { return false; }
  };
  const report = (at: ts.Node, rule: string) => {
    if (enclosingNames(at).some(n => PERMANENT_ALLOWED_FUNCTIONS.has(n))) return;
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    found.push({ file: relFile, line, rule, snippet: at.parent.getText(sf).slice(0, 100).replace(/\s+/gu, ' ') });
  };

  const scopes: Set<string>[] = [new Set()];
  const tainted = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    if (ts.isIdentifier(node)) return scopes.some(s => s.has(node.text)) || hasBrand(node);
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isAwaitExpression(node)) return tainted(node.expression);
    if (ts.isPropertyAccessExpression(node)) return hasBrand(node);
    if (ts.isElementAccessExpression(node)) return tainted(node.expression);
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) return tainted(node.expression.expression) || hasBrand(node);
      return ts.isIdentifier(node.expression) && localFunctions.has(node.expression.text) && node.arguments.some(tainted);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      return (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
        && (tainted(node.left) || tainted(node.right));
    }
    if (ts.isConditionalExpression(node)) return tainted(node.whenTrue) || tainted(node.whenFalse);
    if (ts.isTemplateExpression(node)) return node.templateSpans.some(s => tainted(s.expression));
    return false;
  };
  const isLiteral = (n: ts.Node) => ts.isStringLiteralLike(n) || ts.isNumericLiteral(n);

  const visit = (node: ts.Node): void => {
    const pushScope = isFunctionLike(node);
    if (pushScope) {
      const scope = new Set<string>();
      const seeded = paramSeeds.get(functionName(node) ?? '');
      (node as ts.FunctionLikeDeclaration).parameters.forEach((p, i) => {
        if (ts.isIdentifier(p.name) && (SEED_NAMES.has(p.name.text) || seeded?.has(i))) scope.add(p.name.text);
      });
      scopes.push(scope);
    }
    const current = scopes[scopes.length - 1];

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (SEED_NAMES.has(node.name.text) && !node.initializer) current.add(node.name.text);
      if (node.initializer && tainted(node.initializer)) current.add(node.name.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && tainted(node.right)) current.add(node.left.text);

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression, method = callee.name.text;
      if (KEYWORD_METHODS.has(method) && tainted(callee.expression)) report(callee.name, `string-method:${method}`);
      else if (ARG_METHODS.has(method) && node.arguments.some(tainted)) report(callee.name, `arg-of:${method}`);
      if (method === 'parse' && ts.isIdentifier(callee.expression) && callee.expression.text === 'JSON' && node.arguments.some(hasBrand)) report(node, 'brand:JSON.parse');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && localFunctions.has(node.expression.text)) {
      node.arguments.forEach((arg, i) => { if (tainted(arg)) { const set = paramSeeds.get((node.expression as ts.Identifier).text) ?? new Set<number>(); set.add(i); paramSeeds.set((node.expression as ts.Identifier).text, set); } });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' && node.arguments?.some(tainted)) report(node, 'arg-of:new RegExp');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String' && node.arguments.some(hasBrand)) report(node, 'brand:String()');

    // Brand-only strictness: any member access on a UserText value except .length.
    if (ts.isPropertyAccessExpression(node) && node.name.text !== 'length' && hasBrand(node.expression)) report(node.name, `brand:member:${node.name.text}`);
    if (ts.isTemplateSpan(node) && hasBrand(node.expression)) report(node, 'brand:template');
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const cmp = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken
        || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      if (cmp && ((hasBrand(node.left) && isLiteral(node.right)) || (hasBrand(node.right) && isLiteral(node.left)))) report(node, 'brand:compare-literal');
      if (op === ts.SyntaxKind.InKeyword && hasBrand(node.left)) report(node, 'brand:in');
    }
    if (ts.isSwitchStatement(node) && hasBrand(node.expression)) report(node.expression, 'brand:switch');
    if (ts.isAsExpression(node) && hasBrand(node.expression)
      && (node.type.kind === ts.SyntaxKind.StringKeyword || node.type.kind === ts.SyntaxKind.UnknownKeyword)) report(node, 'brand:cast');

    ts.forEachChild(node, visit);
    if (pushScope) scopes.pop();
  };
  visit(sf);
  return found;
}

export function scanProgram(program: ts.Program, root: string, include: (relFile: string) => boolean): Violation[] {
  const checker = program.getTypeChecker();
  const out = new Map<string, Violation>();
  for (const sf of program.getSourceFiles()) {
    const rel = relative(root, sf.fileName).split(sep).join('/');
    if (rel.startsWith('..') || !include(rel) || PERMANENT_ALLOWED_FILES.has(rel)) continue;
    for (const v of scanSourceFile(sf, rel, checker)) if (!out.has(keyOf(v))) out.set(keyOf(v), v);
  }
  return [...out.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** Scan the repository's guarded directories. */
export function scanRepository(root: string): Violation[] {
  const files = SCANNED_DIRS.flatMap(dir => listTsFiles(join(root, dir)));
  const program = ts.createProgram(files, compilerOptionsFor(root));
  const prefixes = SCANNED_DIRS.map(d => `${d}/`);
  return scanProgram(program, root, rel => prefixes.some(p => rel.startsWith(p)));
}

/** Scan in-memory sources (used to test the scanner itself). Paths are relative to `root`. */
export function scanVirtual(root: string, sources: Readonly<Record<string, string>>): Violation[] {
  const options = compilerOptionsFor(root);
  const host = ts.createCompilerHost(options);
  const abs = (rel: string) => join(root, rel);
  const byAbs = new Map(Object.entries(sources).map(([rel, text]) => [abs(rel).split(sep).join('/'), text]));
  const norm = (f: string) => f.split(sep).join('/');
  const realGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => byAbs.has(norm(name)) ? ts.createSourceFile(name, byAbs.get(norm(name)) as string, lang, true) : realGet(name, lang, ...rest);
  const realExists = host.fileExists.bind(host), realRead = host.readFile.bind(host);
  host.fileExists = f => byAbs.has(norm(f)) || realExists(f);
  host.readFile = f => byAbs.get(norm(f)) ?? realRead(f);
  const program = ts.createProgram([...byAbs.keys()], options, host);
  return scanProgram(program, root, () => true);
}

export function readText(path: string): string { return readFileSync(path, 'utf8'); }
