import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate } from '../../../tools/continue-verify/scenes/generate.js';
import { judge, loadFixtures, loadFolder } from '../../../tools/continue-verify/judge.js';

/**
 * The shell parts of the end-to-end checks (tools/continue-verify/*.sh, the local-gate patch) and the generated scenes. Nothing here reaches a VM: the
 * remote parts are only printed (their dry run). They need bash and git; the suite skips where there is no bash.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const verify = join(root, 'tools', 'continue-verify');
const have = (command: string) => spawnSync('bash', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
const bash = have('git') && have('sha256sum');
const sh = (args: string[], cwd?: string) => spawnSync('bash', args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
const fixtures = loadFixtures();

describe('the scenes (tools/continue-verify/scenes/) are what the contract says', () => {
  it('are current: generate() gives exactly the files on disk, one for each boundary (but 8), seam and boundary-8 scene', () => {
    const files = generate();
    const names = Object.keys(files).filter(name => name !== 'index.json').sort();
    expect(names).toHaveLength(9 + 8 + 7);
    for (const [name, text] of Object.entries(files)) expect(readFileSync(join(verify, 'scenes', name), 'utf8'), `${name} is stale: run scenes/generate.ts`).toBe(text);
    expect(readdirSync(join(verify, 'scenes')).filter(name => name.endsWith('.json')).sort()).toEqual([...names, 'index.json'].sort());
  });
  it('copy the contract\'s own words and resolve every fixture reference to its value', () => {
    const five = JSON.parse(readFileSync(join(verify, 'scenes', 'boundary-5.json'), 'utf8')) as { benches: string[]; fixtures: string[]; contract: { pass: string[] } };
    const boundary = fixtures.boundaries.boundaries.find(item => item.n === 5)!;
    expect(five.benches).toEqual(boundary.benches);
    expect(five.fixtures).toEqual(boundary.fixtures);
    expect(five.contract.pass).toEqual(boundary.pass);
    const four = readFileSync(join(verify, 'scenes', 'boundary-4.json'), 'utf8');
    expect(four).toContain('"$ref": "control/r45-attack-waited-6-4s.json#input.act"');
    expect(four).toContain('"target": "#2601"');
    const eight = JSON.parse(readFileSync(join(verify, 'scenes', 'b8-lost-receipt.json'), 'utf8')) as { contract: { inject: string; corrections: number } };
    expect(eight.contract.corrections).toBe(1);
    expect(eight.contract.inject).toBe(fixtures.boundaries.boundary8Scenes[0].inject);
  });
});

describe.skipIf(!bash)('the shell scripts', () => {
  const scripts = ['collect.sh', 'run-boundary.sh', 'lib.sh'].map(name => join(verify, name)).concat(join(root, 'scripts', 'sync-body-produced.sh'));
  for (const script of scripts) it(`bash -n ${script.slice(root.length + 1)}`, () => {
    const result = sh(['-n', script]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(script, 'utf8')).not.toContain('\r');   // files that are streamed to a VM must be LF
  });

  const collect = (...args: string[]) => sh([join(verify, 'collect.sh'), ...args]);
  function localInputs() {
    const dir = mkdtempSync(join(tmpdir(), 'cv-collect-')), run = 'task-1';
    mkdirSync(join(dir, 'records', run), { recursive: true });
    writeFileSync(join(dir, 'records', run, 'events.jsonl'), '{"ev":"run","at":"2026-10-28T04:00:00.000Z"}\n');
    writeFileSync(join(dir, 'receipts.jsonl'), '');
    writeFileSync(join(dir, 'trace.jsonl'), '{"kind":"trace_open","at":"2026-10-28T04:00:00.000Z","source":"continuous"}\n');
    writeFileSync(join(dir, 'marks.json'), '{"deaths":[],"injections":[{"kind":"reconnect","at":"2026-10-28T04:00:05.000Z"}]}');
    return { dir, run, base: ['--scene', 'b8-reconnect', '--run', run, '--head-rev', 'abc1234', '--body-rev', 'def5678', '--benches', 'B,C',
      '--records-dir', join(dir, 'records'), '--receipts', join(dir, 'receipts.jsonl'), '--trace', join(dir, 'trace.jsonl'), '--marks', join(dir, 'marks.json')] };
  }
  it('collect.sh gathers the files into one folder that judge.ts reads (meta and marks merged)', () => {
    const { dir, base } = localInputs(), out = join(dir, 'out');
    const result = collect(...base, '--out', out);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['body-trace.jsonl', 'events.jsonl', 'marks.json', 'meta.json', 'receipts.jsonl']);
    const loaded = loadFolder(out);
    expect(loaded.meta).toMatchObject({ run: 'task-1', scene: 'b8-reconnect', benches: ['B', 'C'], headRev: 'abc1234', bodyRev: 'def5678' });
    expect(loaded.meta.injections).toEqual([{ kind: 'reconnect', at: '2026-10-28T04:00:05.000Z' }]);
    expect(loaded.trace).toHaveLength(1);
    // an empty folder of a run is not a pass
    expect(judge(loaded, fixtures).pass).toBe(false);
  });
  it('collect.sh refuses a bad scene, a bad revision, a branch for a revision, a non-empty folder and a missing file', () => {
    const { dir, base } = localInputs(), out = join(dir, 'out');
    const swap = (flag: string, value: string) => { const copy = [...base]; copy[copy.indexOf(flag) + 1] = value; return copy; };
    expect(collect(...swap('--scene', 'boundary-8'), '--out', out).stderr).toContain("--scene: 'boundary-8' is not valid");
    expect(collect(...swap('--scene', 'seam-9'), '--out', out).status).toBe(2);
    expect(collect(...swap('--body-rev', 'main'), '--out', out).stderr).toContain('--body-rev');
    expect(collect(...swap('--run', 'a b'), '--out', out).stderr).toContain('--run');
    expect(collect(...swap('--receipts', join(dir, 'nope.jsonl')), '--out', out).stderr).toContain('does not exist');
    mkdirSync(out); writeFileSync(join(out, 'x'), '');
    expect(collect(...base, '--out', out).stderr).toContain('is not empty');
  });
  it('collect.sh from a VM only prints the copies without --execute, and creates nothing', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'cv-vm-')), 'out');
    const result = collect('--scene', 'boundary-5', '--run', 'task-1', '--head-rev', 'abc1234', '--body-rev', 'def5678', '--benches', 'B,C', '--out', out,
      '--vm', 'lab@10.0.0.4', '--vm-records-dir', '/srv/lab/decision-records', '--vm-receipts', '/srv/lab/out/receipts.jsonl', '--vm-trace', '/srv/lab/out/body-trace.jsonl');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('scp -q -- lab@10.0.0.4:/srv/lab/decision-records/task-1/events.jsonl');
    expect(result.stdout).toContain('dry run');
    expect(existsSync(out)).toBe(false);
  });
  it('collect.sh refuses a VM path that could carry a command', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'cv-vm-')), 'out');
    const result = collect('--scene', 'boundary-5', '--run', 'task-1', '--head-rev', 'abc1234', '--body-rev', 'def5678', '--benches', 'B', '--out', out,
      '--vm', 'lab@10.0.0.4', '--vm-records-dir', '/srv/x; rm -rf ~', '--vm-receipts', '/a', '--vm-trace', '/b');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('a VM path');
  });

  const runBoundary = (...args: string[]) => sh([join(verify, 'run-boundary.sh'), ...args]);
  const flags = ['--scene', 'b8-reconnect', '--head-rev', 'abc1234', '--body-rev', 'def5678', '--out', '/tmp/never-written', '--vm', 'lab@10.0.0.4', '--vm-head-dir', '/srv/head',
    '--vm-body-dir', '/srv/body', '--vm-runner', '/srv/lab/run-bench.sh', '--vm-out', '/srv/lab/out', '--run', 'task-1'];
  it('run-boundary.sh prints the steps and the remote script and runs nothing without --execute', () => {
    const result = runBoundary(...flags);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('git -C /srv/head checkout --quiet --detach abc1234');
    expect(result.stdout).toContain('git -C /srv/body checkout --quiet --detach def5678');
    expect(result.stdout).toContain('/srv/lab/run-bench.sh B ~/.continue-verify-scene.json /srv/lab/out');
    expect(result.stdout).toContain('/srv/lab/run-bench.sh C ');
    expect(result.stdout).toContain('dry run: nothing was run');
    expect(existsSync('/tmp/never-written')).toBe(false);
  });
  it('run-boundary.sh refuses a value that is not what it says it is', () => {
    const swap = (flag: string, value: string) => { const copy = [...flags]; copy[copy.indexOf(flag) + 1] = value; return copy; };
    expect(runBoundary(...swap('--vm-head-dir', '/srv/head; reboot')).status).toBe(2);
    expect(runBoundary(...swap('--scene', 'b8-nothing')).stderr).toContain('scenes/b8-nothing.json');
    expect(runBoundary(...swap('--head-rev', 'origin/main')).stderr).toContain('--head-rev');
    expect(runBoundary(...swap('--vm', 'lab 10.0.0.4')).stderr).toContain('--vm');
    expect(runBoundary(...flags.slice(0, -2)).stderr).toContain('missing --run');
  });
});

// ---- the patch to Syzygy's local-gate.sh (stage 5) ----------------------------------------------------------------------------------------------------
const GATE = ['/mnt/c/Shannon/Syzygy/tools/shannon-release/local-gate.sh', 'C:/Shannon/Syzygy/tools/shannon-release/local-gate.sh', process.env.SYZYGY_GATE ?? ''].find(path => path && existsSync(path));
describe.skipIf(!bash || !GATE)('local-gate-stage5.patch (applied to a copy of Syzygy\'s local-gate.sh; skipped where that file is not on this machine)', () => {
  const patchPath = join(verify, 'local-gate-stage5.patch');
  const FIX = 'services/api/tests/fixtures/continue';
  const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const put = (dir: string, path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  function patchedGate(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gate-')), target = join(dir, 'tools', 'shannon-release');
    mkdirSync(target, { recursive: true });
    copyFileSync(GATE!, join(target, 'local-gate.sh'));
    const applied = spawnSync('patch', ['-p1', '-i', patchPath], { cwd: dir, encoding: 'utf8' });
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(sh(['-n', join(target, 'local-gate.sh')]).status).toBe(0);
    return join(target, 'local-gate.sh');
  }
  function pair(options: { produce?: boolean; produced?: boolean; headCopy?: 'same' | 'other' | 'none'; docs?: 'same' | 'other' | 'none' | 'head-only'; made?: 'same' | 'code-changed' } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'gate-repos-')), head = join(base, 'head'), body = join(base, 'body');
    for (const dir of [head, body]) { mkdirSync(dir); git(dir, 'init', '-q'); }
    const fixtureText = '{"contract":"result"}\n';
    put(head, `${FIX}/result/a.json`, fixtureText);
    if (options.docs !== 'none') { put(head, 'docs/continue-contracts.md', '# contract\n'); put(head, `${FIX}/manifest.json`, '{"version":"3.1"}\n'); }
    git(head, 'add', '-A'); git(head, 'commit', '-q', '-m', 'head');
    put(body, 'backend/src/code.ts', 'export const a = 1;\n'); put(body, 'backend/package.json', '{}\n');
    if (options.docs !== 'none' && options.docs !== 'head-only') {
      put(body, 'docs/continue-contracts.md', options.docs === 'other' ? '# contract 2\n' : '# contract\n'); put(body, 'backend/tests/fixtures/continue/manifest.json', '{"version":"3.1"}\n');
    }
    if (options.produce) put(body, 'backend/scripts/lab/continue-produce.ts', '// produces\n');
    git(body, 'add', '-A'); git(body, 'commit', '-q', '-m', 'code');
    const code = git(body, 'rev-parse', 'HEAD');
    if (options.made === 'code-changed') { put(body, 'backend/src/code.ts', 'export const a = 2;\n'); git(body, 'add', '-A'); git(body, 'commit', '-q', '-m', 'newer code'); }
    const sha = (text: string) => spawnSync('sha256sum', { input: text, encoding: 'utf8' }).stdout.split(' ')[0];
    const producedText = JSON.stringify({ continueProduced: { bodyRev: code, inputFixture: 'result/a.json', inputSha256: sha(fixtureText) }, receipt: {} });
    if (options.produced) { put(body, 'backend/contracts/continue/produced/a.json', producedText); git(body, 'add', '-A'); git(body, 'commit', '-q', '-m', 'produced'); }
    if (options.headCopy && options.headCopy !== 'none') { put(head, `${FIX}/produced/a.json`, options.headCopy === 'same' ? producedText : `${producedText} `); git(head, 'add', '-A'); git(head, 'commit', '-q', '-m', 'sync'); }
    return { head, body, headRev: git(head, 'rev-parse', 'HEAD'), bodyRev: git(body, 'rev-parse', 'HEAD') };
  }
  const gate = (script: string, repos: { head: string; body: string; headRev: string; bodyRev: string }) =>
    spawnSync('bash', [script, 'produced', repos.head, repos.headRev, repos.bodyRev], { encoding: 'utf8', env: { ...process.env, GATE_BODY_REPO: repos.body } });

  it('applies cleanly, parses, and keeps the temporary exception labelled as temporary', () => {
    const script = patchedGate();
    expect(readFileSync(script, 'utf8')).toContain('TEMPORARY');
    expect(readFileSync(script, 'utf8')).toContain('DELETE this branch');
  });
  it('is only a warning while the body has no continue-produce.ts (unimplemented), and says so', () => {
    const result = gate(patchedGate(), pair());
    expect(result.stdout).toContain('CONTINUE_PRODUCED=unimplemented');
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it('fails (absent) once the body has the script but no produced files', () => {
    const result = gate(patchedGate(), pair({ produce: true }));
    expect(result.stdout).toContain('CONTINUE_PRODUCED=absent');
    expect(result.status).toBe(1);
  });
  it('passes when the produced files are current and the head has the same copy', () => {
    const result = gate(patchedGate(), pair({ produce: true, produced: true, headCopy: 'same' }));
    expect(result.stdout).toContain('CONTINUE_PRODUCED=ok');
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it('fails when the head\'s copy differs, or the head has none', () => {
    const script = patchedGate();
    expect(gate(script, pair({ produce: true, produced: true, headCopy: 'other' })).status).toBe(1);
    const none = gate(script, pair({ produce: true, produced: true, headCopy: 'none' }));
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('sync-body-produced.sh');
  });
  it('fails (stale) when the body\'s code moved after the files were made', () => {
    const result = gate(patchedGate(), pair({ produce: true, produced: true, headCopy: 'same', made: 'code-changed' }));
    expect(result.stdout).toContain('CONTINUE_PRODUCED=stale');
    expect(result.status).toBe(1);
  });
  it('skips the comparison when neither side has the contract yet, and fails when only one side has it', () => {
    const neither = gate(patchedGate(), pair({ docs: 'none' }));
    expect(neither.stdout).toContain('on neither side');
    expect(neither.status, neither.stdout).toBe(0);
    const one = gate(patchedGate(), pair({ docs: 'head-only' }));
    expect(one.stdout).toContain('only one side has the contract file');
    expect(one.status).toBe(1);
  });
  it('fails when the two copies of the contract differ', () => {
    const result = gate(patchedGate(), pair({ produce: true, produced: true, headCopy: 'same', docs: 'other' }));
    expect(result.stdout).toContain('(5d)');
    expect(result.status).toBe(1);
  });
});
