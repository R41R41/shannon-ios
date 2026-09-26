import type { CognitiveAssertionResult } from './assertions.js';

export interface CognitiveScenarioResult {
  scenarioId: string;
  status: 'passed' | 'failed' | 'invalid';
  assertions: readonly CognitiveAssertionResult[];
  fingerprint: string;
  durationMilliseconds: number;
}

export interface CognitiveEvaluationReport {
  schemaVersion: 1;
  implementationRevision: string;
  scenarioSetFingerprint: string;
  status: 'passed' | 'failed' | 'invalid';
  generatedAt: string;
  results: readonly CognitiveScenarioResult[];
  totals: { passed: number; failed: number; invalid: number };
}

export function stableFingerprint(value: unknown): string {
  const text = JSON.stringify(canonical(value));
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}
