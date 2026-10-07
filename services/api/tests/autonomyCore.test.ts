import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHANNON_CORE_AREA_LABELS } from '@shannon/cognition';
import { SHANNON_CORE_PATHS, allCorePaths, coreAreaForRepositoryPath, normalizedRepositoryPath } from '../src/mind/inhibition/autonomyCore.js';
import { apiSourceFilesNamed, apiSourcePath, repositoryPath, repositoryRoot } from './support/sources.js';

/** Every source file below a folder, recursively; `node_modules` (links of the workspace) left out. */
function filesBelow(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

/**
 * Files listed by name in another area than the directory that holds them (Syzygy ADR-0008 stage 2). Each is still core;
 * only its area differs from the area of its directory.
 */
// Review M3 lists the inhibition part by its folder (so a new file is covered at once); the two files of the activity record in
// it are listed there by name and keep their area.
const CORE_AREA_OVERRIDES: readonly string[] = [
  'packages/learning/src/difficultyPolicy.ts: emotion -> response_path',
  'services/api/src/mind/inhibition/autonomyDayLog.ts: approval_and_budget -> activity_record',
  'services/api/src/mind/inhibition/store/autonomyActivity.ts: approval_and_budget -> activity_record',
];

/**
 * The repository's tracked files, or why they cannot be listed here: git is not installed (the production VM has none), or the
 * folder is not inside a git work tree (a copied tree). Any other failure of git is an error of the test's world and is thrown,
 * with what git said.
 */
function trackedFiles(): { files: string[] } | { reason: string } {
  type GitResult = { output: string } | { missing: true } | { status: number | null; stderr: string };
  const git = (args: string[]): GitResult => {
    try {
      return { output: execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } }) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
      if (failure.code === 'ENOENT') return { missing: true };
      return { status: failure.status ?? null, stderr: String(failure.stderr ?? '').trim() };
    }
  };
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if ('missing' in inside) return { reason: 'git is not installed' };
  if ('stderr' in inside) {
    if (/not a git repository/iu.test(inside.stderr)) return { reason: `${repositoryRoot} is not a git repository` };
    throw new Error(`git rev-parse failed (status ${inside.status ?? 'none'}): ${inside.stderr}`);
  }
  if (inside.output.trim() !== 'true') return { reason: `${repositoryRoot} is not inside a git work tree` };
  const listed = git(['ls-files']);
  if ('missing' in listed) return { reason: 'git is not installed' };
  if ('stderr' in listed) throw new Error(`git ls-files failed (status ${listed.status ?? 'none'}): ${listed.stderr}`);
  return { files: listed.output.split('\n').filter(Boolean) };
}

describe('CORE as code', () => {
  it('covers the nine core areas of ADR-0002, each with at least one path', () => {
    expect(Object.keys(SHANNON_CORE_PATHS)).toEqual(Object.keys(SHANNON_CORE_AREA_LABELS));
    expect(Object.keys(SHANNON_CORE_PATHS)).toEqual([
      'purpose', 'persona', 'emotion', 'authentication', 'memory', 'approval_and_budget', 'activity_record', 'response_path', 'deployment',
    ]);
    for (const [area, paths] of Object.entries(SHANNON_CORE_PATHS)) expect(paths.length, area).toBeGreaterThan(0);
  });

  it('lists only paths that exist, so a rename has to update the map', () => {
    const missing = allCorePaths().filter(path => {
      const absolute = join(repositoryRoot, path);
      if (!existsSync(absolute)) return true;
      return path.endsWith('/') !== statSync(absolute).isDirectory();
    });
    expect(missing).toEqual([]);
  });

  it('lists every path once', () => {
    const paths = allCorePaths();
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('keeps every autonomy source file of the API inside core', () => {
    const sources = apiSourceFilesNamed(/^(?:autonomy|apiAutonomy).*\.ts$/u);
    // 48 today; the floor leaves room for a later merge or split, and still fails on a scan that finds little.
    expect(sources.length).toBeGreaterThanOrEqual(38);
    for (const path of sources) {
      expect(coreAreaForRepositoryPath(repositoryPath(path)), basename(path)).not.toBeNull();
    }
  });

  it('keeps the package and the files of Syzygy ADR-0008 stage 1 inside core', () => {
    // Whole folders, so a file added there later is core at once. A file listed by name in another area keeps that area
    // (stage 2: the difficulty policy is the response path's), and is still core.
    const listed = (file: string) => allCorePaths().some(path => path.toLowerCase() === file.toLowerCase());
    for (const [folder, area] of [['packages/learning', 'emotion'], ['services/api/src/mind/learning', 'emotion'], ['services/api/src/infra/models/jev', 'response_path']] as const) {
      const files = filesBelow(join(repositoryRoot, folder));
      expect(files.length, folder).toBeGreaterThan(0);
      for (const file of files) {
        const path = relative(repositoryRoot, file).split(sep).join('/');
        if (listed(path)) expect(coreAreaForRepositoryPath(path), file).not.toBeNull();
        else expect(coreAreaForRepositoryPath(path)?.area, file).toBe(area);
      }
      expect(coreAreaForRepositoryPath(`${folder}/someFutureFile.ts`)?.area, folder).toBe(area);
    }
    // Listed file by file: the folders they sit in are shared with the files the layout waves move there.
    const expected: Record<string, string> = {
      'services/api/src/mind/sleep/valueSleep.ts': 'emotion',
      'services/api/src/mind/emotion/rewardMood.ts': 'emotion',
      'services/api/src/wiring/cognitionLedgerWiring.ts': 'emotion',
      'services/api/src/wiring/cognitionLedgerTaps.ts': 'emotion',
      'services/api/src/contracts/cognitionLedgerContract.ts': 'emotion',
      'services/api/src/contracts/decisionTraceContract.ts': 'approval_and_budget',
      'services/api/src/mind/inhibition/decisionTraces.ts': 'approval_and_budget',
      'services/api/src/mind/inhibition/store/sqliteDecisionTraces.ts': 'approval_and_budget',
      'services/api/src/mind/inhibition/tracedVoiceDecision.ts': 'approval_and_budget',
      'services/api/src/surfaces/voice/transcriptionRoute.ts': 'response_path',
      'services/api/src/infra/http/learningRoutes.ts': 'response_path',
      'services/api/src/infra/sqlite/lockWaits.ts': 'memory',
      // Stage 2 (docs/skill-and-routing-contract.md).
      'services/api/src/infra/models/jev/jevChoice.ts': 'response_path',
      'services/api/src/mind/selectors/toolMenu.ts': 'response_path',
      'services/api/src/mind/selectors/turnChoices.ts': 'response_path',
      'services/api/src/mind/tools/shannonToolMenu.ts': 'response_path',
      'services/api/src/wiring/skillRoutingWiring.ts': 'response_path',
      'services/api/src/mind/tools/shannonReadTools.ts': 'approval_and_budget',
      'packages/learning/src/difficultyPolicy.ts': 'response_path',
      'services/api/src/infra/models/anthropic/anthropicChatModel.ts': 'response_path',
      'services/api/src/infra/models/tieredChatModel.ts': 'response_path',
      'services/api/src/wiring/sonnetWiring.ts': 'response_path',
      'services/api/package.json': 'deployment',
      'pnpm-lock.yaml': 'deployment',
      'services/api/src/mind/inhibition/inhibitionPorts.ts': 'approval_and_budget',
    };
    for (const [file, area] of Object.entries(expected)) expect(coreAreaForRepositoryPath(file)?.area, file).toBe(area);
  });

  it('keeps the parts and the package of Syzygy ADR-0008 stage 3 inside core, and the memory writer in memory', () => {
    // The pure rules of what she keeps and forgets are memory's, by name (F1).
    const MEMORY_RULES = ['evidenceDecay', 'identityTiers', 'temporalFacts', 'trustFold', 'compaction'].map(name => `packages/mind/src/${name}.ts`);
    for (const path of MEMORY_RULES) expect(coreAreaForRepositoryPath(path)?.area, path).toBe('memory');
    // The proactive gate at the delivery points is the guard's, by name (F4; the contract's table: core area "guard").
    const GUARD = ['services/api/src/mind/attention/proactiveDelivery.ts', 'services/api/src/mind/attention/store/proactiveTopicsStore.ts', 'services/api/src/wiring/proactiveGateWiring.ts'];
    for (const path of GUARD) expect(coreAreaForRepositoryPath(path)?.area, path).toBe('approval_and_budget');
    // Whole folders, so a file added there later is core at once (docs/mind-workspace-contract.md).
    for (const folder of ['packages/mind', 'services/api/src/mind/perception', 'services/api/src/mind/attention', 'services/api/src/mind/workspace']) {
      const files = filesBelow(join(repositoryRoot, folder));
      expect(files.length, folder).toBeGreaterThan(0);
      for (const file of files) {
        const path = relative(repositoryRoot, file).split(sep).join('/');
        expect(coreAreaForRepositoryPath(path)?.area, file).toBe(MEMORY_RULES.includes(path) ? 'memory' : GUARD.includes(path) ? 'approval_and_budget' : 'response_path');
      }
      expect(coreAreaForRepositoryPath(`${folder}/someFutureFile.ts`)?.area, folder).toBe('response_path');
    }
    // The outbox, its codec, its store and the one writer are memory's before they exist (the plan's paths, D).
    for (const file of ['memoryOutbox.ts', 'memoryOpCodec.ts', 'memoryWriter.ts', 'store/memoryOutboxStore.ts', 'store/memoryWriterState.ts']) {
      expect(coreAreaForRepositoryPath(`services/api/src/mind/memory/${file}`)?.area, file).toBe('memory');
    }
  });

  it('keeps the value table\'s command line inside core', () => {
    expect(coreAreaForRepositoryPath('services/api/scripts/shannon-values.ts')?.area).toBe('approval_and_budget');
    expect(coreAreaForRepositoryPath('scripts/shannon-values.sh')?.area).toBe('deployment');
  });

  it('matches files exactly and directories by prefix, ignoring case', () => {
    expect(coreAreaForRepositoryPath('packages/cognition/src/persona.ts')?.area).toBe('persona');
    expect(coreAreaForRepositoryPath('./packages//cognition/src/persona.ts')?.area).toBe('persona');
    expect(coreAreaForRepositoryPath('packages\\cognition\\src\\persona.ts')?.area).toBe('persona');
    expect(coreAreaForRepositoryPath('Packages/Cognition/src/PERSONA.ts')?.area).toBe('persona');
    expect(coreAreaForRepositoryPath('deploy/azure/shannon-ios.service')?.area).toBe('deployment');
    expect(coreAreaForRepositoryPath('deploy')?.area).toBe('deployment');
    expect(coreAreaForRepositoryPath('deployment-notes.md')).toBeNull();
    expect(coreAreaForRepositoryPath('packages/cognition/src/persona.ts.bak')).toBeNull();
    expect(coreAreaForRepositoryPath('tools/story-lab/run.mjs')).toBeNull();
    expect(coreAreaForRepositoryPath(apiSourcePath('autonomyActivity.ts'))?.area).toBe('activity_record');
    expect(coreAreaForRepositoryPath(apiSourcePath('autonomyPolicy.ts'))?.area).toBe('approval_and_budget');
    // Review M3: the files stage 2 added, and any new file of the memory and inhibition parts.
    for (const [path, area] of [
      ['services/api/src/mind/memory/skillMemoryParts.ts', 'memory'], ['services/api/src/mind/memory/skillLineage.ts', 'memory'],
      ['services/api/src/mind/memory/someFutureFile.ts', 'memory'], ['services/api/src/wiring/skillCopyWiring.ts', 'memory'],
      ['services/api/src/mind/inhibition/withheldActions.ts', 'approval_and_budget'], ['services/api/src/mind/inhibition/withheldRules.ts', 'approval_and_budget'],
      ['services/api/src/mind/inhibition/store/sqliteWithheldActions.ts', 'approval_and_budget'], ['services/api/src/mind/inhibition/someFutureFile.ts', 'approval_and_budget'],
      ['services/api/src/contracts/withheldActionContract.ts', 'approval_and_budget'], ['services/api/src/wiring/withheldWiring.ts', 'approval_and_budget'],
    ] as const) expect(coreAreaForRepositoryPath(path)?.area, path).toBe(area);
  });

  it('only widens: every file of the repository keeps the area the first listed entry gives it, unless it is listed by name (ADR-0008 stage 2)', ({ skip }) => {
    // The list of files comes from git: where git or the repository is missing (the production VM has no git), the test is
    // skipped and says why, as the tests that read `apps/` are where it is missing.
    const listing = trackedFiles();
    if ('reason' in listing) return skip(`only widens: ${listing.reason}; run it in a checkout of the repository`);
    const tracked = listing.files;
    // The rule before stage 2: the first entry in the map's order that matches, a directory by prefix.
    const firstListed = (path: string) => {
      const normalized = normalizedRepositoryPath(path)!.toLowerCase();
      for (const [area, entries] of Object.entries(SHANNON_CORE_PATHS)) {
        for (const entry of entries) {
          const candidate = entry.toLowerCase();
          if (candidate.endsWith('/') ? normalized === candidate.slice(0, -1) || normalized.startsWith(candidate) : normalized === candidate) return area;
        }
      }
      return null;
    };
    expect(tracked.length).toBeGreaterThan(1_000);
    const exact = new Set(allCorePaths().filter(path => !path.endsWith('/')).map(path => path.toLowerCase()));
    const moved: string[] = [];
    for (const path of [...tracked, 'packages/learning/src/someFutureFile.ts', 'services/api/src/mind/learning/someFutureFile.ts', 'packages/mind/src/someFutureFile.ts',
      'services/api/src/mind/workspace/someFutureFile.ts', 'services/api/src/mind/memory/memoryWriter.ts']) {
      const before = firstListed(path);
      const now = coreAreaForRepositoryPath(path)?.area ?? null;
      // Whether a path is core never changes.
      expect(now === null, path).toBe(before === null);
      if (now !== before) {
        // Only a file listed by name inside a directory of another area changes area, to the area that lists it.
        expect(exact.has(path.toLowerCase()), path).toBe(true);
        moved.push(`${path}: ${before} -> ${now}`);
      }
    }
    expect(moved).toEqual(CORE_AREA_OVERRIDES);
  });

  it('rejects a path that is not inside the repository', () => {
    expect(normalizedRepositoryPath('../outside.ts')).toBeNull();
    expect(normalizedRepositoryPath('a/../../b')).toBeNull();
    expect(normalizedRepositoryPath('')).toBeNull();
    expect(coreAreaForRepositoryPath('../packages/cognition/src/persona.ts')).toBeNull();
  });
});
