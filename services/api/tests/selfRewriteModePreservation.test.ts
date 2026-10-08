import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
// A child owns its umask and builtin fault injection; Vitest workers and concurrent cases keep theirs unchanged.
const child = String.raw`
import fs from 'node:fs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { mask, mode, action } = JSON.parse(process.argv[1]);
process.umask(mask);
const root = fs.mkdtempSync(join(tmpdir(), 'shannon-rewrite-mode-'));
const isolated = join(root, 'isolated'); fs.mkdirSync(isolated);
const descriptors = [];
try {
  const paths = action === 'partial' ? [join(isolated, 'one.ts'), join(isolated, 'two.ts')] : [join(isolated, 'one.ts')];
  for (const [index, path] of paths.entries()) {
    if (mode !== null) { fs.writeFileSync(path, 'old'); fs.chmodSync(path, index === 1 ? 0o640 : mode); }
  }
  let outside = null;
  if (action === 'symlink') {
    outside = join(root, 'outside'); fs.mkdirSync(outside);
    const target = join(outside, 'protected.ts'); fs.writeFileSync(target, 'old'); fs.chmodSync(target, 0o640);
    fs.rmSync(paths[0]); fs.symlinkSync(target, paths[0]);
  }
  let collision = null;
  if (action === 'collision') {
    crypto.randomUUID = () => '00000000-0000-4000-8000-000000000001';
    collision = join(isolated, '.shannon-rewrite-' + crypto.randomUUID()); fs.writeFileSync(collision, 'other-file');
    syncBuiltinESMExports();
  }
  if (action === 'fchmod-failure' || action === 'partial') {
    const original = fs.fchmodSync;
    fs.fchmodSync = (fd, permissions) => {
      descriptors.push(fd);
      if (action === 'partial' && descriptors.length === 1) return original(fd, permissions);
      throw new Error('injected permission failure');
    };
    syncBuiltinESMExports();
  }
  if (action === 'fsync-failure') {
    fs.fsyncSync = fd => { descriptors.push(fd); throw new Error('injected flush failure'); };
    syncBuiltinESMExports();
  }
  const { applyIsolatedRewrite, selfRewriteTargets } = await import('./services/api/src/wiring/selfRewriteWiring.ts');
  const { selfRewriteContentHash, selfRewriteDiffHash } = await import('./services/api/src/mind/inhibition/selfRewriteService.ts');
  const files = paths.map(path => ({ path, beforeHash: mode === null ? null : selfRewriteContentHash('old'), content: 'new' }));
  const candidate = { schema: 'shannon.self-rewrite.v1', id: 'mode-candidate', workId: 'mode-work', scopeKey: 'owner',
    sourceId: 'original-task', origin: 'own_time', budgetLane: 'autonomy', baseRevision: 'original-base',
    diffHash: selfRewriteDiffHash(files), files };
  const places = { isolatedRoot: isolated, repositoryRoots: [], productionRoots: outside ? [outside] : [], protectedPaths: [] };
  const targets = selfRewriteTargets(candidate, places);
  if (!targets) throw new Error('fixture has no resolved targets');
  const result = await applyIsolatedRewrite(candidate, targets, places, async () => true);
  const read = path => ({ content: fs.readFileSync(path, 'utf8'), mode: fs.statSync(path).mode & 0o777 });
  const closed = descriptors.every(fd => { try { fs.fstatSync(fd); return false; } catch (error) { return error.code === 'EBADF'; } });
  console.log(JSON.stringify({ result, files: paths.map(read), closed,
    temporary: fs.readdirSync(isolated).filter(name => name.startsWith('.shannon-rewrite-')),
    collision: collision ? fs.readFileSync(collision, 'utf8') : null,
    symlink: action === 'symlink' && fs.lstatSync(paths[0]).isSymbolicLink() }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
`;

interface Result {
  result: 'completed' | 'failed' | 'unknown'; files: { content: string; mode: number }[];
  closed: boolean; temporary: string[]; collision: string | null; symlink: boolean;
}
function run(mask: number, mode: number | null, action = 'rewrite'): Result {
  const originalMask = process.umask();
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', child, '--',
    JSON.stringify({ mask, mode, action })], { cwd: repository, encoding: 'utf8', timeout: 20_000 });
  expect(process.umask()).toBe(originalMask);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as Result;
}

describe.each([0o022, 0o077])('actual isolated rewrite with child umask %i', mask => {
  it.each([0o755, 0o640, 0o600])('preserves original mode %i through atomic replacement', mode => {
    expect(run(mask, mode)).toMatchObject({ result: 'completed', files: [{ content: 'new', mode }], temporary: [] });
  });
  it('creates a new file as 0600', () => {
    expect(run(mask, null)).toMatchObject({ result: 'completed', files: [{ content: 'new', mode: 0o600 }], temporary: [] });
  });
});

describe('isolated rewrite failure and physical boundary retention', () => {
  it.each(['fchmod-failure', 'fsync-failure'])('closes its descriptor and removes its temp on %s before replacement', action => {
    expect(run(0o077, 0o755, action)).toMatchObject({ result: 'failed', files: [{ content: 'old', mode: 0o755 }], closed: true, temporary: [] });
  });
  it('retains unknown after one replacement, keeps the second original and cleans the failed temp', () => {
    expect(run(0o077, 0o755, 'partial')).toMatchObject({ result: 'unknown',
      files: [{ content: 'new', mode: 0o755 }, { content: 'old', mode: 0o640 }], closed: true, temporary: [] });
  });
  it('keeps an existing temp collision untouched when exclusive creation refuses it', () => {
    const result = run(0o077, 0o640, 'collision');
    expect(result).toMatchObject({ result: 'failed', files: [{ content: 'old', mode: 0o640 }], collision: 'other-file' });
    expect(result.temporary).toHaveLength(1);
  });
  it('refuses a symlink into production and retains its target content, mode and link', () => {
    expect(run(0o077, 0o640, 'symlink')).toMatchObject({ result: 'failed', files: [{ content: 'old', mode: 0o640 }], symlink: true, temporary: [] });
  });
});
