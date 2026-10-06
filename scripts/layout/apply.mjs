#!/usr/bin/env node
// Moves the API sources into the folders of Syzygy ADR-0008 §6, one wave at a time, and changes nothing else.
//
//   node scripts/layout/apply.mjs --wave N [--dry-run] [--allow-dirty] [--allow-untracked] [--rewrite-mentions]
//   node scripts/layout/apply.mjs --through N [--dry-run] …   (waves 1..N in order, for replaying on a branch)
//
// For each file of the wave in scripts/layout/moves.json it runs `git mv` (the basename never changes), then rewrites
// every relative specifier that leads to a moved file or out of one, wherever it is written: static, type, re-export and
// dynamic imports, `vi.mock('…')`, and `new URL('…', import.meta.url)`. It rewrites the moved paths in
// `autonomyCore.ts` (the core map, CORE as code) and fails, before touching the disk, unless the set of core files is
// the same before and after. It is idempotent: a file already at its target is skipped, so a branch can replay a wave
// on its tip. With --rewrite-mentions it also rewrites `services/api/src/<old path>` in prose (docs, comments, Swift,
// plists); by default it only lists them. It works on tracked files only: it refuses to move an untracked file and,
// unless --allow-untracked, to run while untracked code sits under the API, scripts or packages. Changes are staged,
// never committed.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, posix, relative, resolve, sep } from 'node:path';

let ts;
try {
  ts = (await import('typescript')).default;
} catch {
  console.error('apply.mjs: the typescript package cannot be found; run `pnpm install` (or link node_modules) first.');
  process.exit(1);
}

const toPosix = path => path.split(sep).join('/');

// --root and --moves point the script at another checkout (its tests use a small repository of their own).
const rootArgument = process.argv.indexOf('--root');
const movesArgument = process.argv.indexOf('--moves');
const root = rootArgument > 0 ? resolve(process.argv[rootArgument + 1]) : resolve(import.meta.dirname, '../..');
const movesFile = movesArgument > 0 ? resolve(process.argv[movesArgument + 1]) : resolve(root, 'scripts/layout/moves.json');
const config = JSON.parse(readFileSync(movesFile, 'utf8'));
const SOURCE_ROOT = config.sourceRoot;
const MOVES_PATH = toPosix(relative(root, movesFile));
const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);
const PROSE_EXTENSIONS = new Set(['.md', '.json', '.ts', '.mjs', '.js', '.sh', '.example', '.service', '.yml', '.yaml', '.txt', '.swift', '.plist']);
// Folders whose untracked code a wave would have to rewrite but could not stage: a wave refuses while any exists.
const UNTRACKED_GUARDED = ['services/api/src/', 'services/api/tests/', 'services/api/scripts/', 'scripts/', 'packages/'];

const repoPath = absolute => toPosix(relative(root, absolute));
const absolutePath = path => resolve(root, path);

function parseArguments(argv) {
  const options = { dryRun: false, allowDirty: false, allowUntracked: false, rewriteMentions: false, waves: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--allow-dirty') options.allowDirty = true;
    else if (argument === '--allow-untracked') options.allowUntracked = true;
    else if (argument === '--rewrite-mentions') options.rewriteMentions = true;
    else if (argument === '--root' || argument === '--moves') index += 1;
    else if (argument === '--wave' || argument === '--through') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || !config.waves[String(value)]) throw new Error(`${argument} needs a wave number (${Object.keys(config.waves).join(', ')})`);
      options.waves = argument === '--wave' ? [value] : Array.from({ length: value }, (_, wave) => wave + 1);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.waves.length) throw new Error('Usage: apply.mjs --wave N | --through N [--dry-run] [--allow-dirty] [--rewrite-mentions]');
  return options;
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** Every file git tracks, as repository paths. A wave reads, moves and rewrites these and nothing else. */
function trackedFiles() {
  return git('ls-files', '-z', '--cached').split('\0').filter(Boolean).filter(path => existsSync(absolutePath(path)));
}

/** Untracked, not ignored files, as repository paths. */
function untrackedFiles() {
  return git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesBelow(path);
    return entry.isFile() ? [path] : [];
  });
}

/** basename → repository path of every API source file where it is now. */
function currentSources() {
  const located = new Map();
  for (const path of filesBelow(absolutePath(SOURCE_ROOT)).filter(file => file.endsWith('.ts'))) {
    const name = basename(path);
    if (located.has(name)) throw new Error(`Two API source files are named ${name}: ${located.get(name)} and ${repoPath(path)}`);
    located.set(name, repoPath(path));
  }
  return located;
}

// ---------------------------------------------------------------------------------------------------------------
// The core map

const CORE_FILE = 'autonomyCore.ts';

/** The string entries of SHANNON_CORE_PATHS, with where each literal sits in the text. */
function coreEntries(text) {
  const start = text.indexOf('export const SHANNON_CORE_PATHS');
  const end = text.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error(`${CORE_FILE}: SHANNON_CORE_PATHS not found`);
  const entries = [];
  const body = text.slice(start, end);
  for (const match of body.matchAll(/^\s*'([^'\n]+)',/gmu)) {
    entries.push({ value: match[1], index: start + match.index + match[0].indexOf(`'${match[1]}'`) + 1 });
  }
  const minimum = config.minimumCoreEntries ?? 50;
  if (entries.length < minimum) throw new Error(`${CORE_FILE}: only ${entries.length} core entries were read (at least ${minimum} expected)`);
  return entries;
}

/** The files a core map covers, given the set of files that exist: a file entry itself, a directory entry every file below it. */
function coreFiles(entries, files) {
  const covered = new Set();
  for (const { value } of entries) {
    if (value.endsWith('/')) {
      for (const file of files) if (file.startsWith(value)) covered.add(file);
    } else if (files.has(value)) covered.add(value);
    else covered.add(`(missing) ${value}`);
  }
  return covered;
}

// ---------------------------------------------------------------------------------------------------------------
// Specifiers

/** The file a relative specifier written in `fromPath` names, or null when it names nothing that exists. */
function resolveSpecifier(fromPath, specifier, exists) {
  const target = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [target];
  if (/\.(?:js|mjs|cjs)$/u.test(target)) candidates.unshift(target.replace(/\.(m|c)?js$/u, '.$1ts'));
  if (!extname(target)) candidates.push(`${target}.ts`, `${target}/index.ts`);
  return candidates.find(candidate => exists(candidate)) ?? null;
}

/** A specifier from `fromPath` to `targetPath`, written in the style of the original (extension kept, `./` prefix). */
function specifierBetween(fromPath, targetPath, original) {
  let written = posix.relative(posix.dirname(fromPath), targetPath);
  if (!written.startsWith('.')) written = `./${written}`;
  const originalExtension = original.match(/\.(?:js|mjs|cjs|ts|mts|cts|json)$/u)?.[0] ?? '';
  const targetExtension = extname(targetPath);
  if (!originalExtension) written = written.slice(0, written.length - targetExtension.length);
  else if (originalExtension !== targetExtension) written = written.slice(0, written.length - targetExtension.length) + originalExtension;
  return written;
}

/** Every relative specifier of a code file, with where its text sits: imports of every kind, vi.mock, new URL(…, import.meta.url). */
function specifiersOf(text) {
  const found = [];
  for (const file of ts.preProcessFile(text, true, true).importedFiles) {
    if (file.fileName.startsWith('.')) found.push({ kind: 'import', value: file.fileName, start: file.pos + 1, end: file.pos + 1 + file.fileName.length });
  }
  for (const match of text.matchAll(/\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\(\s*(['"])(\.[^'"\n]+)\1/gu)) {
    const start = match.index + match[0].lastIndexOf(match[2]);
    found.push({ kind: 'import', value: match[2], start, end: start + match[2].length });
  }
  for (const match of text.matchAll(/new URL\(\s*(['"`])(\.[^'"`$\n]*)\1\s*,\s*import\.meta\.url\s*\)/gu)) {
    const start = match.index + match[0].indexOf(match[2]);
    found.push({ kind: 'url', value: match[2], start, end: start + match[2].length });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// One wave

function planWave(wave, options) {
  const located = currentSources();
  for (const entry of config.entries) {
    if (located.get(entry) !== `${SOURCE_ROOT}/${entry}`) throw new Error(`Entry file ${entry} is not at the root of ${SOURCE_ROOT}`);
    if (config.moves[entry]) throw new Error(`moves.json moves the entry file ${entry}`);
  }
  const tracked = new Set(trackedFiles());
  const renames = new Map();
  const skipped = [];
  for (const [name, move] of Object.entries(config.moves)) {
    if (move.wave !== wave) continue;
    const target = `${SOURCE_ROOT}/${move.to}`;
    if (basename(move.to) !== name) throw new Error(`moves.json renames ${name} to ${move.to}; a move keeps the basename`);
    const current = located.get(name);
    if (!current) { skipped.push(`${name}: not in this tree`); continue; }
    if (current === target) { skipped.push(`${name}: already at ${move.to}`); continue; }
    if (existsSync(absolutePath(target))) throw new Error(`${target} already exists; cannot move ${current} there`);
    if (!tracked.has(current)) throw new Error(`moves.json moves ${current}, which git does not track; commit it first`);
    renames.set(current, target);
  }

  const before = [...tracked];
  const beforeSet = tracked;
  const after = new Set(before.map(path => renames.get(path) ?? path));
  const moved = path => renames.get(path) ?? path;

  // Rewrite specifiers in every code file, as it will read at its new place.
  const rewrites = new Map();
  let specifierCount = 0;
  for (const path of before) {
    if (!CODE_EXTENSIONS.has(extname(path)) || path.includes('node_modules/')) continue;
    const text = readFileSync(absolutePath(path), 'utf8');
    const newPath = moved(path);
    const edits = [];
    for (const specifier of specifiersOf(text)) {
      let target;
      if (specifier.kind === 'url') {
        const directory = specifier.value.endsWith('/');
        target = posix.normalize(posix.join(posix.dirname(path), specifier.value));
        if (directory) target = target.replace(/\/?$/u, '/');
        // `new URL('./x.js', import.meta.url)` names the module x.ts is run as: it follows x.ts.
        const source = /\.(?:m|c)?js$/u.test(target) ? target.replace(/\.(m|c)?js$/u, '.$1ts') : null;
        const newTarget = directory ? target
          : renames.has(target) ? moved(target)
            : source && renames.has(source) ? moved(source).replace(/\.(m|c)?ts$/u, '.$1js') : target;
        if (newPath === path && newTarget === target) continue;
        let written = posix.relative(posix.dirname(newPath), newTarget.replace(/\/$/u, '')) || '.';
        if (!written.startsWith('.')) written = `./${written}`;
        if (directory) written = `${written}/`;
        if (written !== specifier.value) edits.push({ ...specifier, replacement: written });
        continue;
      }
      target = resolveSpecifier(path, specifier.value, candidate => beforeSet.has(candidate) || existsSync(absolutePath(candidate)));
      if (!target) {
        if (newPath !== path) throw new Error(`${path}: cannot resolve ${specifier.value}, so it cannot be moved safely`);
        continue;
      }
      const newTarget = moved(target);
      if (newPath === path && newTarget === target) continue;
      const written = specifierBetween(newPath, newTarget, specifier.value);
      if (written !== specifier.value) edits.push({ ...specifier, replacement: written });
    }
    if (newPath !== path && /import\.meta\.(?:dirname|filename)|__dirname|__filename/u.test(text)) {
      console.warn(`warning: ${path} names its own location (import.meta.dirname/__dirname); check it by hand`);
    }
    if (!edits.length) continue;
    let rewritten = text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      rewritten = rewritten.slice(0, edit.start) + edit.replacement + rewritten.slice(edit.end);
    }
    specifierCount += edits.length;
    rewrites.set(path, rewritten);
  }

  // The core map: its moved entries, then the check that it covers the same files.
  const corePath = located.get(CORE_FILE);
  if (!corePath) throw new Error(`${CORE_FILE} not found`);
  const coreText = rewrites.get(corePath) ?? readFileSync(absolutePath(corePath), 'utf8');
  const entriesBefore = coreEntries(coreText);
  let newCoreText = coreText;
  let coreChanges = 0;
  for (const entry of [...entriesBefore].sort((a, b) => b.index - a.index)) {
    const replacement = renames.get(entry.value);
    if (!replacement) continue;
    newCoreText = newCoreText.slice(0, entry.index) + replacement + newCoreText.slice(entry.index + entry.value.length);
    coreChanges += 1;
  }
  if (coreChanges) rewrites.set(corePath, newCoreText);
  const coreBefore = coreFiles(entriesBefore, beforeSet);
  const expected = new Set([...coreBefore].map(moved));
  const coreAfter = coreFiles(coreEntries(newCoreText), after);
  const missing = [...expected].filter(path => !coreAfter.has(path));
  const added = [...coreAfter].filter(path => !expected.has(path));
  if (missing.length || added.length || coreBefore.size !== coreAfter.size) {
    throw new Error(`The core set would change in wave ${wave}:\n  no longer core: ${missing.join(', ') || '-'}\n  newly core: ${added.join(', ') || '-'}`);
  }

  // Prose that names an old path: rewritten with --rewrite-mentions, listed otherwise.
  const mentions = new Map();
  if (renames.size) {
    const pattern = new RegExp(`${SOURCE_ROOT.replace(/[/.]/gu, '\\$&')}/[A-Za-z0-9_/]+\\.ts`, 'gu');
    for (const path of before) {
      if (path === MOVES_PATH || !PROSE_EXTENSIONS.has(extname(path)) || path === corePath) continue;
      const text = rewrites.get(path) ?? readFileSync(absolutePath(path), 'utf8');
      if (!text.includes(SOURCE_ROOT)) continue;
      const hits = [...text.matchAll(pattern)].filter(match => renames.has(match[0]));
      if (!hits.length) continue;
      mentions.set(path, hits.length);
      if (options.rewriteMentions) rewrites.set(path, text.replace(pattern, match => renames.get(match) ?? match));
    }
  }

  return { wave, renames, skipped, rewrites, specifierCount, coreChanges, coreSize: coreAfter.size, mentions };
}

function applyPlan(plan) {
  for (const [from, to] of plan.renames) {
    mkdirSync(dirname(absolutePath(to)), { recursive: true });
    git('mv', from, to);
  }
  const touched = [];
  for (const [path, text] of plan.rewrites) {
    const destination = plan.renames.get(path) ?? path;
    writeFileSync(absolutePath(destination), text);
    touched.push(destination);
  }
  // Only tracked files are rewritten (the plan reads nothing else), so every one of them is staged.
  if (touched.length) git('add', '--', ...touched);
  // The same check on the disk as written.
  const located = currentSources();
  const core = readFileSync(absolutePath(located.get(CORE_FILE)), 'utf8');
  const files = new Set(trackedFiles());
  const covered = coreFiles(coreEntries(core), files);
  const missing = [...covered].filter(path => path.startsWith('(missing)'));
  if (missing.length || covered.size !== plan.coreSize) throw new Error(`After wave ${plan.wave} the core map does not match the files: ${missing.join(', ')}`);
}

function report(plan, dryRun) {
  const verb = dryRun ? 'would move' : 'moved';
  console.log(`Wave ${plan.wave} (${config.waves[String(plan.wave)]}): ${verb} ${plan.renames.size} files, ${dryRun ? 'would rewrite' : 'rewrote'} ${plan.specifierCount} specifiers in ${plan.rewrites.size - (plan.coreChanges ? 1 : 0)} files, ${plan.coreChanges} core-map entries; core set unchanged (${plan.coreSize} files).`);
  for (const [from, to] of plan.renames) console.log(`  ${from} -> ${to}`);
  if (plan.skipped.length) console.log(`  skipped: ${plan.skipped.length} (${plan.skipped.filter(line => !line.includes('already at')).join('; ') || 'already in place'})`);
  if (plan.mentions.size) {
    const total = [...plan.mentions.values()].reduce((sum, count) => sum + count, 0);
    console.log(`  ${total} mentions of moved paths in ${plan.mentions.size} files ${plan.rewriteMentions ? 'rewritten' : 'left as they are (--rewrite-mentions rewrites them)'}: ${[...plan.mentions.keys()].join(', ')}`);
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.dryRun && !options.allowDirty) {
    const dirty = git('status', '--porcelain', '--untracked-files=no').trim();
    if (dirty) throw new Error(`The working tree has changes; commit or stash them first (or pass --allow-dirty):\n${dirty}`);
  }
  const strays = untrackedFiles().filter(path => CODE_EXTENSIONS.has(extname(path)) && UNTRACKED_GUARDED.some(folder => path.startsWith(folder)));
  if (strays.length && !options.allowUntracked) {
    const message = `Untracked code would not be rewritten: ${strays.join(', ')}. Commit, stash (git stash -u) or remove it first (or pass --allow-untracked).`;
    if (options.dryRun) console.warn(`warning: ${message}`);
    else throw new Error(message);
  }
  for (const wave of options.waves) {
    const plan = planWave(wave, options);
    plan.rewriteMentions = options.rewriteMentions;
    if (!options.dryRun) applyPlan(plan);
    report(plan, options.dryRun);
    // A dry run of several waves can plan only the first: the later ones depend on files the first would move.
    if (options.dryRun && options.waves.length > 1 && plan.renames.size) {
      console.log(`(dry run: waves after ${wave} are planned against the tree as it is, so they are not shown)`);
      break;
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`apply.mjs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
