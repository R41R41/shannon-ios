import { createContext, Script } from 'node:vm';
import { extname } from 'node:path';
import ts from 'typescript';
import type { SelfRewriteFile } from './selfRewritePorts.js';

const TEST_SCHEMA = 'shannon.numeric-tests.v1';
const MATH_ARITY: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  abs: [1, 1], ceil: [1, 1], floor: [1, 1], round: [1, 1], sign: [1, 1], sqrt: [1, 1], trunc: [1, 1],
  min: [1, 8], max: [1, 8], pow: [2, 2],
});
const OPERATORS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.PlusToken, '+'], [ts.SyntaxKind.MinusToken, '-'], [ts.SyntaxKind.AsteriskToken, '*'],
  [ts.SyntaxKind.SlashToken, '/'], [ts.SyntaxKind.PercentToken, '%'], [ts.SyntaxKind.AsteriskAsteriskToken, '**'],
]);
const RESERVED = new Set(('await break case catch class const continue debugger default delete do else enum export extends false finally for function if '
  + 'implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield '
  + 'Math eval arguments constructor prototype __proto__').split(' '));
interface NumericFunction { name: string; parameters: string[]; expression: string }

/** The AST allowlist is the boundary. The VM only executes its canonical, closed numeric expression. */
export function checkRewriteCode(files: readonly SelfRewriteFile[]): boolean {
  try {
    const modules = files.filter(file => extname(file.path).toLowerCase() === '.mjs');
    if (!modules.length) return true;
    return modules.every(file => {
      const functions = numericFunctions(file.content);
      const fixture = files.find(test => test.path === `${file.path}.test.json`);
      if (!functions || !fixture?.content) return false;
      const parsed: unknown = JSON.parse(fixture.content);
      if (!record(parsed) || !keys(parsed, ['schema', 'cases']) || parsed.schema !== TEST_SCHEMA
        || !Array.isArray(parsed.cases) || !parsed.cases.length || parsed.cases.length > 64) return false;
      const covered = new Set<string>();
      const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      for (const test of parsed.cases) {
        if (!record(test) || !keys(test, ['export', 'args', 'expected']) || typeof test.export !== 'string'
          || !Array.isArray(test.args) || !test.args.every(finite) || !finite(test.expected)) return false;
        const fn = functions.find(item => item.name === test.export);
        if (!fn || fn.parameters.length !== test.args.length) return false;
        const invocation = `((${fn.parameters.join(',')})=>(${fn.expression}))(${test.args.map(numberSource).join(',')})`;
        const actual: unknown = new Script(`"use strict";${invocation}`).runInContext(context, { timeout: 50 });
        if (!finite(actual) || actual !== test.expected) return false;
        covered.add(fn.name);
      }
      return functions.every(fn => covered.has(fn.name));
    });
  } catch { return false; }
}

/** No source, fixture, or model-supplied approval can extend this grammar. */
export function safeRewriteCode(files: readonly SelfRewriteFile[]): boolean {
  try { return files.filter(file => extname(file.path).toLowerCase() === '.mjs').every(file => !!numericFunctions(file.content)); }
  catch { return false; }
}

function numericFunctions(source: string | null): NumericFunction[] | null {
  if (!source || Buffer.byteLength(source) > 16_000 || source.startsWith('#!')) return null;
  const name = 'candidate.mjs', tree = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = {
    getSourceFile: file => file === name ? tree : undefined, getDefaultLibFileName: () => '', writeFile: () => {},
    getCurrentDirectory: () => '', getDirectories: () => [], fileExists: file => file === name, readFile: () => undefined,
    getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  if (ts.createProgram([name], { allowJs: true, noLib: true, noResolve: true }, host).getSyntacticDiagnostics(tree).length
    || !tree.statements.length || tree.statements.length > 16 || tree.endOfFileToken.end !== source.length) return null;
  const result: NumericFunction[] = [];
  for (const item of tree.statements) {
    if (!ts.isFunctionDeclaration(item) || !item.name || !identifier(item.name) || item.asteriskToken || item.type
      || item.typeParameters?.length || item.modifiers?.length !== 1 || item.modifiers[0]!.kind !== ts.SyntaxKind.ExportKeyword
      || !item.body || item.body.statements.length !== 1 || item.parameters.length > 8) return null;
    const parameters: string[] = [];
    for (const parameter of item.parameters) {
      if (!ts.isIdentifier(parameter.name) || !identifier(parameter.name) || parameter.dotDotDotToken || parameter.questionToken
        || parameter.type || parameter.initializer || parameter.modifiers?.length) return null;
      parameters.push(parameter.name.text);
    }
    if (new Set(parameters).size !== parameters.length || result.some(fn => fn.name === item.name!.text)) return null;
    const statement = item.body.statements[0]!;
    if (!ts.isReturnStatement(statement) || !statement.expression) return null;
    const count = { nodes: 0 }, expression = numericExpression(statement.expression, new Set(parameters), count, 0);
    if (expression === null) return null;
    result.push({ name: item.name.text, parameters, expression });
  }
  return result;
}
function numericExpression(node: ts.Expression, names: ReadonlySet<string>, count: { nodes: number }, depth: number): string | null {
  if (++count.nodes > 256 || depth > 32) return null;
  const next = (value: ts.Expression) => numericExpression(value, names, count, depth + 1);
  if (ts.isNumericLiteral(node)) { const value = Number(node.text); return finite(value) ? numberSource(value) : null; }
  if (ts.isIdentifier(node)) return identifier(node) && names.has(node.text) ? node.text : null;
  if (ts.isParenthesizedExpression(node)) { const inside = next(node.expression); return inside === null ? null : `(${inside})`; }
  if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
    const operand = next(node.operand); return operand === null ? null : `(${node.operator === ts.SyntaxKind.PlusToken ? '+' : '-'}(${operand}))`;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = OPERATORS.get(node.operatorToken.kind), left = next(node.left), right = next(node.right);
    return !operator || left === null || right === null ? null : `((${left})${operator}(${right}))`;
  }
  if (ts.isCallExpression(node) && !node.questionDotToken && !node.typeArguments?.length && ts.isPropertyAccessExpression(node.expression)
    && !node.expression.questionDotToken && ts.isIdentifier(node.expression.expression) && node.expression.expression.getText() === 'Math'
    && identifier(node.expression.name)) {
    const method = node.expression.name.text, arity = Object.hasOwn(MATH_ARITY, method) ? MATH_ARITY[method] : undefined;
    if (!arity || node.arguments.length < arity[0] || node.arguments.length > arity[1]) return null;
    const args = node.arguments.map(next);
    return args.some(arg => arg === null) ? null : `Math.${method}(${args.join(',')})`;
  }
  return null;
}
function identifier(node: ts.Node & { text: string }): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(node.text) && node.getText() === node.text
    && !RESERVED.has(node.text);
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function numberSource(value: number): string { return Object.is(value, -0) ? '-0' : String(value); }
