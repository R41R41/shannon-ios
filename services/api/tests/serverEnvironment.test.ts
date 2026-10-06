import { afterEach, describe, expect, it, vi } from 'vitest';
import { processEnvironment, serverEnvironment } from '../src/infra/config/serverEnvironment.js';
import { apiSourceFiles, repositoryPath } from './support/sources.js';
import { readFileSync } from 'node:fs';

afterEach(() => { vi.unstubAllEnvs(); });

/** Syzygy ADR-0008 §10: the environment is read in one place; moving the reads there changed nothing. */
describe('the server environment', () => {
  it('is the live process environment, as a default of `= process.env` was', () => {
    expect(serverEnvironment()).toBe(process.env);
    expect(processEnvironment()).toBe(process.env);
    vi.stubEnv('SHANNON_TEST_ENVIRONMENT_READ', 'stubbed');
    expect(serverEnvironment().SHANNON_TEST_ENVIRONMENT_READ).toBe('stubbed');
  });

  it('is read only in infra/config, wiring and the entry files', () => {
    const readers = apiSourceFiles().filter(file => /\bprocess\.env\b/u.test(readFileSync(file, 'utf8'))).map(repositoryPath);
    const outside = readers.map(path => path.replace(/^services\/api\/src\//u, '')).filter(path => path.includes('/') && !path.startsWith('infra/config/') && !path.startsWith('wiring/'));
    expect(outside).toEqual([]);
  });
});
