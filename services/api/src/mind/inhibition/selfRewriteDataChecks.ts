import { basename, extname } from 'node:path';
import type { SelfRewriteCandidate } from './selfRewritePorts.js';
import { checkRewriteCode, safeRewriteCode } from './selfRewriteCodeChecks.js';

/** Actual closed format/content checks. Code execution tests are never inferred from syntax or model prose. */
export function checkRewriteData(candidate: SelfRewriteCandidate): boolean {
  return formatChecks(candidate) && checkRewriteCode(candidate.files);
}
function formatChecks(candidate: SelfRewriteCandidate): boolean {
  return candidate.files.every(file => {
    const extension = extname(file.path).toLowerCase();
    if (!['.json', '.txt', '.md', '.mjs'].includes(extension) || file.content === null) return false;
    if (!file.content.trim() || Buffer.byteLength(file.content) > 64_000 || file.content.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(file.content)) return false;
    if (extension !== '.json') return true;
    try { return dataValue(JSON.parse(file.content), 0); } catch { return false; }
  });
}
/** Data cannot alter a loader, manifest, authentication, permission, executable template or runtime policy. */
export function safeRewriteData(candidate: SelfRewriteCandidate): boolean {
  return formatChecks(candidate) && safeRewriteCode(candidate.files) && candidate.files.every(file => {
    const name = basename(file.path).toLowerCase();
    if (file.path.split(/[\\/]/u).some(part => part.startsWith('.')) || /^(?:package|tsconfig|deno|composer|appsettings)(?:\.|$)/u.test(name)
      || /^(?:agents|skill|claude|instructions)\.md$/u.test(name)) return false;
    if (extname(file.path).toLowerCase() === '.json') {
      try { return noPolicyKeys(JSON.parse(file.content!)); } catch { return false; }
    }
    return !/(?:<\s*script\b|#!|\b(?:eval|exec|spawn)\s*\(|process\s*\.\s*(?:env|exit|kill)|(?:token|api[_ -]?key|password|secret)\s*[:=])/iu.test(file.content!);
  });
}
function dataValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return !value.includes('\0');
  if (Array.isArray(value)) return value.every(item => dataValue(item, depth + 1));
  return !!value && typeof value === 'object' && Object.entries(value).every(([key, item]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) && dataValue(item, depth + 1));
}
function noPolicyKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, item]) => !/^(?:auth(?:entication|orization)?|permission|budget|persona|prompt|deployment|scripts|token|password|secret|api[_-]?key|replicat(?:ion|esSelf))$/iu.test(key)
    && noPolicyKeys(item));
}
