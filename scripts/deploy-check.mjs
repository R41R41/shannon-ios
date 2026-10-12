#!/usr/bin/env node
// The deploy lane: what the production VM checks after a bundle is extracted, in about two minutes on its two cores, with the
// VM's own Node and the node_modules already there (no pnpm, no git, no network).
//
// The whole suite does not run here. It runs on GitHub Actions on every push (.github/workflows/api-tests.yml); a commit is
// deployed only when that run is green. This lane checks what the VM itself can get wrong: the extracted tree typechecks with
// the production Node and dependencies, the deploy-critical tests pass there, and so do the tests that import what changed.
//
//   N=/home/azureuser/shannon-ios-runtime/bin/node
//   cd /home/azureuser/shannon-ios
//   $N scripts/deploy-check.mjs --files-from /tmp/new-files.txt --files-from /tmp/modified-files.txt
//   $N scripts/deploy-check.mjs services/api/src/server.ts packages/mind/src/index.ts     # paths as arguments
//   $N scripts/deploy-check.mjs --dry-run --files-from /tmp/modified-files.txt               # show the plan, run nothing
//
// What it runs:
//   1. tsc --noEmit for services/api and for each package that changed or depends on one that changed (all packages when no
//      file is named). The tsconfig files are incremental (node_modules/.cache/tsc), so a repeat run rechecks only what changed.
//   2. vitest on (i) the fixed deploy-critical set below and (ii) the test files related to the named files, as `vitest related`
//      finds them (every test whose import graph reaches a named file, and a named test file itself). When the related set is
//      larger than --related-limit (a change to a widely imported module), only the related tests whose name shares a stem with
//      a named file run, and the script says how many were left to CI; --all-related runs them all.
//
// Options:
//   --files-from <file>   a list of paths, one a line (repeatable). Blank lines and lines starting with # are skipped; a line of
//                         `git diff --name-status` (A/M/D, a tab, the path) is read as its path. Missing (deleted) paths are skipped.
//   --related-limit <n>   the most related test files to run before falling back to the name-matched ones (default 40)
//   --all-related         run every related test file, however many
//   --max-workers <n>     vitest workers (default 2: on two cores one file computes while the other waits on SQLite or a child)
//   --no-tsc, --no-tests  skip a step
//   --dry-run             print the plan and exit
//
// Exit status: 0 when every step passed, 1 when one failed, 2 for a usage error. Lanes and measurements:
// docs/testing/test-lanes.md.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_TESTS = 'services/api/tests';

/** The deploy-critical tests: schema steps, entry closures, request goldens, switches, own-time privacy, ops, stabilization
 * and the action-lease equivalence. Every stabilization*.test.ts is added by name, so a new one is included without an edit. */
const FIXED_TESTS = [
  `${API_TESTS}/executionSchemaSteps.test.ts`,
  `${API_TESTS}/schemaColumns.test.ts`,
  `${API_TESTS}/executionColumnsS3.test.ts`,
  `${API_TESTS}/entryClosures.test.ts`,
  `${API_TESTS}/claudeRequestGoldens.test.ts`,
  `${API_TESTS}/chatModelGolden.test.ts`,
  `${API_TESTS}/switchesWiring.test.ts`,
  `${API_TESTS}/stage2SwitchedOff.test.ts`,
  `${API_TESTS}/stage2SwitchedOffRecall.test.ts`,
  `${API_TESTS}/stage3SwitchedOff.test.ts`,
  `${API_TESTS}/autonomyLoopPrivacy.test.ts`,
  `${API_TESTS}/ops.test.ts`,
  `${API_TESTS}/opsCommands.test.ts`,
  `${API_TESTS}/actionLeaseEquivalence.test.ts`,
  'packages/switches/tests/switches.test.ts',
  'packages/learning/tests/switches.test.ts',
  'packages/mind/tests/switches.test.ts',
];

/** Paths `vitest related` can follow: sources and tests of the workspace. package.json is left out on purpose: vitest treats it
 * as a trigger to run everything, and a dependency change is the bundle's `pnpm install` step, not this lane's. */
const SOURCE_PATTERN = /^(?:services|packages)\/.+\.(?:[cm]?ts|[cm]?js|json)$/u;

function usage(message, status = 2) {
  if (message) console.error(`deploy-check: ${message}`);
  console.error('Usage: node scripts/deploy-check.mjs [--files-from <file>]... [--related-limit <n>] [--all-related] '
    + '[--max-workers <n>] [--no-tsc] [--no-tests] [--dry-run] [path...]');
  process.exit(status);
}

function parseArguments(argv) {
  const options = { files: [], relatedLimit: 40, allRelated: false, maxWorkers: 2, tsc: true, tests: true, dryRun: false };
  const number = (flag, value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) usage(`${flag} needs a whole number, not ${value ?? 'nothing'}`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--files-from') options.files.push(...readList(argv[++index] ?? usage('--files-from needs a file')));
    else if (argument === '--related-limit') options.relatedLimit = number(argument, argv[++index]);
    else if (argument === '--max-workers') options.maxWorkers = Math.max(1, number(argument, argv[++index]));
    else if (argument === '--all-related') options.allRelated = true;
    else if (argument === '--no-tsc') options.tsc = false;
    else if (argument === '--no-tests') options.tests = false;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help' || argument === '-h') usage('', 0);
    else if (argument.startsWith('--')) usage(`unknown option ${argument}`);
    else options.files.push(argument);
  }
  options.files = [...new Set(options.files.map(normalize))];
  return options;
}

function readList(file) {
  return readFileSync(file, 'utf8').split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => /^[ACDMRT]\d*\t/u.test(line) ? line.split('\t').at(-1) : line);
}

function normalize(path) {
  return relative(root, resolve(root, path)).split('\\').join('/');
}

/** The workspace packages and the @shannon packages each depends on. */
function packageGraph() {
  const graph = new Map();
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    const manifest = join(root, 'packages', name, 'package.json');
    if (!existsSync(join(root, 'packages', name, 'tsconfig.json')) || !existsSync(manifest)) continue;
    const dependencies = Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {})
      .filter(dependency => dependency.startsWith('@shannon/')).map(dependency => dependency.slice('@shannon/'.length));
    graph.set(name, dependencies);
  }
  return graph;
}

/** services/api always; a package when it changed or depends, directly or not, on a package that changed. */
function typecheckProjects(files) {
  const graph = packageGraph();
  const changed = new Set(files.map(path => /^packages\/([^/]+)\//u.exec(path)?.[1]).filter(name => name && graph.has(name)));
  if (files.length === 0) for (const name of graph.keys()) changed.add(name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, dependencies] of graph) {
      if (!changed.has(name) && dependencies.some(dependency => changed.has(dependency))) {
        changed.add(name);
        grew = true;
      }
    }
  }
  return ['services/api', ...[...graph.keys()].filter(name => changed.has(name)).map(name => `packages/${name}`)];
}

function fixedTests() {
  const stabilization = readdirSync(join(root, API_TESTS)).filter(name => /^stabilization.*\.test\.ts$/u.test(name)).sort()
    .map(name => `${API_TESTS}/${name}`);
  const all = [...FIXED_TESTS, ...stabilization];
  const missing = all.filter(path => !existsSync(join(root, path)));
  for (const path of missing) console.warn(`deploy-check: warning: the fixed test ${path} does not exist; update FIXED_TESTS`);
  return all.filter(path => !missing.includes(path));
}

/** The test files `vitest related` would run for these sources, without running them. */
async function relatedTests(sources) {
  if (sources.length === 0) return [];
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { root, run: true, watch: false, related: sources, passWithNoTests: true });
  try {
    const specifications = await vitest.getRelevantTestSpecifications(['services', 'packages']);
    return [...new Set(specifications.map(specification => normalize(specification.moduleId)))].sort();
  } finally {
    await vitest.close();
  }
}

/** When the related set is too large: the related tests named after a named file (ops.ts → ops*.test.ts), and named tests. */
function nameMatched(related, files) {
  const stems = new Set(files.map(path => basename(path).replace(/\.(?:test\.)?[cm]?[jt]s$/u, '').replace(/\.json$/u, ''))
    .filter(stem => stem.length >= 3));
  return related.filter(path => files.includes(path) || [...stems].some(stem => basename(path).startsWith(stem)));
}

function run(label, command, args) {
  console.log(`\n▶ ${label}`);
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const ok = result.status === 0;
  console.log(`${ok ? '✓' : '✗'} ${label} (${seconds.toFixed(1)} s)`);
  return { label, ok, seconds };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const present = options.files.filter(path => existsSync(join(root, path)));
  const absent = options.files.filter(path => !present.includes(path));
  const sources = present.filter(path => SOURCE_PATTERN.test(path) && basename(path) !== 'package.json');
  const projects = options.tsc ? typecheckProjects(options.files) : [];

  let tests = [];
  let leftToCi = 0;
  let relatedCount = 0;
  if (options.tests) {
    const fixed = fixedTests();
    const started = process.hrtime.bigint();
    const related = (await relatedTests(sources)).filter(path => !fixed.includes(path));
    relatedCount = related.length;
    console.log(`deploy-check: ${related.length} related test files beyond the fixed set `
      + `(found in ${(Number(process.hrtime.bigint() - started) / 1e9).toFixed(1)} s)`);
    let chosen = related;
    if (!options.allRelated && related.length > options.relatedLimit) {
      chosen = nameMatched(related, present);
      leftToCi = related.length - chosen.length;
    }
    tests = [...fixed, ...chosen];
  }

  console.log(`deploy-check: ${options.files.length} named files (${sources.length} sources, ${absent.length} absent, skipped)`);
  console.log(`deploy-check: typecheck ${projects.join(', ') || 'nothing'}`);
  console.log(`deploy-check: ${tests.length} test files`);
  if (leftToCi > 0) {
    console.log(`deploy-check: ${leftToCi} of ${relatedCount} related test files left to CI (over --related-limit `
      + `${options.relatedLimit}); the commit must be green in the api-tests workflow. --all-related runs them here.`);
  }
  if (options.dryRun) {
    for (const path of tests) console.log(`  ${path}`);
    return 0;
  }

  const steps = [];
  for (const project of projects) {
    steps.push(run(`tsc ${project}`, process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', `${project}/tsconfig.json`, '--noEmit']));
  }
  if (tests.length > 0) {
    steps.push(run(`vitest ${tests.length} files`, process.execPath,
      [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, `--maxWorkers=${options.maxWorkers}`]));
  }
  const total = steps.reduce((sum, step) => sum + step.seconds, 0);
  console.log('\ndeploy-check summary');
  for (const step of steps) console.log(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.label} (${step.seconds.toFixed(1)} s)`);
  if (leftToCi > 0) console.log(`  note: ${leftToCi} related test files left to CI`);
  console.log(`  total ${total.toFixed(1)} s`);
  return steps.every(step => step.ok) ? 0 : 1;
}

process.exitCode = await main();
