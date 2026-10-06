#!/usr/bin/env node
// The folder rules of the API sources (Syzygy ADR-0008 §6), checked on resolved import paths.
//
//   node scripts/check-api-layers.mjs                    report: new violations, and baseline entries now fixed (exit 0)
//   node scripts/check-api-layers.mjs --enforce          the same, and exit 1 on a violation that is not in the baseline
//   node scripts/check-api-layers.mjs --update-baseline  drop fixed entries from the baseline (it only shrinks)
//                                     --update-baseline --accept-new   also add today's new violations (a decision)
//   --layout projected (default) | actual                where a file is taken to be: its target in moves.json, or where it is
//   --list                                               print every violation, not only the new ones
//
// The default layout is the projected one: each file is checked at its target folder in scripts/layout/moves.json, so the
// baseline names the same paths before, during and after the waves of scripts/layout/apply.mjs. A file moves.json does
// not list is checked where it is. Imports are read with TypeScript's pre-processor (static, `import type`, re-exports,
// dynamic `import()` and `import()` types) and resolved to files.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, posix, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const toPosix = path => path.split(sep).join('/');

export function globRegExp(glob) {
  const parts = glob.split('/');
  const pattern = parts.map((part, index) => {
    const last = index === parts.length - 1;
    if (part === '**') return last ? '.*' : '(?:[^/]+/)*';
    return part.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*') + (last ? '' : '/');
  }).join('');
  return new RegExp(`^${pattern}$`, 'u');
}

const isModulePattern = pattern => pattern.includes(':') || pattern.startsWith('@');
const matchesAny = (value, patterns = []) => patterns.some(pattern => globRegExp(pattern).test(value));

/** The component a layout path belongs to: mind/<c>, mind/action/<c>, surfaces/<s>, integrations/<i>, infra/<x>, wiring, contracts, or the root. */
export function componentOf(path) {
  const segments = path.split('/');
  if (segments.length === 1) return '(entry)';
  if (segments[0] === 'mind' && segments[1] === 'action') return segments.slice(0, 3).join('/');
  if (['mind', 'surfaces', 'integrations', 'infra'].includes(segments[0])) return segments.slice(0, 2).join('/');
  return segments[0];
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesBelow(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function resolveRelative(fromFile, specifier, exists) {
  const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const candidates = /\.(?:m|c)?js$/u.test(target) ? [target.replace(/\.(m|c)?js$/u, '.$1ts'), target]
    : /\.(?:m|c)?ts$/u.test(target) ? [target] : [`${target}.ts`, `${target}/index.ts`];
  return candidates.find(exists) ?? null;
}

/** Every violation of the rules, as `{ rule, from, to }` with layout paths (relative to the source root). */
export function violations({ root, config, moves, layout = 'projected' }) {
  const sourceRoot = resolve(root, config.sourceRoot);
  const absolute = filesBelow(sourceRoot);
  const actualPaths = absolute.map(path => toPosix(relative(sourceRoot, path)));
  const actualSet = new Set(actualPaths);
  const entries = new Set(moves.entries ?? []);
  const layoutOf = actual => {
    if (layout === 'actual') return actual;
    const name = basename(actual);
    if (entries.has(name)) return name;
    return moves.moves?.[name]?.to ?? actual;
  };
  const found = [];
  const add = (rule, from, to) => found.push({ rule, from, to });

  const texts = new Map(actualPaths.map((path, index) => [path, readFileSync(absolute[index], 'utf8')]));
  const imports = new Map();
  for (const [path, text] of texts) {
    const targets = [];
    for (const file of ts.preProcessFile(text, true, true).importedFiles) {
      if (!file.fileName.startsWith('.')) { targets.push({ module: file.fileName }); continue; }
      const resolved = resolveRelative(path, file.fileName, candidate => actualSet.has(candidate));
      if (resolved) targets.push({ path: layoutOf(resolved) });
      else if (!posix.normalize(posix.join(posix.dirname(path), file.fileName)).startsWith('..')) add('unresolved-import', layoutOf(path), file.fileName);
    }
    imports.set(path, targets);
  }

  for (const rule of config.rules) {
    if (rule.kind === 'placement') {
      for (const path of actualPaths) {
        const at = layoutOf(path);
        if (!at.includes('/') && !entries.has(at)) add(rule.id, at, '(not an entry file)');
      }
      for (const entry of entries) if (!actualSet.has(entry)) add(rule.id, entry, '(entry file not at the root)');
    } else if (rule.kind === 'imports') {
      for (const [path, targets] of imports) {
        const from = layoutOf(path);
        if (!matchesAny(from, rule.from) || matchesAny(from, rule.fromExcept)) continue;
        for (const target of targets) {
          const value = target.module ?? target.path;
          const patterns = list => (list ?? []).filter(pattern => isModulePattern(pattern) === Boolean(target.module));
          if (rule.only) {
            if (!matchesAny(value, patterns(rule.only))) add(rule.id, from, value);
            continue;
          }
          if (!matchesAny(value, patterns(rule.to)) || matchesAny(value, patterns(rule.toExcept))) continue;
          if (rule.crossComponent && (target.module || componentOf(from) === componentOf(value))) continue;
          add(rule.id, from, value);
        }
      }
    } else if (rule.kind === 'token') {
      const pattern = new RegExp(rule.pattern, 'u');
      for (const [path, text] of texts) {
        const from = layoutOf(path);
        if (!matchesAny(from, rule.allowIn) && pattern.test(text)) add(rule.id, from, rule.pattern.replace(/\\b|\\/gu, ''));
      }
    } else if (rule.kind === 'package') {
      const forbidden = rule.forbiddenPattern ? new RegExp(rule.forbiddenPattern, 'u') : null;
      for (const packageSource of rule.packages) {
        const directory = resolve(root, packageSource);
        for (const file of filesBelow(directory)) {
          const from = toPosix(relative(root, file));
          const text = readFileSync(file, 'utf8');
          for (const imported of ts.preProcessFile(text, true, true).importedFiles.map(item => item.fileName)) {
            if (imported.startsWith('.')) {
              const target = toPosix(relative(directory, resolve(dirname(file), imported)));
              if (target.startsWith('..')) add(rule.id, from, imported);
            } else if (!matchesAny(imported, rule.allow)) add(rule.id, from, imported);
          }
          const effect = forbidden && text.match(forbidden);
          if (effect) add(rule.id, from, effect[0]);
        }
      }
    } else {
      throw new Error(`Unknown rule kind ${rule.kind} (${rule.id})`);
    }
  }
  const unique = new Map(found.map(item => [`${item.rule}|${item.from}|${item.to}`, item]));
  return [...unique.values()].sort((a, b) => `${a.rule}|${a.from}|${a.to}`.localeCompare(`${b.rule}|${b.from}|${b.to}`));
}

const keyOf = item => `${item.from} -> ${item.to}`;

export function compareWithBaseline(current, baseline) {
  const known = new Set(Object.entries(baseline?.violations ?? {}).flatMap(([rule, items]) => items.map(item => `${rule}|${item}`)));
  const now = new Set(current.map(item => `${item.rule}|${keyOf(item)}`));
  return {
    fresh: current.filter(item => !known.has(`${item.rule}|${keyOf(item)}`)),
    fixed: [...known].filter(key => !now.has(key)).sort(),
  };
}

export function baselineFrom(items, about) {
  const grouped = {};
  for (const item of items) (grouped[item.rule] ??= []).push(keyOf(item));
  for (const rule of Object.keys(grouped)) grouped[rule].sort();
  return { schemaVersion: 1, about, violations: grouped };
}

function main() {
  const argv = process.argv.slice(2);
  const option = name => argv.includes(name);
  const layoutIndex = argv.indexOf('--layout');
  const layout = layoutIndex >= 0 ? argv[layoutIndex + 1] : 'projected';
  if (!['projected', 'actual'].includes(layout)) throw new Error('--layout is projected or actual');
  const root = resolve(import.meta.dirname, '..');
  const config = JSON.parse(readFileSync(resolve(root, 'scripts/api-layers.json'), 'utf8'));
  const moves = JSON.parse(readFileSync(resolve(root, config.movesFile), 'utf8'));
  const baselinePath = resolve(root, config.baselineFile);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const current = violations({ root, config, moves, layout });
  const { fresh, fixed } = compareWithBaseline(current, layout === 'projected' ? baseline : null);

  if (option('--update-baseline')) {
    if (layout !== 'projected') throw new Error('The baseline is kept for the projected layout');
    const keep = baseline && !option('--accept-new') ? current.filter(item => !fresh.includes(item)) : current;
    writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(keep, baseline?.about
      ?? 'Violations of scripts/api-layers.json on the projected layout when the rules were introduced (Syzygy ADR-0008 §6). It may only shrink: fix one, then run `node scripts/check-api-layers.mjs --update-baseline`.'), null, 2)}\n`);
    console.log(`API layers: baseline written with ${keep.length} entries (${fixed.length} fixed entries dropped${baseline && fresh.length && !option('--accept-new') ? `, ${fresh.length} new violations NOT added; --accept-new adds them` : ''}).`);
    return;
  }

  const perRule = new Map();
  for (const item of current) perRule.set(item.rule, (perRule.get(item.rule) ?? 0) + 1);
  const summary = [...perRule].map(([rule, count]) => `${rule} ${count}`).join(', ') || 'none';
  const mode = option('--enforce') ? 'enforcing' : 'report only';
  console.log(`API layers (${layout} layout, ${mode}): ${current.length} violations (${summary}); ${fresh.length} not in the baseline, ${fixed.length} baseline entries fixed.`);
  for (const item of option('--list') ? current : fresh) console.log(`  ${option('--list') && !fresh.includes(item) ? '' : 'new: '}${item.rule}: ${keyOf(item)}`);
  if (fixed.length) {
    for (const key of fixed) console.log(`  fixed: ${key.replace('|', ': ')}`);
    console.log('  Run `node scripts/check-api-layers.mjs --update-baseline` to drop the fixed entries.');
  }
  if (option('--enforce') && fresh.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(`check-api-layers: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
