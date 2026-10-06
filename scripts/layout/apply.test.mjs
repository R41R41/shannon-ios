import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';

// Without node_modules (no typescript) the tests are skipped, and say so, rather than failing the fast lane.
let typescriptFound = true;
try { await import('typescript'); } catch { typescriptFound = false; }
const skip = typescriptFound ? false : 'the typescript package cannot be found (no node_modules)';
const check = (name, body) => test(name, { skip }, body);

const script = resolve(import.meta.dirname, 'apply.mjs');
const directories = [];
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

/** A small repository with the shapes the real one has: an entry, a core map, tests, a URL relative to a module. */
function repository({ coreEntries = [], moves }) {
  const root = mkdtempSync(join(tmpdir(), 'shannon-layout-'));
  directories.push(root);
  const files = {
    'services/api/src/server.ts': "import { a } from './a.js';\nimport type { B } from './b.js';\nexport const run = () => a;\nexport const worker = new URL('./b.js', import.meta.url);\n",
    'services/api/src/a.ts': [
      "import { b } from './b.js';",
      "export { c } from './c.js';",
      "// import { nothing } from './b.js';",
      "const text = \"from './b.js'\";",
      "export type Later = typeof import('./c.js');",
      "export const lazy = () => import('./c.js');",
      "export const database = new URL('../../../data/x.sqlite', import.meta.url);",
      'export const a = b + text;',
      '',
    ].join('\n'),
    'services/api/src/b.ts': 'export const b = 1;\nexport type B = number;\n',
    'services/api/src/c.ts': 'export const c = 2;\n',
    'services/api/src/old/d.ts': "import { b } from '../b.js';\nexport const d = b;\n",
    'services/api/src/autonomyCore.ts': [
      'export const SHANNON_CORE_PATHS = Object.freeze({',
      '  memory: Object.freeze([',
      "    'services/api/src/a.ts',",
      "    'services/api/src/autonomyCore.ts',",
      ...coreEntries.map(entry => `    '${entry}',`),
      '  ]),',
      '});',
      '',
    ].join('\n'),
    'services/api/tests/a.test.ts': "import { a } from '../src/a.js';\nvi.mock('../src/b.js');\nconst source = new URL('../src/c.ts', import.meta.url);\nconst folder = new URL('../src/', import.meta.url);\nexport { a, source, folder };\n",
    'packages/tool/src/reader.ts': "import { c } from '../../../services/api/src/c.js';\nexport const read = c;\n",
    'docs/notes.md': 'See services/api/src/b.ts for b.\n',
    'docs/evidence.json': '{ "evidence": ["services/api/src/b.ts#b"] }\n',
    'scripts/layout/moves.json': JSON.stringify({
      schemaVersion: 1, sourceRoot: 'services/api/src', entries: ['server.ts'], minimumCoreEntries: 2, pathDataFiles: ['docs/evidence.json'],
      waves: { 1: 'first', 2: 'second' }, moves,
    }, null, 2),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  const read = path => readFileSync(join(root, path), 'utf8');
  return { root, git, run, read };
}

const MOVES = {
  'a.ts': { to: 'mind/x/a.ts', wave: 1 },
  'b.ts': { to: 'infra/y/b.ts', wave: 1 },
  'c.ts': { to: 'surfaces/z/c.ts', wave: 2 },
  'd.ts': { to: 'mind/x/d.ts', wave: 2 },
};

check('a wave moves its files with git and rewrites every specifier that leads to them or out of them', () => {
  const repo = repository({ moves: MOVES });
  const result = repo.run('--wave', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /moved 2 files/u);
  assert.ok(existsSync(join(repo.root, 'services/api/src/mind/x/a.ts')));
  assert.ok(!existsSync(join(repo.root, 'services/api/src/a.ts')));
  assert.match(repo.git('status', '--porcelain'), /^R {2}services\/api\/src\/b\.ts -> services\/api\/src\/infra\/y\/b\.ts$/mu);

  const moved = repo.read('services/api/src/mind/x/a.ts');
  assert.match(moved, /^import \{ b \} from '\.\.\/\.\.\/infra\/y\/b\.js';$/mu);
  assert.match(moved, /^export \{ c \} from '\.\.\/\.\.\/c\.js';$/mu);
  assert.match(moved, /typeof import\('\.\.\/\.\.\/c\.js'\)/u);
  assert.match(moved, /=> import\('\.\.\/\.\.\/c\.js'\)/u);
  assert.match(moved, /new URL\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/data\/x\.sqlite', import\.meta\.url\)/u);
  // A comment and a string are not specifiers.
  assert.match(moved, /\/\/ import \{ nothing \} from '\.\/b\.js';/u);
  assert.match(moved, /"from '\.\/b\.js'"/u);

  // A URL to the module x.js follows x.ts.
  assert.equal(repo.read('services/api/src/server.ts'), "import { a } from './mind/x/a.js';\nimport type { B } from './infra/y/b.js';\nexport const run = () => a;\nexport const worker = new URL('./infra/y/b.js', import.meta.url);\n");
  assert.match(repo.read('services/api/src/old/d.ts'), /from '\.\.\/infra\/y\/b\.js'/u);
  const test = repo.read('services/api/tests/a.test.ts');
  assert.match(test, /from '\.\.\/src\/mind\/x\/a\.js'/u);
  assert.match(test, /vi\.mock\('\.\.\/src\/infra\/y\/b\.js'\)/u);
  assert.match(test, /new URL\('\.\.\/src\/c\.ts'/u);
  assert.match(test, /new URL\('\.\.\/src\/', import\.meta\.url\)/u);
  // The core map follows the moved file; prose is listed, not rewritten.
  assert.match(repo.read('services/api/src/autonomyCore.ts'), /'services\/api\/src\/mind\/x\/a\.ts',/u);
  assert.equal(repo.read('docs/notes.md'), 'See services/api/src/b.ts for b.\n');
  // A path-data file names files a check verifies: it is rewritten like the core map.
  assert.equal(repo.read('docs/evidence.json'), '{ "evidence": ["services/api/src/infra/y/b.ts#b"] }\n');
  assert.match(result.stdout, /mentions of moved paths in 1 files left as they are/u);
});

check('a wave is idempotent, and the next wave builds on it, also across packages', () => {
  const repo = repository({ moves: MOVES });
  assert.equal(repo.run('--wave', '1').status, 0);
  repo.git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'wave 1');
  const again = repo.run('--wave', '1');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /moved 0 files, rewrote 0 specifiers/u);
  assert.equal(repo.git('status', '--porcelain'), '');

  const second = repo.run('--wave', '2', '--rewrite-mentions');
  assert.equal(second.status, 0, second.stderr);
  assert.match(repo.read('services/api/src/mind/x/a.ts'), /^export \{ c \} from '\.\.\/\.\.\/surfaces\/z\/c\.js';$/mu);
  assert.match(repo.read('services/api/src/mind/x/d.ts'), /from '\.\.\/\.\.\/infra\/y\/b\.js'/u);
  assert.match(repo.read('packages/tool/src/reader.ts'), /from '\.\.\/\.\.\/\.\.\/services\/api\/src\/surfaces\/z\/c\.js'/u);
  assert.match(repo.read('services/api/tests/a.test.ts'), /new URL\('\.\.\/src\/surfaces\/z\/c\.ts'/u);
});

check('replays every wave up to one on a tree that has none of them', () => {
  const repo = repository({ moves: MOVES });
  const result = repo.run('--through', '2');
  assert.equal(result.status, 0, result.stderr);
  for (const path of ['mind/x/a.ts', 'infra/y/b.ts', 'surfaces/z/c.ts', 'mind/x/d.ts']) assert.ok(existsSync(join(repo.root, 'services/api/src', path)), path);
});

check('a dry run touches nothing', () => {
  const repo = repository({ moves: MOVES });
  const result = repo.run('--wave', '1', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would move 2 files/u);
  assert.equal(repo.git('status', '--porcelain'), '');
});

check('refuses a move that would change the set of core files, before touching the disk', () => {
  // A directory entry covers d.ts; moving d.ts out of it would take it out of core.
  const repo = repository({ coreEntries: ['services/api/src/old/'], moves: MOVES });
  assert.equal(repo.run('--wave', '1').status, 0);
  repo.git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'wave 1');
  const result = repo.run('--wave', '2');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core set would change in wave 2[\s\S]*no longer core: services\/api\/src\/mind\/x\/d\.ts/u);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.ok(existsSync(join(repo.root, 'services/api/src/old/d.ts')));
});

check('refuses to move an entry file, to rename a file, or to run on a tree with changes', () => {
  const entry = repository({ moves: { 'server.ts': { to: 'infra/server.ts', wave: 1 } } });
  assert.match(entry.run('--wave', '1').stderr, /moves the entry file server\.ts/u);
  const rename = repository({ moves: { 'a.ts': { to: 'mind/x/renamed.ts', wave: 1 } } });
  assert.match(rename.run('--wave', '1').stderr, /a move keeps the basename/u);
  const dirty = repository({ moves: MOVES });
  writeFileSync(join(dirty.root, 'services/api/src/b.ts'), 'export const b = 3;\n');
  assert.match(dirty.run('--wave', '1').stderr, /working tree has changes/u);
});

check('works on tracked files only: refuses to move an untracked file, and to run beside untracked code', () => {
  const untrackedMove = repository({ moves: { ...MOVES, 'e.ts': { to: 'mind/x/e.ts', wave: 1 } } });
  writeFileSync(join(untrackedMove.root, 'services/api/src/e.ts'), 'export const e = 1;\n');
  const refused = untrackedMove.run('--wave', '1', '--allow-untracked');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /moves services\/api\/src\/e\.ts, which git does not track/u);
  assert.equal(untrackedMove.git('status', '--porcelain'), '?? services/api/src/e.ts\n');

  const stray = repository({ moves: MOVES });
  writeFileSync(join(stray.root, 'services/api/tests/new.test.ts'), "import { b } from '../src/b.js';\n");
  const result = stray.run('--wave', '1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Untracked code would not be rewritten: services\/api\/tests\/new\.test\.ts/u);
  assert.match(stray.run('--wave', '1', '--dry-run').stderr, /warning: Untracked code/u);
  // With --allow-untracked the wave runs, rewrites and stages tracked files only, and leaves the stray file as it was.
  const allowed = stray.run('--wave', '1', '--allow-untracked');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(stray.read('services/api/tests/new.test.ts'), "import { b } from '../src/b.js';\n");
  assert.match(stray.git('status', '--porcelain'), /^\?\? services\/api\/tests\/new\.test\.ts$/mu);
});
