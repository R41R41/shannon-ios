#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

async function text(path) {
  try {
    return await readFile(resolve(root, path), 'utf8');
  } catch {
    failures.push(`missing required file: ${path}`);
    return '';
  }
}

function requireText(source, pattern, description) {
  if (!pattern.test(source)) failures.push(description);
}

const requiredFiles = [
  'AGENTS.md',
  'README.md',
  'docs/architecture.md',
  'docs/DESIGN.md',
  'docs/BRANCHING.md',
  'docs/self-improvement-runbook.md',
  'docs/design/screens/macos/talk.yaml',
  'services/api/tests/fixtures/voyager-phase1/minimal-create.request.json',
  'services/api/tests/fixtures/voyager-phase1/minimal-create.result.json',
  'services/api/tests/fixtures/voyager-phase2/projects.response.json',
  'services/api/tests/fixtures/voyager-phase2/task-search.response.json',
  'services/api/tests/fixtures/voyager-phase2/update.request.json',
];

await Promise.all(requiredFiles.map(async path => {
  try { await access(resolve(root, path)); }
  catch { failures.push(`missing required file: ${path}`); }
}));

const readme = await text('README.md');
for (const concern of ['Product', 'Architecture', 'Design', 'Release', 'Branching', 'Verification']) {
  requireText(readme, new RegExp(`\\| ${concern} \\|`), `README canonical index is missing ${concern}`);
}
requireText(readme, /docs\/shannon-\*\.html[^\n]*(?:履歴|non-authoritative|正本ではない)/, 'README must mark historical HTML documents as non-authoritative');

const branching = await text('docs/BRANCHING.md');
for (const phrase of ['codex/shannon/<work-id>', 'active', 'waiting', 'integrated', 'abandoned', 'unknown', 'clean `main`']) {
  requireText(branching, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `branching guide is missing: ${phrase}`);
}

const screen = await text('docs/design/screens/macos/talk.yaml');
for (const key of ['user_job', 'primary_action', 'preserve', 'improve', 'do_not_change', 'states', 'accessibility', 'evidence', 'baseline_commit', 'last_verified_at']) {
  requireText(screen, new RegExp(`^${key}:`, 'm'), `screen contract is missing top-level key: ${key}`);
}
for (const state of ['loading', 'empty', 'error', 'offline', 'conflict', 'selection']) {
  requireText(screen, new RegExp(`^  ${state}:`, 'm'), `screen contract is missing state: ${state}`);
}
for (const field of ['dynamic_type', 'voiceover', 'target_size', 'focus', 'reduce_motion']) {
  requireText(screen, new RegExp(`^  ${field}:`, 'm'), `screen contract is missing accessibility field: ${field}`);
}

for (const [path, expectedVersion] of [
  ['services/api/tests/fixtures/voyager-phase1/minimal-create.request.json', '1.0'],
  ['services/api/tests/fixtures/voyager-phase1/minimal-create.result.json', '1.0'],
  ['services/api/tests/fixtures/voyager-phase2/projects.response.json', '1.1'],
  ['services/api/tests/fixtures/voyager-phase2/task-search.response.json', '1.1'],
  ['services/api/tests/fixtures/voyager-phase2/update.request.json', '1.1'],
]) {
  const fixture = await text(path);
  try {
    const parsed = JSON.parse(fixture);
    if (parsed.contractVersion !== expectedVersion) failures.push(`${path} must use contractVersion ${expectedVersion}`);
  } catch {
    failures.push(`${path} must contain valid JSON`);
  }
}

if (failures.length > 0) {
  console.error('Shannon harness check failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Shannon harness check passed (${requiredFiles.length} required files, 1 screen contract, 5 cross-app fixtures).`);
