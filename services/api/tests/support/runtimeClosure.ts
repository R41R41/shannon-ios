import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The modules a process loads at run time, from one entry file (Syzygy ADR-0008 stage 3, pre-deploy review): each file is
 * transpiled as one file at a time (`ts.transpileModule`, as tsx and esbuild do), which drops every import used only as a type;
 * what the output still imports, and `import()` calls, are followed. Answers the API source files reached, relative to
 * `services/api/src`, sorted. Packages (`@shannon/*`, `node:*`) are not followed.
 */
export function runtimeClosure(entry: string, sourceRoot = resolve(import.meta.dirname, '../../src')): string[] {
  const seen = new Set<string>();
  const stack = [resolve(sourceRoot, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...runtimeImports(file));
  }
  return [...seen].map(file => relative(sourceRoot, file).split(sep).join('/')).sort();
}

/** The API source files one file imports at run time (absolute paths). */
function runtimeImports(file: string): string[] {
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  return ts.preProcessFile(output, true, true).importedFiles.flatMap(imported => {
    if (!imported.fileName.startsWith('.')) return [];
    const target = resolve(dirname(file), imported.fileName);
    const candidate = target.endsWith('.js') ? `${target.slice(0, -3)}.ts` : target.endsWith('.ts') ? target : `${target}.ts`;
    return existsSync(candidate) ? [candidate] : [];
  });
}

/** The runtime import cycles of the API source (strongly connected components of more than one file), relative paths. */
export function runtimeCycles(sourceRoot = resolve(import.meta.dirname, '../../src')): string[][] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path); else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk(sourceRoot);
  const edges = new Map(files.map(file => [file, runtimeImports(file)]));
  let counter = 0;
  const order = new Map<string, number>(), lowest = new Map<string, number>(), open = new Set<string>(), stack: string[] = [], cycles: string[][] = [];
  const visit = (file: string): void => {
    order.set(file, counter); lowest.set(file, counter++); stack.push(file); open.add(file);
    for (const next of edges.get(file) ?? []) {
      if (!order.has(next)) { visit(next); lowest.set(file, Math.min(lowest.get(file)!, lowest.get(next)!)); }
      else if (open.has(next)) lowest.set(file, Math.min(lowest.get(file)!, order.get(next)!));
    }
    if (lowest.get(file) !== order.get(file)) return;
    const component: string[] = [];
    let member: string;
    do { member = stack.pop()!; open.delete(member); component.push(relative(sourceRoot, member).split(sep).join('/')); } while (member !== file);
    if (component.length > 1) cycles.push(component.sort());
  };
  for (const file of files) if (!order.has(file)) visit(file);
  return cycles;
}

/** The entry files of the API (moves.json `entries`, the ones a process runs). */
export const ENTRY_FILES = Object.freeze(['server.ts', 'mindWorker.ts', 'worker.ts', 'worldWorker.ts', 'autonomyWorker.ts', 'agentHost.ts', 'testflightDistributor.ts', 'authCli.ts']);

export function sourceRootOf(repository: string): string { return join(repository, 'services/api/src'); }
