#!/usr/bin/env node
// The shape rules of the TypeScript sources (Syzygy ADR-0009 stage 1, D9: a line limit that a long line cannot dodge).
// Counted on the TypeScript syntax tree, never on raw text:
//
//   multi-statement-line   a line on which two statements of one statement list start      (at most 1 per line)
//   long-line              a line longer than 160 characters                                 (files under **/prompts/** are exempt)
//   long-function          a function with more than 60 statements (nested functions count for themselves)
//   complex-function       a function whose cyclomatic complexity is above 15
//   long-file              a file with more than 350 statements
//
//   node scripts/check-code-shape.mjs                     report every file whose counts exceed the baseline, exit 1 if any does
//   node scripts/check-code-shape.mjs --list              also print each violation of the files over their baseline
//   node scripts/check-code-shape.mjs --update-baseline   write today's counts, refusing to raise any count (it only shrinks)
//
// The baseline (scripts/code-shape-baseline.json) holds the counts per file and rule when the rules were introduced. A file
// may never count more than its baseline; a file the baseline does not name (a new file) must count zero.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

let ts = null;
try {
  ts = (await import('typescript')).default;
} catch {
  ts = null;
}
export const typescriptAvailable = ts !== null;

export const SHAPE_LIMITS = Object.freeze({
  statementsPerLine: 1,
  lineCharacters: 160,
  functionStatements: 60,
  functionComplexity: 15,
  fileStatements: 350,
});

export const SHAPE_RULES = Object.freeze(['multi-statement-line', 'long-line', 'long-function', 'complex-function', 'long-file']);

const SOURCE_DIRECTORIES = ['services/api/src', 'packages/cognition/src', 'packages/evaluation/src', 'packages/learning/src',
  'packages/mind/src', 'packages/switches/src'];
const BASELINE_FILE = 'scripts/code-shape-baseline.json';
const LINE_EXEMPT = /(?:^|\/)prompts\//u;

const toPosix = path => path.split(sep).join('/');

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesBelow(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

/** The statement lists of a node: a source file, a block, a case clause, a module block. */
function statementList(node) {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return null;
}

function branchWeight(node) {
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) return 1;
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) return 1;
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return 1;
  if (ts.isCaseClause(node) || ts.isCatchClause(node)) return 1;
  if (!ts.isBinaryExpression(node)) return 0;
  const operator = node.operatorToken.kind;
  const logical = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];
  return logical.includes(operator) ? 1 : 0;
}

/** Statements and complexity of one function, without what its nested functions hold. */
function measureFunction(fn) {
  let statements = 0;
  let complexity = 1;
  const visit = node => {
    if (node !== fn && isFunctionLike(node)) return;
    const list = statementList(node);
    if (list) statements += list.length;
    complexity += branchWeight(node);
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return { statements, complexity };
}

function declaredName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

function functionName(fn, source) {
  const line = source.getLineAndCharacterOfPosition(fn.getStart(source)).line + 1;
  return `${declaredName(fn) ?? 'anonymous'}@${line}`;
}

/** Every shape violation of one file's text. `path` is only used for the prompt exemption. */
export function shapeViolations(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = [];
  const add = (rule, where) => found.push({ rule, where });
  let fileStatements = 0;
  const visit = node => {
    const list = statementList(node);
    if (list) {
      fileStatements += list.length;
      const lines = new Map();
      for (const statement of list) {
        const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
        lines.set(line, (lines.get(line) ?? 0) + 1);
      }
      for (const [line, count] of lines) if (count > SHAPE_LIMITS.statementsPerLine) add('multi-statement-line', `line ${line}`);
    }
    if (isFunctionLike(node) && node.body) {
      const measured = measureFunction(node);
      if (measured.statements > SHAPE_LIMITS.functionStatements) add('long-function', functionName(node, source));
      if (measured.complexity > SHAPE_LIMITS.functionComplexity) add('complex-function', functionName(node, source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!LINE_EXEMPT.test(toPosix(path))) {
    text.split(/\r?\n/u).forEach((line, index) => {
      if (line.length > SHAPE_LIMITS.lineCharacters) add('long-line', `line ${index + 1}`);
    });
  }
  if (fileStatements > SHAPE_LIMITS.fileStatements) add('long-file', `${fileStatements} statements`);
  return found;
}

/** Counts per rule of a list of violations. */
export function countsOf(items) {
  const counts = {};
  for (const item of items) counts[item.rule] = (counts[item.rule] ?? 0) + 1;
  return counts;
}

/** Files whose counts exceed the baseline (a file the baseline does not name has a baseline of zero). */
export function overBaseline(current, baseline) {
  const over = [];
  for (const [file, counts] of Object.entries(current)) {
    const allowed = baseline[file] ?? {};
    for (const [rule, count] of Object.entries(counts)) {
      if (count > (allowed[rule] ?? 0)) over.push({ file, rule, count, allowed: allowed[rule] ?? 0 });
    }
  }
  return over.sort((a, b) => `${a.file}|${a.rule}`.localeCompare(`${b.file}|${b.rule}`));
}

/** Baseline entries that are now lower (or gone): the baseline may be updated to them. */
export function shrunk(current, baseline) {
  const lower = [];
  for (const [file, counts] of Object.entries(baseline)) {
    for (const [rule, count] of Object.entries(counts)) {
      const now = current[file]?.[rule] ?? 0;
      if (now < count) lower.push({ file, rule, count: now, was: count });
    }
  }
  return lower;
}

/** The counts of every source file below `root`, keyed by the repository-relative path. */
export function measureTree(root, directories = SOURCE_DIRECTORIES) {
  const counts = {};
  const details = {};
  for (const directory of directories) {
    for (const file of filesBelow(resolve(root, directory))) {
      const path = toPosix(relative(root, file));
      const items = shapeViolations(path, readFileSync(file, 'utf8'));
      if (!items.length) continue;
      counts[path] = countsOf(items);
      details[path] = items;
    }
  }
  return { counts, details };
}

function sortedCounts(counts) {
  const sorted = {};
  for (const file of Object.keys(counts).sort()) sorted[file] = counts[file];
  return sorted;
}

function writeBaseline(path, counts, baseline) {
  const raised = baseline ? overBaseline(counts, baseline) : [];
  if (raised.length) {
    for (const item of raised) console.log(`  refused: ${item.file} ${item.rule} ${item.allowed} -> ${item.count}`);
    console.log('Code shape: the baseline only shrinks; fix the files above first.');
    process.exitCode = 1;
    return;
  }
  const about = 'Counts of scripts/check-code-shape.mjs per file and rule when the rules were introduced (Syzygy ADR-0009 stage 1). '
    + 'It may only shrink: fix a file, then run `node scripts/check-code-shape.mjs --update-baseline`.';
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, about, limits: SHAPE_LIMITS, files: sortedCounts(counts) }, null, 2)}\n`);
  console.log(`Code shape: baseline written for ${Object.keys(counts).length} files.`);
}

function report(counts, details, baseline, list) {
  const over = overBaseline(counts, baseline);
  const lower = shrunk(counts, baseline);
  const totals = countsOf(Object.values(details).flat());
  const summary = SHAPE_RULES.map(rule => `${rule} ${totals[rule] ?? 0}`).join(', ');
  console.log(`Code shape: ${summary}; ${over.length} over the baseline, ${lower.length} baseline counts now lower.`);
  for (const item of over) {
    console.log(`  over: ${item.file} ${item.rule} ${item.count} (baseline ${item.allowed})`);
    if (!list) continue;
    for (const detail of details[item.file].filter(entry => entry.rule === item.rule)) console.log(`    ${detail.where}`);
  }
  if (lower.length) console.log('  Run `node scripts/check-code-shape.mjs --update-baseline` to record the lower counts.');
  if (over.length) process.exitCode = 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (!typescriptAvailable) {
    console.log('Code shape: skipped, the typescript package cannot be found (no node_modules; run `pnpm install`).');
    return;
  }
  const root = resolve(import.meta.dirname, '..');
  const baselinePath = resolve(root, BASELINE_FILE);
  const stored = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const { counts, details } = measureTree(root);
  if (argv.includes('--update-baseline')) {
    writeBaseline(baselinePath, counts, stored?.files ?? null);
    return;
  }
  report(counts, details, stored?.files ?? {}, argv.includes('--list'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(`check-code-shape: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
