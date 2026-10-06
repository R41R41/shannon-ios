import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHANNON_CORE_AREA_LABELS } from '@shannon/cognition';
import { SHANNON_CORE_PATHS, allCorePaths, coreAreaForRepositoryPath, normalizedRepositoryPath } from '../src/autonomyCore.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

/** Every source file below a folder, recursively; `node_modules` (links of the workspace) left out. */
function filesBelow(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
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
    const sources = readdirSync(join(repositoryRoot, 'services/api/src'))
      .filter(name => /^(?:autonomy|apiAutonomy).*\.ts$/u.test(name));
    expect(sources.length).toBeGreaterThanOrEqual(11);
    for (const name of sources) {
      expect(coreAreaForRepositoryPath(`services/api/src/${name}`), name).not.toBeNull();
    }
  });

  it('keeps the folders of Syzygy ADR-0008 inside core, every file below them included', () => {
    const expected: Record<string, string> = {
      'packages/learning/': 'emotion',
      'services/api/src/mind/learning/': 'emotion',
      'services/api/src/mind/sleep/': 'emotion',
      'services/api/src/mind/inhibition/': 'approval_and_budget',
      'services/api/src/infra/models/jev/': 'response_path',
      'services/api/src/surfaces/voice/': 'response_path',
      'services/api/src/infra/http/': 'response_path',
      'services/api/src/infra/sqlite/': 'memory',
    };
    for (const [folder, area] of Object.entries(expected)) {
      expect(coreAreaForRepositoryPath(folder)?.area, folder).toBe(area);
      const files = filesBelow(join(repositoryRoot, folder));
      expect(files.length, folder).toBeGreaterThan(0);
      for (const file of files) expect(coreAreaForRepositoryPath(relative(repositoryRoot, file))?.area, file).toBe(area);
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
    expect(coreAreaForRepositoryPath('services/api/src/autonomyActivity.ts')?.area).toBe('activity_record');
    expect(coreAreaForRepositoryPath('services/api/src/autonomyPolicy.ts')?.area).toBe('approval_and_budget');
  });

  it('rejects a path that is not inside the repository', () => {
    expect(normalizedRepositoryPath('../outside.ts')).toBeNull();
    expect(normalizedRepositoryPath('a/../../b')).toBeNull();
    expect(normalizedRepositoryPath('')).toBeNull();
    expect(coreAreaForRepositoryPath('../packages/cognition/src/persona.ts')).toBeNull();
  });
});
