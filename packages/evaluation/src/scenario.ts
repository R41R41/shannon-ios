import type {
  CompanionStateEvent,
  CompanionStateSnapshot,
  RecallCandidate,
  ShannonCognitiveFrame,
  ShannonIntent,
  ShannonMemoryQuery,
  ShannonSituationSnapshot,
} from '@shannon/cognition';

export type CognitiveScenarioCategory =
  | 'state-transition'
  | 'memory-visibility'
  | 'recall'
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
  'state-transition', 'memory-visibility', 'recall', 'affect', 'intent-selection', 'prompt-projection',
]);
const expectationTypes = new Set<CognitiveExpectation['type']>([
  'selected-memory-ids', 'excluded-memory-ids', 'primary-intent-id', 'state-equals',
  'number-in-range', 'text-includes', 'text-excludes', 'collection-limit',
]);

export function isCognitiveEvaluationScenario(value: unknown): value is CognitiveEvaluationScenario {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.id !== 'string' || !row.id.trim()
    || typeof row.description !== 'string' || !categories.has(row.category as CognitiveScenarioCategory)
    || !row.input || typeof row.input !== 'object' || !Array.isArray(row.expected)) return false;
  const input = row.input as Record<string, unknown>;
  if (typeof input.now !== 'string' || !Number.isFinite(Date.parse(input.now))) return false;
  return row.expected.every(item => item && typeof item === 'object'
    && expectationTypes.has((item as Record<string, unknown>).type as CognitiveExpectation['type']));
}
