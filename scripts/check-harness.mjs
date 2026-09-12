#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
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
  'docs/README.md',
  'docs/architecture.md',
  'docs/DESIGN.md',
  'docs/BRANCHING.md',
  'docs/self-improvement-runbook.md',
  'docs/archive/index.md',
  'docs/design/semantic-role-map.v1.json',
  'docs/design/screens/macos/talk.yaml',
  'docs/design/screens/ios/talk.yaml',
  'docs/design/screens/ios/work.yaml',
  'scripts/check-semantic-role-map.mjs',
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
requireText(readme, /docs\/archive\/\*\*\/\*\.html[^\n]*(?:履歴|non-authoritative|正本ではない)/, 'README must mark archived HTML documents as non-authoritative');
if (/\]\([^)]*\.html\)/.test(readme)) failures.push('README must not link directly to archived HTML');

const docsEntries = await readdir(resolve(root, 'docs'), { withFileTypes: true });
for (const entry of docsEntries) {
  if (entry.isFile() && entry.name.endsWith('.html')) failures.push(`top-level historical HTML must be archived: docs/${entry.name}`);
}

async function archivedHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return archivedHtmlFiles(path);
    return entry.isFile() && entry.name.endsWith('.html') ? [path] : [];
  }));
  return nested.flat();
}

const archiveIndex = await text('docs/archive/index.md');
const archivedHtml = await archivedHtmlFiles(resolve(root, 'docs/archive'));
for (const absolutePath of archivedHtml) {
  const archiveRelativePath = relative(resolve(root, 'docs/archive'), absolutePath);
  if (!archiveIndex.includes(`(${archiveRelativePath})`)) failures.push(`archive index is missing: ${archiveRelativePath}`);
}

const branching = await text('docs/BRANCHING.md');
for (const phrase of ['codex/shannon/<work-id>', 'active', 'waiting', 'integrated', 'abandoned', 'unknown', 'clean `main`']) {
  requireText(branching, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `branching guide is missing: ${phrase}`);
}

const screenContracts = [
  'docs/design/screens/macos/talk.yaml',
  'docs/design/screens/ios/talk.yaml',
  'docs/design/screens/ios/work.yaml',
];
for (const path of screenContracts) {
  const screen = await text(path);
  for (const key of ['user_job', 'primary_action', 'preserve', 'improve', 'do_not_change', 'states', 'accessibility', 'evidence', 'baseline_commit', 'last_verified_at']) {
    requireText(screen, new RegExp(`^${key}:`, 'm'), `${path} is missing top-level key: ${key}`);
  }
  for (const state of ['loading', 'empty', 'error', 'offline', 'conflict', 'selection']) {
    requireText(screen, new RegExp(`^  ${state}:`, 'm'), `${path} is missing state: ${state}`);
  }
  for (const field of ['dynamic_type', 'voiceover', 'target_size', 'focus', 'reduce_motion']) {
    requireText(screen, new RegExp(`^  ${field}:`, 'm'), `${path} is missing accessibility field: ${field}`);
  }
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

console.log(`Shannon harness check passed (${requiredFiles.length} required files, ${archivedHtml.length} archived HTML files, ${screenContracts.length} screen contracts, 5 cross-app fixtures).`);
