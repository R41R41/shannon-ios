import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { baselineFrom, compareWithBaseline, componentOf, globRegExp, violations } from './check-api-layers.mjs';

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

test('globs: one segment, any depth, and module names', () => {
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

test('checks the projected layout: a flat file is judged at its target, and resolved imports of every kind count', () => {
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

test('the baseline only shrinks: new violations are reported, fixed ones are dropped', () => {
  const before = [{ rule: 'r', from: 'a.ts', to: 'b.ts' }, { rule: 'r', from: 'c.ts', to: 'd.ts' }];
  const baseline = baselineFrom(before, 'test');
  assert.deepEqual(baseline.violations, { r: ['a.ts -> b.ts', 'c.ts -> d.ts'] });
  const now = [{ rule: 'r', from: 'a.ts', to: 'b.ts' }, { rule: 'r', from: 'e.ts', to: 'f.ts' }];
  const { fresh, fixed } = compareWithBaseline(now, baseline);
  assert.deepEqual(fresh, [{ rule: 'r', from: 'e.ts', to: 'f.ts' }]);
  assert.deepEqual(fixed, ['r|c.ts -> d.ts']);
});
