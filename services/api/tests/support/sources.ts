import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The API's source files, found wherever they live under `services/api/src`.
 *
 * Tests that read source text, list modules, or check what a module imports go through this helper and never
 * through a flat path such as `../src/<name>` or `services/api/src/<name>`, so that the folder layout of
 * Syzygy ADR-0008 §6 (`mind/`, `surfaces/`, `integrations/`, `infra/`, `wiring/`, `contracts/`) can be reached by
 * `scripts/layout/apply.mjs` without editing every test. A file is named by its basename (`autonomyStore.ts`; the
 * layout never renames a file, and basenames are unique) or by a path relative to the API source root or to the
 * repository root. Imports are compared as resolved repository paths, never as specifier strings.
 */

export const repositoryRoot = resolve(import.meta.dirname, '../../../..');
export const apiSourceRoot = join(repositoryRoot, 'services/api/src');

/** A repository-relative path with `/` separators. */
export function repositoryPath(absolute: string): string {
  return relative(repositoryRoot, absolute).split(sep).join('/');
}

function listTypeScript(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScript(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

let cachedFiles: readonly string[] | null = null;

/** Every `.ts` file below `services/api/src`, recursively, as absolute paths in a stable order. */
export function apiSourceFiles(): readonly string[] {
  cachedFiles ??= Object.freeze(listTypeScript(apiSourceRoot).sort());
  return cachedFiles;
}

/** The basenames of every API source file (unique: the layout never gives two files one name). */
export function apiSourceNames(): string[] {
  return apiSourceFiles().map(path => basename(path));
}

/** Every API source file whose basename matches, as absolute paths. */
export function apiSourceFilesNamed(pattern: RegExp): string[] {
  return apiSourceFiles().filter(path => pattern.test(basename(path)));
}

function withTypeScriptExtension(name: string): string {
  if (name.endsWith('.ts')) return name;
  if (name.endsWith('.js')) return `${name.slice(0, -3)}.ts`;
  return `${name}.ts`;
}

/**
 * The absolute path of one API source file, by basename (`'autonomyStore.ts'`, `'autonomyStore.js'` or `'autonomyStore'`),
 * by a path relative to `services/api/src`, or by a repository path (`'services/api/src/…'`). Throws when there is
 * no such file or the basename is ambiguous, so that a test can never pass by reading nothing.
 */
export function apiSourceFile(name: string): string {
  const wanted = withTypeScriptExtension(name.replace(/\\/gu, '/'));
  const files = apiSourceFiles();
  if (wanted.includes('/')) {
    const fromRepository = wanted.startsWith('services/api/src/') ? join(repositoryRoot, wanted) : null;
    const fromSourceRoot = join(apiSourceRoot, wanted);
    const found = files.find(path => path === fromRepository || path === fromSourceRoot);
    if (found) return found;
    throw new Error(`No API source file at ${name}`);
  }
  const matches = files.filter(path => basename(path) === wanted);
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length ? `${name} names ${matches.length} API source files: ${matches.map(repositoryPath).join(', ')}`
    : `No API source file named ${name}`);
}

/** The repository path (`services/api/src/…`) of one API source file; see `apiSourceFile`. */
export function apiSourcePath(name: string): string {
  return repositoryPath(apiSourceFile(name));
}

/** The text of one API source file; see `apiSourceFile`. */
export function readApiSource(name: string): string {
  return readFileSync(apiSourceFile(name), 'utf8');
}

/**
 * Every module specifier one TypeScript text names: static imports and `import type`, side-effect imports, re-exports
 * (`export … from`), dynamic `import('…')` and `import('…')` types. Comments and ordinary strings are not specifiers.
 */
export function importSpecifiers(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map(file => file.fileName);
}

/**
 * Where a specifier written in `fromFile` leads: the repository path of the `.ts` file a relative specifier resolves to
 * (`./x.js`, `../x.js`, with or without an extension), or the specifier itself when it is a package or a `node:` module.
 */
export function resolveImport(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const target = resolve(dirname(fromFile), specifier);
  const candidate = target.endsWith('.js') ? `${target.slice(0, -3)}.ts` : target.endsWith('.ts') ? target : `${target}.ts`;
  return repositoryPath(candidate);
}

/**
 * What one API source file imports: repository paths for relative specifiers, the specifier for anything else.
 * In the order written, duplicates kept (a type import and a value import of the same module both count).
 */
export function resolvedImports(name: string): string[] {
  const file = apiSourceFile(name);
  return importSpecifiers(readFileSync(file, 'utf8')).map(specifier => resolveImport(file, specifier));
}

/**
 * What one API source file imports, by module: the basename of the API source file a relative specifier resolves to
 * (`'autonomyStore.ts'`), a repository path for a relative specifier that leads elsewhere, and the specifier for a package
 * or a `node:` module. A relative specifier that resolves to no file throws. This is a check on resolved paths written
 * short; basenames are unique, so it names exactly one file.
 */
export function importedModules(name: string): string[] {
  const files = new Set(apiSourceFiles().map(repositoryPath));
  return resolvedImports(name).map(target => {
    if (!target.startsWith('services/api/src/')) return target;
    if (!files.has(target)) throw new Error(`${name} imports ${target}, which does not exist`);
    return basename(target);
  });
}
