#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mappingPath = 'docs/design/semantic-role-map.v1.json';
const implementationPath = 'apps/ios/Sources/ShannonAppCore/DesignSystem/ShannonDesignSystem.swift';
const failures = [];
const requiredRoles = [
  'action', 'creation', 'intelligence', 'attention', 'success', 'danger',
  'canvas', 'readingSurface', 'textPrimary', 'textSecondary', 'border', 'divider',
];
const tokenReference = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function exactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (actual.join('\n') !== wanted.join('\n')) {
    failures.push(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
}

function validRepositoryPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.split('/').includes('..')) {
    failures.push(`${label} must be a repository-relative path without '..'`);
    return false;
  }
  return true;
}

let mapping;
try {
  mapping = JSON.parse(await readFile(resolve(root, mappingPath), 'utf8'));
} catch {
  console.error(`Semantic role map check failed:\n- ${mappingPath} must contain valid JSON`);
  process.exit(1);
}

exactKeys(mapping, ['contract', 'appId', 'ownership', 'roles', 'accessibility', 'evidence'], 'top-level');
if (mapping.contract !== 'syzygy.semantic-role-map.v1') failures.push('contract must be syzygy.semantic-role-map.v1');
if (mapping.appId !== 'shannon') failures.push('appId must be shannon');

exactKeys(mapping.ownership, ['exactValues', 'components'], 'ownership');
if (mapping.ownership?.exactValues !== 'app-owned') failures.push('ownership.exactValues must be app-owned');
if (mapping.ownership?.components !== 'app-owned') failures.push('ownership.components must be app-owned');

if (!mapping.roles || typeof mapping.roles !== 'object' || Array.isArray(mapping.roles)) {
  failures.push('roles must be an object');
} else {
  for (const role of requiredRoles) {
    if (!(role in mapping.roles)) failures.push(`roles is missing required role: ${role}`);
  }
  for (const [role, reference] of Object.entries(mapping.roles)) {
    if (typeof reference !== 'string' || !tokenReference.test(reference)) {
      failures.push(`roles.${role} must be a semantic token reference`);
    }
  }
}

exactKeys(mapping.accessibility, ['colorIndependent', 'contrastValidated'], 'accessibility');
if (mapping.accessibility?.colorIndependent !== true) failures.push('accessibility.colorIndependent must be true');
if (mapping.accessibility?.contrastValidated !== true) failures.push('accessibility.contrastValidated must be true');

exactKeys(mapping.evidence, ['designAuthority', 'validator', 'screenContracts'], 'evidence');
const evidencePaths = [];
for (const field of ['designAuthority', 'validator']) {
  const value = mapping.evidence?.[field];
  if (validRepositoryPath(value, `evidence.${field}`)) evidencePaths.push(value);
}
if (mapping.evidence?.validator !== 'scripts/check-semantic-role-map.mjs') {
  failures.push('evidence.validator must point to scripts/check-semantic-role-map.mjs');
}
if (!Array.isArray(mapping.evidence?.screenContracts) || mapping.evidence.screenContracts.length === 0) {
  failures.push('evidence.screenContracts must contain at least one path');
} else {
  for (const [index, value] of mapping.evidence.screenContracts.entries()) {
    if (validRepositoryPath(value, `evidence.screenContracts[${index}]`)) evidencePaths.push(value);
  }
}
await Promise.all(evidencePaths.map(async path => {
  try { await access(resolve(root, path)); }
  catch { failures.push(`evidence path does not exist: ${path}`); }
}));

const implementation = await readFile(resolve(root, implementationPath), 'utf8');
for (const [role, reference] of Object.entries(mapping.roles ?? {})) {
  const token = reference.split('.').at(-1);
  const declaration = new RegExp(`\\blet\\s+${token}\\s*:\\s*Color\\b`);
  if (!declaration.test(implementation)) {
    failures.push(`roles.${role} references undeclared ShannonPalette token: ${reference}`);
  }
}

if (failures.length > 0) {
  console.error('Semantic role map check failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Semantic role map check passed (${Object.keys(mapping.roles).length} app-owned roles).`);
