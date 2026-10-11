import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countsOf, overBaseline, shapeViolations, shrunk } from './check-code-shape.mjs';

let typescriptFound = true;
try {
  await import('typescript');
} catch {
  typescriptFound = false;
}
const skip = typescriptFound ? false : 'the typescript package cannot be found (no node_modules)';
const check = (name, body) => test(name, { skip }, body);

const rules = (path, text) => shapeViolations(path, text).map(item => item.rule);

check('two statements on one line count once per line; a guarded return does not', () => {
  assert.deepEqual(rules('a.ts', 'const a = 1; const b = 2;\n'), ['multi-statement-line']);
  assert.deepEqual(rules('a.ts', 'function f(x: number) {\n  if (x) return 1;\n  return 2;\n}\n'), []);
  assert.deepEqual(rules('a.ts', 'const f = () => { g(); h(); };\n'), ['multi-statement-line']);
});

check('a long line counts unless the file is a prompt file', () => {
  const line = `const text = '${'x'.repeat(170)}';\n`;
  assert.deepEqual(rules('src/a.ts', line), ['long-line']);
  assert.deepEqual(rules('src/prompts/a.ts', line), []);
});

check('functions are measured without their nested functions', () => {
  const body = Array.from({ length: 61 }, (_, index) => `  const v${index} = ${index};`).join('\n');
  assert.deepEqual(rules('a.ts', `function long() {\n${body}\n}\n`), ['long-function']);
  const nested = `function outer() {\n  const inner = () => {\n${body}\n  };\n  return inner;\n}\n`;
  assert.deepEqual(shapeViolations('a.ts', nested).map(item => item.where), ['inner@2']);
});

check('cyclomatic complexity counts branches and logical operators', () => {
  const conditions = count => Array.from({ length: count }, (_, index) => `x === ${index}`).join(' ||\n    ');
  assert.deepEqual(rules('a.ts', `function f(x: number) {\n  return ${conditions(16)};\n}\n`), ['complex-function']);
  assert.deepEqual(rules('a.ts', `function f(x: number) {\n  return ${conditions(15)};\n}\n`), []);
});

check('a file of more than 350 statements is long', () => {
  const text = Array.from({ length: 351 }, (_, index) => `export const v${index} = ${index};`).join('\n');
  assert.deepEqual(rules('a.ts', text), ['long-file']);
});

check('the baseline only shrinks: more is over, a new file is held to zero, less is reported', () => {
  const baseline = { 'old.ts': { 'long-line': 2 } };
  const current = { 'old.ts': { 'long-line': 3 }, 'new.ts': { 'long-line': 1 } };
  assert.deepEqual(overBaseline(current, baseline).map(item => item.file), ['new.ts', 'old.ts']);
  assert.deepEqual(overBaseline({ 'old.ts': { 'long-line': 2 } }, baseline), []);
  assert.deepEqual(shrunk({ 'old.ts': { 'long-line': 1 } }, baseline), [{ file: 'old.ts', rule: 'long-line', count: 1, was: 2 }]);
  assert.deepEqual(countsOf([{ rule: 'long-line' }, { rule: 'long-line' }]), { 'long-line': 2 });
});
