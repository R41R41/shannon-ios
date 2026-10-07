import { describe, expect, it } from 'vitest';
import { checkRewriteCode, safeRewriteCode } from '../src/mind/inhibition/selfRewriteCodeChecks.js';
import { checkRewriteData, safeRewriteData } from '../src/mind/inhibition/selfRewriteDataChecks.js';
import type { SelfRewriteCandidate, SelfRewriteFile } from '../src/mind/inhibition/selfRewritePorts.js';
import { SELF_REWRITE_SCHEMA } from '../src/mind/inhibition/selfRewritePorts.js';

const path = '/isolated/numbers.mjs';
const tests = (cases: unknown[]) => JSON.stringify({ schema: 'shannon.numeric-tests.v1', cases });
function files(source: string, content = tests([{ export: 'add', args: [2, 3], expected: 5 }])): SelfRewriteFile[] {
  return [{ path, beforeHash: null, content: source }, { path: `${path}.test.json`, beforeHash: null, content }];
}
function candidate(items: SelfRewriteFile[]): SelfRewriteCandidate {
  return { schema: SELF_REWRITE_SCHEMA, id: 'candidate', workId: 'work', scopeKey: 'owner', sourceId: 'source', origin: 'own_time',
    budgetLane: 'autonomy', baseRevision: 'baseline', diffHash: 'unused-format-only', files: items };
}
describe('closed code grammar with actual candidate-bound numeric tests', () => {
  it('executes all exports from validated source, arithmetic, parentheses and fixed pure Math', () => {
    const value = files('/* utility */ export function add(a,b) { return a+b; }\nexport function clamp(x,limit){return Math.min(Math.max(x,0),limit)}\nexport function square(x){return (-(x)) ** 2}',
      tests([{ export: 'add', args: [2, 3], expected: 5 }, { export: 'add', args: [-2, 3], expected: 1 },
        { export: 'clamp', args: [-1, 10], expected: 0 }, { export: 'clamp', args: [11, 10], expected: 10 },
        { export: 'square', args: [3], expected: 9 }]));
    expect(checkRewriteCode(value)).toBe(true); expect(safeRewriteCode(value)).toBe(true);
    expect(checkRewriteData(candidate(value))).toBe(true);
    expect(safeRewriteData(candidate(value))).toBe(true);
  });
  it.each([
    ['incomplete', 'export function add(a,b){return a+'],
    ['trailing source', 'export function add(a,b){return a+b} process.exit(0)'],
    ['trailing malformed source', 'export function add(a,b){return a+b} @'],
    ['other declaration', 'export function add(a,b){return a+b} const x=1'],
    ['body statement', 'export function add(a,b){let x=1; return a+b}'],
    ['import', 'import fs from "node:fs"; export function add(a,b){return a+b}'],
    ['async', 'export async function add(a,b){return a+b}'],
    ['generator', 'export function* add(a,b){return a+b}'],
    ['default export', 'export default function add(a,b){return a+b}'],
    ['TypeScript', 'export function add(a:number,b:number){return a+b}'],
    ['strict reserved parameter', 'export function add(interface,b){return interface+b}'],
    ['strict reserved export', 'export function package(a,b){return a+b}'],
    ['module await parameter', 'export function add(await,b){return await+b}'],
    ['strict yield parameter', 'export function add(yield,b){return yield+b}'],
    ['free identifier', 'export function add(a,b){return a+globalThis}'],
    ['cross function call', 'export function add(a,b){return other(a)}'],
    ['constructor', 'export function add(a,b){return a.constructor("return process")()}'],
    ['prototype', 'export function add(a,b){return Math.constructor(1)}'],
    ['computed access', 'export function add(a,b){return Math["abs"](a+b)}'],
    ['optional access', 'export function add(a,b){return Math?.abs(a+b)}'],
    ['Math alias parameter', 'export function add(Math,b){return Math.abs(b)}'],
    ['escaped identifier', String.raw`export function add(\u0061,b){return a+b}`],
    ['dynamic import', 'export function add(a,b){return import("node:fs")}'],
    ['regex', 'export function add(a,b){return /x/.test(a)}'],
    ['string', 'export function add(a,b){return "5"}'],
    ['array', 'export function add(a,b){return [a+b]}'],
    ['object', 'export function add(a,b){return {value:a+b}}'],
    ['boolean', 'export function add(a,b){return true}'],
    ['bigint', 'export function add(a,b){return 5n}'],
    ['spread', 'export function add(a,b){return Math.max(...[a,b])}'],
    ['assignment', 'export function add(a,b){return a=b}'],
    ['sequence', 'export function add(a,b){return (a,b)}'],
    ['loop', 'export function add(a,b){while(true){} return a+b}'],
    ['rest parameter', 'export function add(...a){return 5}'],
    ['default parameter', 'export function add(a=2,b=3){return a+b}'],
    ['duplicate parameter', 'export function add(a,a){return a+a}'],
    ['duplicate export', 'export function add(a,b){return a+b} export function add(a,b){return a-b}'],
    ['nested function', 'export function add(a,b){return (()=>a+b)()}'],
    ['unknown Math', 'export function add(a,b){return Math.random()}'],
    ['prototype Math method', 'export function add(a,b){return Math.toString(a)}'],
    ['shebang', '#!/usr/bin/env node\nexport function add(a,b){return a+b}'],
  ])('rejects %s before evaluating any source', (_reason, source) => {
    expect(checkRewriteCode(files(source))).toBe(false); expect(safeRewriteCode(files(source))).toBe(false);
  });
  it('requires actual tests for every export and rejects fabricated approvals and mismatched cases', () => {
    const source = 'export function add(a,b){return a+b}';
    for (const fixture of ['{"passed":true}', tests([]), tests([{ export: 'add', args: [2, 3], expected: 6 }]),
      tests([{ export: 'add', args: [2], expected: 5 }]), tests([{ export: 'add', args: ['2', 3], expected: 5 }]),
      tests([{ export: 'add', args: [2, 3], expected: 5, approved: true }]),
      tests([{ export: 'other', args: [2, 3], expected: 5 }])]) expect(checkRewriteCode(files(source, fixture))).toBe(false);
    expect(checkRewriteCode(files(`${source} export function other(x){return x}`))).toBe(false);
    expect(checkRewriteCode([{ path, beforeHash: null, content: source }])).toBe(false);
    expect(checkRewriteCode(files('export function add(a,b){return 1/0}'))).toBe(false);
    expect(checkRewriteCode(files('export function add(a,b){return Math.sqrt(-1)}'))).toBe(false);
    expect(checkRewriteCode(files(source, tests(Array.from({ length: 65 }, () => ({ export: 'add', args: [2, 3], expected: 5 })))))).toBe(false);
  });
  it('keeps unsupported general code unverified and binds fixtures to the candidate, not existing disk', () => {
    const value = files('export function add(a,b){return a+b}');
    expect(checkRewriteCode([{ ...value[0]!, content: null }, value[1]!])).toBe(false);
    expect(checkRewriteCode([value[0]!, { ...value[1]!, path: '/other/test.json' }])).toBe(false);
    expect(checkRewriteData(candidate([{ ...value[0]!, path: '/isolated/general.js' }]))).toBe(false);
  });
});
