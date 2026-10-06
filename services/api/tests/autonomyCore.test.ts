import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHANNON_CORE_AREA_LABELS } from '@shannon/cognition';
import { SHANNON_CORE_PATHS, allCorePaths, coreAreaForRepositoryPath, normalizedRepositoryPath } from '../src/mind/inhibition/autonomyCore.js';
import { apiSourceFilesNamed, apiSourcePath, repositoryPath, repositoryRoot } from './support/sources.js';

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
  });

  it('rejects a path that is not inside the repository', () => {
    expect(normalizedRepositoryPath('../outside.ts')).toBeNull();
    expect(normalizedRepositoryPath('a/../../b')).toBeNull();
    expect(normalizedRepositoryPath('')).toBeNull();
    expect(coreAreaForRepositoryPath('../packages/cognition/src/persona.ts')).toBeNull();
  });
});
