import type {
  CompanionStateEvent,
  CompanionStateSnapshot,
  MemorySearchDocument,
  RecallCandidate,
  SemanticRecallHit,
  ShannonCognitiveFrame,
  ShannonIntent,
  ShannonMemoryQuery,
  ShannonSituationSnapshot,
} from '@shannon/cognition';

export type CognitiveScenarioCategory =
  | 'state-transition'
  | 'memory-visibility'
  | 'recall'
  | 'memory-search'
  | 'semantic-fallback'
  | 'affect'
  | 'intent-selection'
  | 'prompt-projection';

export type CognitiveExpectation =
  | { type: 'selected-memory-ids'; value: readonly string[] }
  | { type: 'excluded-memory-ids'; value: readonly string[] }
  | { type: 'primary-intent-id'; value: string | null }
  | { type: 'state-equals'; path: string; value: unknown }
  | { type: 'number-in-range'; path: string; minimum: number; maximum: number }
  | { type: 'text-includes'; value: string }
  | { type: 'text-excludes'; value: string }
  | { type: 'collection-limit'; path: string; maximum: number };

export interface CognitiveEvaluationInput {
  now: string;
  scopeKey?: string;
  initialState?: unknown;
  events?: readonly CompanionStateEvent[];
  affect?: { message: string };
  recall?: { query: ShannonMemoryQuery; candidates: readonly RecallCandidate[]; maximum?: number };
  memorySearch?: { query: string; documents: readonly MemorySearchDocument[]; limit?: number };
  /** Deterministic recall followed by a semantic stage that succeeded, failed, or timed out. */
  semanticRecall?: {
    query: ShannonMemoryQuery;
    candidates: readonly RecallCandidate[];
    status: 'used' | 'failed' | 'timeout';
    hits: readonly SemanticRecallHit[];
  };
  intents?: { message: string; threadId: string; values: readonly ShannonIntent[] };
  prompt?:
    | { kind: 'state'; snapshot?: CompanionStateSnapshot; maximumCharacters?: number }
    | { kind: 'intent'; frame: ShannonCognitiveFrame; maximumCharacters?: number }
    | { kind: 'turn'; situation: ShannonSituationSnapshot; memoryIDs?: readonly string[]; maximumCharacters?: number };
}

export interface CognitiveEvaluationScenario {
  schemaVersion: 1;
  id: string;
  category: CognitiveScenarioCategory;
  description: string;
  input: CognitiveEvaluationInput;
  expected: readonly CognitiveExpectation[];
}

export interface CognitiveEvaluationOutput {
  state?: CompanionStateSnapshot;
  emotion?: CompanionStateSnapshot['emotion'];
  selectedMemoryIDs?: readonly string[];
  primaryIntentID?: string | null;
  text?: string;
  error?: string;
}

const categories = new Set<CognitiveScenarioCategory>([
  'state-transition', 'memory-visibility', 'recall', 'memory-search', 'semantic-fallback', 'affect', 'intent-selection', 'prompt-projection',
]);
export function isCognitiveEvaluationScenario(value: unknown): value is CognitiveEvaluationScenario {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.id !== 'string' || !row.id.trim()
    || typeof row.description !== 'string' || !categories.has(row.category as CognitiveScenarioCategory)
    || !row.input || typeof row.input !== 'object' || !Array.isArray(row.expected)) return false;
  const input = row.input as Record<string, unknown>;
  if (typeof input.now !== 'string' || !Number.isFinite(Date.parse(input.now))) return false;
  return row.expected.every(isCognitiveExpectation);
}

function isCognitiveExpectation(value: unknown): value is CognitiveExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectation = value as Record<string, unknown>;
  switch (expectation.type) {
    case 'selected-memory-ids':
    case 'excluded-memory-ids':
      return isStringArray(expectation.value);
    case 'primary-intent-id':
      return expectation.value === null || typeof expectation.value === 'string';
    case 'state-equals':
      return isPath(expectation.path)
        && Object.hasOwn(expectation, 'value')
        && expectation.value !== undefined;
    case 'number-in-range':
      return isPath(expectation.path)
        && isFiniteNumber(expectation.minimum)
        && isFiniteNumber(expectation.maximum)
        && expectation.minimum <= expectation.maximum;
    case 'text-includes':
    case 'text-excludes':
      return typeof expectation.value === 'string';
    case 'collection-limit':
      return isPath(expectation.path)
        && Number.isInteger(expectation.maximum)
        && isFiniteNumber(expectation.maximum)
        && expectation.maximum >= 0;
    default:
      return false;
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
