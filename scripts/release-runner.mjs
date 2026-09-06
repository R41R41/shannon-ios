#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const statePath = resolve(repositoryRoot, '.build/release-runner/latest.json');
const expectedRepository = 'R41R41/shannon-ios';
const defaultAzureHost = 'azure-constant-server';
const remoteDistributionState = '/home/azureuser/shannon-agent-data/testflight-distributor.json';

export function parseArguments(values) {
  const [command = 'inspect', ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (key === 'confirm-external-release') {
      options.confirmExternalRelease = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[toCamelCase(key)] = next;
    index += 1;
  }
  return { command, options };
}

export function repositoryNameFromRemote(remote) {
  const normalized = remote.trim().replace(/\.git$/u, '');
  const match = normalized.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/u);
  return match?.[1] ?? null;
}

export function compareBuildVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) throw new Error('Build versions must be numeric');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseDistributionState(text) {
  const value = JSON.parse(text);
  if (!value || typeof value.version !== 'string' || typeof value.distributedAt !== 'string') {
    throw new Error('Azure TestFlight state is incomplete');
  }
  return { version: value.version, distributedAt: value.distributedAt };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/gu, (_, character) => character.toUpperCase());
}

function run(program, args, options = {}) {
  const output = execFileSync(program, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function git(...args) {
  return run('git', args);
}

function inspectRepository() {
  const branch = git('branch', '--show-current');
  const head = git('rev-parse', 'HEAD');
  const remote = git('remote', 'get-url', 'origin');
  const repository = repositoryNameFromRemote(remote);
  const stagedPaths = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const dirtyLines = git('status', '--porcelain=v1').split('\n').filter(Boolean);
  if (repository !== expectedRepository) throw new Error(`Wrong repository: ${repository ?? remote}`);
  if (branch !== 'main') throw new Error(`Release Runner requires main; current branch is ${branch || '(detached)'}`);
  if (stagedPaths.length > 0) throw new Error(`Staged changes must be committed first: ${stagedPaths.join(', ')}`);
  return { repository, branch, head, remote, dirtyLines };
}

function assertExpectedHead(actual, expected) {
  if (!expected) throw new Error('--expected-head is required for an external release');
  if (actual !== expected) throw new Error(`HEAD changed: expected ${expected}, actual ${actual}`);
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...state }, null, 2)}\n`, { mode: 0o600 });
}

function prepare() {
  const repository = inspectRepository();
  console.log('1/2 Deterministic checks and Debug build');
  run('sh', ['scripts/verify.sh', 'all'], { capture: false });
  console.log('2/2 Unsigned iPhone Release build');
  run('sh', ['scripts/verify.sh', 'release'], { capture: false });
  const result = { phase: 'prepared', outcome: 'passed', ...repository };
  writeState(result);
  return result;
}

function publish(options) {
  if (!options.confirmExternalRelease) {
    throw new Error('External release is locked; pass --confirm-external-release only after current user approval');
  }
  const repository = inspectRepository();
  assertExpectedHead(repository.head, options.expectedHead);
  const remoteHead = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/u)[0] ?? '';
  if (remoteHead !== repository.head) {
    run('git', ['push', 'origin', 'HEAD:main'], { capture: false });
  }
  const result = {
    phase: 'published', outcome: 'passed', head: repository.head,
    push: remoteHead === repository.head ? 'already-current' : 'pushed',
  };
  writeState(result);
  return result;
}

function readAzureDistributionState(host) {
  const python = [
    'import json,pathlib',
    `p=pathlib.Path(${JSON.stringify(remoteDistributionState)})`,
    "print(p.read_text() if p.exists() else '{}')",
  ].join(';');
  const result = spawnSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
    `python3 -c ${shellQuote(python)}`,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Azure status read failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  return parseDistributionState(result.stdout);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function monitor(options) {
  const expectedBuild = options.expectedBuild;
  if (!expectedBuild) throw new Error('--expected-build is required');
  compareBuildVersions(expectedBuild, expectedBuild);
  const timeoutMinutes = positiveNumber(options.timeoutMinutes ?? '60', '--timeout-minutes');
  const pollSeconds = positiveNumber(options.pollSeconds ?? '30', '--poll-seconds');
  const host = options.azureHost ?? defaultAzureHost;
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() <= deadline) {
    const state = readAzureDistributionState(host);
    const comparison = compareBuildVersions(state.version, expectedBuild);
    if (comparison === 0) {
      const result = { phase: 'distributed', outcome: 'passed', expectedBuild, ...state };
      writeState(result);
      return result;
    }
    if (comparison > 0) throw new Error(`Build ${expectedBuild} was superseded by distributed build ${state.version}`);
    console.log(`Waiting for Build ${expectedBuild}; latest distributed is ${state.version}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollSeconds * 1_000));
  }
  throw new Error(`Timed out waiting for TestFlight Build ${expectedBuild}`);
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'inspect') return printResult(inspectRepository());
  if (command === 'prepare') return printResult(prepare());
  if (command === 'publish') return printResult(publish(options));
  if (command === 'monitor') return printResult(await monitor(options));
  if (command === 'run') {
    const prepared = prepare();
    assertExpectedHead(prepared.head, options.expectedHead);
    publish(options);
    return printResult(await monitor(options));
  }
  if (command === 'status') return console.log(readFileSync(statePath, 'utf8').trim());
  throw new Error('Usage: release-runner.mjs inspect|prepare|publish|monitor|run|status');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    writeState({ phase: 'failed', outcome: 'failed', error: message.slice(0, 800) });
    console.error(`[release-runner] ${message}`);
    process.exitCode = 1;
  });
}
