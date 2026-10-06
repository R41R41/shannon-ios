import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiSourceFile, apiSourceFiles, apiSourceNames, apiSourcePath, apiSourceRoot, importSpecifiers, importedModules, readApiSource,
  repositoryPath, resolveImport,
} from './support/sources.js';

describe('tests/support/sources.ts', () => {
  it('lists every API source file, recursively, with unique basenames', () => {
    const files = apiSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(360);
    expect(files.every(path => path.startsWith(apiSourceRoot) && path.endsWith('.ts'))).toBe(true);
    const names = apiSourceNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it('finds a file by basename, by extension-less or .js name, by a source-root path and by a repository path', () => {
    const path = apiSourcePath('autonomyCore.ts');
    expect(path.startsWith('services/api/src/')).toBe(true);
    for (const name of ['autonomyCore', 'autonomyCore.js', path, path.slice('services/api/src/'.length)]) {
      expect(apiSourcePath(name)).toBe(path);
    }
    expect(readApiSource('autonomyCore.ts')).toContain('SHANNON_CORE_PATHS');
    expect(() => apiSourceFile('noSuchModule.ts')).toThrow(/No API source file/u);
    expect(() => apiSourceFile('mind/noSuchModule.ts')).toThrow(/No API source file/u);
  });

  it('reads every kind of specifier and skips comments and strings', () => {
    const text = [
      "// import x from './comment.js';",
      "import a, { b } from './a.js';",
      'import type {\n  C } from "../c.js";',
      "export { d } from './d.js';",
      "export * from './e.js';",
      "import './side.js';",
      "const s = 'from \"./string.js\"';",
      "type T = typeof import('./typed.js');",
      "const m = await import('./dynamic.js');",
      "import { DatabaseSync } from 'node:sqlite';",
      "import { looksSecret } from '@shannon/cognition';",
    ].join('\n');
    expect(importSpecifiers(text)).toEqual(['./a.js', '../c.js', './d.js', './e.js', './side.js', './typed.js', './dynamic.js', 'node:sqlite', '@shannon/cognition']);
  });

  it('resolves a relative specifier to the repository path of the .ts file, wherever the importing file lives', () => {
    const nested = join(apiSourceRoot, 'mind/memory/store/knowledgeStore.ts');
    expect(resolveImport(nested, '../../../infra/sqlite/sqliteStore.js')).toBe('services/api/src/infra/sqlite/sqliteStore.ts');
    expect(resolveImport(nested, './other')).toBe('services/api/src/mind/memory/store/other.ts');
    expect(resolveImport(nested, 'node:sqlite')).toBe('node:sqlite');
    expect(repositoryPath(nested)).toBe('services/api/src/mind/memory/store/knowledgeStore.ts');
  });

  it('names what a module imports by the file it resolves to', () => {
    const imported = importedModules('autonomyLoopOwnerContext.ts');
    expect(imported).toEqual(['@shannon/cognition']);
    expect(importedModules('autonomyCore.ts')).toEqual(['@shannon/cognition']);
    expect(importedModules('server.ts').length).toBeGreaterThan(20);
    expect(importedModules('server.ts').every(name => !name.startsWith('.'))).toBe(true);
  });
});
