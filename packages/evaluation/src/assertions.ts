import type {
  CognitiveEvaluationOutput,
  CognitiveExpectation,
} from './scenario.js';

export interface CognitiveAssertionResult {
  type: CognitiveExpectation['type'] | 'scenario-validity';
  status: 'passed' | 'failed';
  path?: string;
  message: string;
}

function atPath(source: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateExpectation(
  output: CognitiveEvaluationOutput,
  expectation: CognitiveExpectation,
): CognitiveAssertionResult {
  switch (expectation.type) {
    case 'selected-memory-ids': {
      const passed = sameValue(output.selectedMemoryIDs ?? [], expectation.value);
      return result(expectation.type, passed, 'selectedMemoryIDs');
    }
    case 'excluded-memory-ids': {
      const selected = new Set(output.selectedMemoryIDs ?? []);
      const passed = expectation.value.every(id => !selected.has(id));
      return result(expectation.type, passed, 'selectedMemoryIDs');
    }
    case 'primary-intent-id':
      return result(expectation.type, output.primaryIntentID === expectation.value, 'primaryIntentID');
    case 'state-equals': {
      const actual = atPath(output, expectation.path);
      return result(expectation.type, sameValue(actual, expectation.value), expectation.path);
    }
    case 'number-in-range': {
      const actual = atPath(output, expectation.path);
      const passed = typeof actual === 'number' && actual >= expectation.minimum && actual <= expectation.maximum;
      return result(expectation.type, passed, expectation.path);
    }
    case 'text-includes':
      return result(expectation.type, (output.text ?? '').includes(expectation.value), 'text');
    case 'text-excludes':
      return result(expectation.type, !(output.text ?? '').includes(expectation.value), 'text');
    case 'collection-limit': {
      const actual = atPath(output, expectation.path);
      return result(expectation.type, Array.isArray(actual) && actual.length <= expectation.maximum, expectation.path);
    }
  }
}

function result(
  type: CognitiveAssertionResult['type'],
  passed: boolean,
  path?: string,
): CognitiveAssertionResult {
  return {
    type,
    status: passed ? 'passed' : 'failed',
    ...(path ? { path } : {}),
    message: passed ? 'Expectation satisfied.' : 'Expectation did not match the cognitive output.',
  };
}
