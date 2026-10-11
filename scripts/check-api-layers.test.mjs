import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { baselineFrom, compareWithBaseline, componentOf, globRegExp, valueSpecifiers, violations } from './check-api-layers.mjs';

// Without node_modules (no typescript) the tests are skipped, and say so, rather than failing the fast lane.
let typescriptFound = true;
try { await import('typescript'); } catch { typescriptFound = false; }
const skip = typescriptFound ? false : 'the typescript package cannot be found (no node_modules)';
const check = (name, body) => test(name, { skip }, body);

const directories = [];
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'shannon-layers-'));
  directories.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const config = {
  sourceRoot: 'src',
  rules: [
    { id: 'entries-at-root', kind: 'placement' },
    { id: 'mind-via-ports', kind: 'imports', from: ['mind/**'], to: ['mind/**'], crossComponent: true, toExcept: ['mind/*/ports.ts', 'mind/action/*/ports.ts'] },
    { id: 'sqlite-in-stores', kind: 'imports', from: ['**'], fromExcept: ['**/store/**', 'wiring/**'], to: ['node:sqlite'] },
    { id: 'narrow', kind: 'imports', from: ['**/clock.ts'], only: ['@shannon/*', '**/timing.ts'] },
    { id: 'environment', kind: 'token', pattern: '\\bprocess\\.env\\b', allowIn: ['infra/config/**', '*.ts'] },
    { id: 'pure', kind: 'package', packages: ['packages/pure/src'], allow: ['@shannon/*'], forbiddenPattern: '\\bfetch\\(' },
  ],
};

check('globs: one segment, any depth, and module names', () => {
  assert.ok(globRegExp('mind/**').test('mind/memory/store/a.ts'));
  assert.ok(!globRegExp('mind/**').test('surfaces/text/a.ts'));
  assert.ok(globRegExp('**/store/**').test('mind/memory/store/a.ts'));
  assert.ok(globRegExp('**/store/**').test('store/a.ts'));
  assert.ok(!globRegExp('**/store/**').test('mind/memory/restore.ts'));
  assert.ok(globRegExp('*.ts').test('server.ts'));
  assert.ok(!globRegExp('*.ts').test('mind/server.ts'));
  assert.ok(globRegExp('mind/*/ports.ts').test('mind/memory/ports.ts'));
  assert.ok(globRegExp('@shannon/*').test('@shannon/cognition'));
  assert.equal(componentOf('mind/action/ownTime/store/a.ts'), 'mind/action/ownTime');
  assert.equal(componentOf('mind/memory/store/a.ts'), 'mind/memory');
  assert.equal(componentOf('server.ts'), '(entry)');
  assert.equal(componentOf('wiring/a.ts'), 'wiring');
});

check('checks the projected layout: a flat file is judged at its target, and resolved imports of every kind count', () => {
  const root = tree({
    'src/server.ts': "import { a } from './a.js';\nconst port = process.env.PORT;\n",
    'src/a.ts': "import type { B } from './b.js';\nexport const later = () => import('./c.js');\nexport { d } from './d.js';\n",
    'src/b.ts': "import { DatabaseSync } from 'node:sqlite';\nexport type B = number;\n",
    'src/c.ts': 'export const c = process.env.C;\n',
    'src/d.ts': "export const d = 1;\n",
    'src/clock.ts': "import { t } from './timing.js';\nimport { x } from './d.js';\nimport { y } from '@shannon/cognition';\n",
    'src/timing.ts': 'export const t = 1;\n',
    'src/stray.ts': '// a new file moves.json does not know\n',
    'packages/pure/src/index.ts': "import { readFileSync } from 'node:fs';\nimport { y } from '@shannon/cognition';\nfetch('x');\n",
  });
  const moves = {
    entries: ['server.ts'],
    moves: {
      'a.ts': { to: 'mind/memory/a.ts' }, 'b.ts': { to: 'mind/recall/store/b.ts' }, 'c.ts': { to: 'mind/emotion/c.ts' },
      'd.ts': { to: 'mind/recall/d.ts' }, 'clock.ts': { to: 'mind/emotion/clock.ts' }, 'timing.ts': { to: 'mind/emotion/timing.ts' },
    },
  };
  const found = violations({ root, config, moves }).map(item => `${item.rule}: ${item.from} -> ${item.to}`);
  assert.deepEqual(found, [
    'entries-at-root: stray.ts -> (not an entry file)',
    'environment: mind/emotion/c.ts -> process.env',
    'mind-via-ports: mind/emotion/clock.ts -> mind/recall/d.ts',
    'mind-via-ports: mind/memory/a.ts -> mind/emotion/c.ts',
    'mind-via-ports: mind/memory/a.ts -> mind/recall/d.ts',
    'mind-via-ports: mind/memory/a.ts -> mind/recall/store/b.ts',
    'narrow: mind/emotion/clock.ts -> mind/recall/d.ts',
    'pure: packages/pure/src/index.ts -> fetch(',
    'pure: packages/pure/src/index.ts -> node:fs',
  ]);
  // The same tree checked where the files are: every non-entry file at the root is out of place.
  const actual = violations({ root, config, moves, layout: 'actual' }).map(item => `${item.rule}: ${item.from}`);
  assert.ok(actual.includes('entries-at-root: a.ts'));
  assert.ok(actual.includes('sqlite-in-stores: b.ts'));
});

check('the baseline only shrinks: new violations are reported, fixed ones are dropped', () => {
  const before = [{ rule: 'r', from: 'a.ts', to: 'b.ts' }, { rule: 'r', from: 'c.ts', to: 'd.ts' }];
  const baseline = baselineFrom(before, 'test');
  assert.deepEqual(baseline.violations, { r: ['a.ts -> b.ts', 'c.ts -> d.ts'] });
  const now = [{ rule: 'r', from: 'a.ts', to: 'b.ts' }, { rule: 'r', from: 'e.ts', to: 'f.ts' }];
  const { fresh, fixed } = compareWithBaseline(now, baseline);
  assert.deepEqual(fresh, [{ rule: 'r', from: 'e.ts', to: 'f.ts' }]);
  assert.deepEqual(fixed, ['r|c.ts -> d.ts']);
});

check('a window re-exports only types from a store: values are violations, types of any spelling are not (ADR-0008 stage 3, S1)', () => {
  const root = tree({
    'src/mind/memory/memoryPorts.ts': [
      "export type { A } from './store/a.js';",
      "export { type B } from './store/b.js';",
      "import type { C } from './store/c.js';",
      "export { d } from './store/d.js';",
      "export * from './store/e.js';",
      "export { type F, g } from './store/f.js';",
      "export { h } from './h.js';",
      "export type { C };",
    ].join('\n'),
    'src/mind/memory/store/a.ts': 'export type A = 1;\n', 'src/mind/memory/store/b.ts': 'export type B = 1;\n', 'src/mind/memory/store/c.ts': 'export type C = 1;\n',
    'src/mind/memory/store/d.ts': 'export const d = 1;\n', 'src/mind/memory/store/e.ts': 'export const e = 1;\n',
    'src/mind/memory/store/f.ts': 'export type F = 1;\nexport const g = 1;\n', 'src/mind/memory/h.ts': 'export const h = 1;\n',
    'src/mind/recall/user.ts': "import { d } from '../memory/store/d.js';\n",
  });
  const typesOnly = { sourceRoot: 'src', rules: [{ id: 'ports-types-only-from-stores', kind: 'imports', from: ['mind/*/*Ports.ts'], to: ['**/store/**'], typesOnly: true }] };
  const found = violations({ root, config: typesOnly, moves: { entries: [], moves: {} } }).map(item => `${item.from} -> ${item.to}`);
  assert.deepEqual(found, [
    'mind/memory/memoryPorts.ts -> mind/memory/store/d.ts',
    'mind/memory/memoryPorts.ts -> mind/memory/store/e.ts',
    'mind/memory/memoryPorts.ts -> mind/memory/store/f.ts',
  ]);
  // Read from the syntax: a dynamic import is a value; an import type node and a type-only clause are not.
  assert.deepEqual([...valueSpecifiers("import type { A } from './a.js';\nimport { type B } from './b.js';\nimport { c, type C } from './c.js';\nimport './d.js';\nconst e = () => import('./e.js');\ntype F = import('./f.js').F;\n")].sort(),
    ['./c.js', './d.js', './e.js']);
});

check('a pair a rule allows by name is not a violation, and only that pair (ADR-0008 stage 3: a surface store may use infra/sqlite)', () => {
  const root = tree({
    'src/surfaces/body/store/bodyStore.ts': "import { open } from '../../../infra/sqlite/context.js';\n",
    'src/surfaces/body/bodyLook.ts': "import { open } from '../../infra/sqlite/context.js';\n",
    'src/surfaces/body/store/other.ts': "import { x } from '../../voice/store/voiceStore.js';\n",
    'src/surfaces/voice/store/voiceStore.ts': 'export const x = 1;\n',
    'src/infra/sqlite/context.ts': 'export const open = 1;\n',
  });
  const rules = { sourceRoot: 'src', rules: [{ id: 'surfaces-without-stores', kind: 'imports', from: ['surfaces/**'], to: ['**/store/**', 'infra/sqlite/**'], crossComponent: true,
    allowPairs: [{ from: ['surfaces/*/store/**'], to: ['infra/sqlite/**'] }] }] };
  const found = violations({ root, config: rules, moves: { entries: [], moves: {} } }).map(item => `${item.from} -> ${item.to}`);
  assert.deepEqual(found, ['surfaces/body/bodyLook.ts -> infra/sqlite/context.ts', 'surfaces/body/store/other.ts -> surfaces/voice/store/voiceStore.ts']);
});

check('a counted rule records one entry per file whose count may fall but never rise (ADR-0009 stage 1)', () => {
  const root = tree({
    'src/wiring/a.ts': "db.prepare('SELECT 1');\ndb.prepare('SELECT 2');\n/x/.exec(text);\n",
    'src/wiring/b.ts': "db.exec('PRAGMA foreign_keys=ON');\n",
    'src/mind/action/threads/store/actionStore.ts': "db.prepare('SELECT * FROM mind_actions');\n",
  });
  const rule = { id: 'no-sql-in-wiring', kind: 'count', label: 'sql', from: ['wiring/**'], pattern: "\\.prepare\\(|\\.exec\\(\\s*[`'\"]" };
  const rules = { sourceRoot: 'src', rules: [rule] };
  const found = violations({ root, config: rules, moves: { entries: [], moves: {} } });
  assert.deepEqual(found.map(item => `${item.from} -> ${item.to}`), ['wiring/a.ts -> sql x2', 'wiring/b.ts -> sql x1']);
  const baseline = baselineFrom([{ rule: 'no-sql-in-wiring', from: 'wiring/a.ts', to: 'sql x3' }], 'test');
  const lower = compareWithBaseline(found, baseline);
  assert.deepEqual(lower.fresh.map(item => item.from), ['wiring/b.ts']);
  assert.deepEqual(lower.fixed, ['no-sql-in-wiring|wiring/a.ts -> sql x3']);
  const higher = compareWithBaseline(found, baselineFrom([{ rule: 'no-sql-in-wiring', from: 'wiring/a.ts', to: 'sql x1' }], 'test'));
  assert.ok(higher.fresh.some(item => item.from === 'wiring/a.ts'));
});
