import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * scripts/sync-body-produced.sh against throwaway git repositories (a fake body, a fake head). It needs bash, git, sha256sum: the PC's WSL and Git Bash
 * have them, a bare Windows shell does not, so the suite skips there (the syntax check in continueVerifyScripts.test.ts still says whether the file parses).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(root, 'scripts', 'sync-body-produced.sh');
const have = (command: string) => spawnSync('bash', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
const available = have('git') && have('sha256sum') && have('grep');

const FIXTURE = 'result/r43-reflex-ate-first.json';
const FIX = 'services/api/tests/fixtures/continue';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};
const put = (dir: string, path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };

function produced(bodyRev: string, inputSha256: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ continueProduced: { bodyRev, script: 'backend/scripts/lab/continue-produce.ts', bench: 'build', inputFixture: inputSha256 ? FIXTURE : undefined, inputSha256: inputSha256 ?? undefined }, receipt: { id: 'skill:q1' }, ...extra }, null, 1);
}

interface Repos { head: string; body: string; fixtureSha: string; first: string }
/** A head with one fixture, and a body with a code commit (`first`) the produced files will name. */
function repos(): Repos {
  const base = mkdtempSync(join(tmpdir(), 'sync-produced-')), head = join(base, 'head'), body = join(base, 'body');
  const fixtureText = '{"contract":"result","scene":"x"}\n';
  put(head, `${FIX}/${FIXTURE}`, fixtureText);
  mkdirSync(body, { recursive: true });
  git(body, 'init', '-q');
  put(body, 'backend/src/code.ts', 'export const a = 1;\n');
  put(body, 'backend/package.json', '{}\n');
  git(body, 'add', '-A'); git(body, 'commit', '-q', '-m', 'code');
  return { head, body, fixtureSha: sha(fixtureText), first: git(body, 'rev-parse', 'HEAD') };
}
const commitProduced = (body: string, files: Record<string, string>, message = 'produced'): string => {
  for (const [name, text] of Object.entries(files)) put(body, `backend/contracts/continue/produced/${name}`, text);
  git(body, 'add', '-A'); git(body, 'commit', '-q', '-m', message);
  return git(body, 'rev-parse', 'HEAD');
};
const run = (r: Repos, rev: string, ...extra: string[]) =>
  spawnSync('bash', [script, rev, '--body-repo', r.body, '--head-repo', r.head, ...extra], { encoding: 'utf8' });
const destDir = (r: Repos) => join(r.head, FIX, 'produced');

describe.skipIf(!available)('scripts/sync-body-produced.sh', () => {
  it('copies the files of a rev whose files name the code it was made from, and writes PRODUCED.json', () => {
    const r = repos();
    const second = commitProduced(r.body, { 'r43.json': produced(r.first, r.fixtureSha), 'catalog.json': produced(r.first, null) });   // the files cannot name their own commit: they name the code commit
    const result = run(r, second.slice(0, 10));                                                                                            // a short rev is read
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(destDir(r), 'r43.json'), 'utf8')).toContain(r.first);
    const index = JSON.parse(readFileSync(join(destDir(r), 'PRODUCED.json'), 'utf8')) as { bodyRev: string; madeBy: string; files: Record<string, string> };
    expect(index.bodyRev).toBe(second);
    expect(index.madeBy).toBe(r.first);
    expect(Object.keys(index.files)).toEqual(['catalog.json', 'r43.json']);
    expect(index.files['r43.json']).toBe(sha(readFileSync(join(destDir(r), 'r43.json'), 'utf8')));
  });

  it('is a fail, and copies nothing, when a file was made by a body whose code differs', () => {
    const r = repos();
    put(r.body, 'backend/src/code.ts', 'export const a = 2;\n'); git(r.body, 'add', '-A'); git(r.body, 'commit', '-q', '-m', 'newer code');
    const second = commitProduced(r.body, { 'r43.json': produced(r.first, r.fixtureSha) });
    const result = run(r, second);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another version is a fail');
    expect(existsSync(destDir(r))).toBe(false);
  });

  it('leaves the directory that was there when a sync fails', () => {
    const r = repos();
    const good = commitProduced(r.body, { 'r43.json': produced(r.first, r.fixtureSha) });
    expect(run(r, good).status).toBe(0);
    const before = readFileSync(join(destDir(r), 'PRODUCED.json'), 'utf8');
    const bad = commitProduced(r.body, { 'r43.json': produced(r.first, 'f'.repeat(64)) });
    const result = run(r, bad);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another');
    expect(readFileSync(join(destDir(r), 'PRODUCED.json'), 'utf8')).toBe(before);
  });

  it('is a fail when the files come from two different runs', () => {
    const r = repos();
    put(r.body, 'backend/src/other.ts', 'export const b = 1;\n'); git(r.body, 'add', '-A'); git(r.body, 'commit', '-q', '-m', 'second code');
    const mid = git(r.body, 'rev-parse', 'HEAD');
    const tip = commitProduced(r.body, { 'a.json': produced(r.first, r.fixtureSha), 'b.json': produced(mid, r.fixtureSha) });
    const result = run(r, tip);
    expect(result.status).toBe(1);
    expect(existsSync(destDir(r))).toBe(false);
  });

  it('is a fail when the body has no produced files, names no body, or lists a fixture without its sha256', () => {
    const r = repos();
    expect(run(r, r.first).stderr).toContain('has no backend/contracts/continue/produced/');
    const noRev = commitProduced(r.body, { 'x.json': JSON.stringify({ receipt: {} }) });
    expect(run(r, noRev).stderr).toContain('does not say which body made it');
    const noSha = commitProduced(r.body, { 'x.json': JSON.stringify({ continueProduced: { bodyRev: r.first, inputFixture: FIXTURE } }) });
    expect(run(r, noSha).stderr).toContain('not its sha256');
    expect(existsSync(destDir(r))).toBe(false);
  });

  it('refuses a branch name, an unknown rev, and a fixture path that climbs out', () => {
    const r = repos();
    expect(run(r, 'main').stderr).toContain('not a hex git revision');
    expect(run(r, 'deadbeef').status).toBe(1);
    const climb = commitProduced(r.body, { 'x.json': JSON.stringify({ continueProduced: { bodyRev: r.first, inputFixture: '../../x.json', inputSha256: 'a' } }) });
    expect(run(r, climb).stderr).toContain('not a plain relative path');
  });

  it('a file the body no longer has goes away with the next sync', () => {
    const r = repos();
    const one = commitProduced(r.body, { 'a.json': produced(r.first, r.fixtureSha), 'b.json': produced(r.first, null) });
    expect(run(r, one).status).toBe(0);
    git(r.body, 'rm', '-q', 'backend/contracts/continue/produced/b.json'); git(r.body, 'commit', '-q', '-m', 'drop b');
    expect(run(r, git(r.body, 'rev-parse', 'HEAD')).status).toBe(0);
    expect(existsSync(join(destDir(r), 'b.json'))).toBe(false);
    expect(existsSync(join(destDir(r), 'a.json'))).toBe(true);
  });
});
