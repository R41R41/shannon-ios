import {
  buildCompanionStatePrompt,
  buildIntentPrompt,
  buildTurnCognitivePrompt,
  createInitialCompanionState,
  projectEmotionReaction,
  reduceCompanionState,
  restoreCompanionState,
  searchMemoryDocuments,
  selectContextualMemories,
  selectPrimaryIntent,
} from '@shannon/cognition';
import { evaluateExpectation, type CognitiveAssertionResult } from './assertions.js';
import {
  isCognitiveEvaluationScenario,
  type CognitiveEvaluationOutput,
  type CognitiveEvaluationScenario,
} from './scenario.js';
import {
  stableFingerprint,
  type CognitiveEvaluationReport,
  type CognitiveScenarioResult,
} from './report.js';

export interface EvaluationRunContext {
  implementationRevision: string;
  generatedAt: string;
}

export function runCognitiveEvaluation(
  candidates: readonly unknown[],
  context: EvaluationRunContext,
): CognitiveEvaluationReport {
  const duplicateIDs = repeatedScenarioIDs(candidates);
  const results = candidates.map(candidate => runScenario(candidate, duplicateIDs));
  const totals = {
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    invalid: results.filter(result => result.status === 'invalid').length,
  };
  const status = totals.invalid > 0 ? 'invalid' : totals.failed > 0 ? 'failed' : 'passed';
  const scenarioSetFingerprint = stableFingerprint(candidates
    .map(candidate => stableFingerprint(candidate)).sort());
  return {
    schemaVersion: 1,
    implementationRevision: context.implementationRevision,
    scenarioSetFingerprint,
    status,
    generatedAt: context.generatedAt,
    results,
    totals,
  };
}

function runScenario(candidate: unknown, duplicateIDs: ReadonlySet<string>): CognitiveScenarioResult {
  if (!isCognitiveEvaluationScenario(candidate)) return invalidResult(candidate, 'Scenario schema is invalid.');
  if (duplicateIDs.has(candidate.id)) return invalidResult(candidate, 'Scenario ID is duplicated.');
  let output: CognitiveEvaluationOutput;
  try {
    output = executeScenario(candidate);
  } catch (error) {
    output = { error: error instanceof Error ? error.message : 'Unknown cognitive error.' };
  }
  const assertions = candidate.expected.map(expectation => evaluateExpectation(output, expectation));
  const status = assertions.every(assertion => assertion.status === 'passed') ? 'passed' : 'failed';
  return {
    scenarioId: candidate.id,
    status,
    assertions,
    fingerprint: stableFingerprint({ id: candidate.id, output, assertions }),
    durationMilliseconds: 0,
  };
}

function executeScenario(scenario: CognitiveEvaluationScenario): CognitiveEvaluationOutput {
  const { input } = scenario;
  const scopeKey = input.scopeKey ?? 'synthetic:evaluation';
  let state = input.initialState === undefined
    ? createInitialCompanionState(scopeKey, input.now)
    : restoreCompanionState(scopeKey, input.initialState, input.now);
  for (const event of input.events ?? []) state = reduceCompanionState(state, event, input.now);
  const output: CognitiveEvaluationOutput = { state };
  if (input.affect) output.emotion = projectEmotionReaction(state, input.affect.message);
  if (input.recall) output.selectedMemoryIDs = selectContextualMemories(
    input.recall.query, input.recall.candidates, input.recall.maximum,
  ).map(memory => memory.id);
  if (input.memorySearch) output.selectedMemoryIDs = searchMemoryDocuments(
    input.memorySearch.query, input.memorySearch.documents, input.memorySearch.limit,
  ).map(document => document.id);
  if (input.intents) output.primaryIntentID = selectPrimaryIntent(
    input.intents.message, input.intents.threadId, input.intents.values, input.now,
  )?.id ?? null;
  if (input.prompt?.kind === 'state') output.text = buildCompanionStatePrompt(
    input.prompt.snapshot ?? state,
    { maximumCharacters: input.prompt.maximumCharacters },
  );
  if (input.prompt?.kind === 'intent') output.text = buildIntentPrompt(
    input.prompt.frame, input.prompt.maximumCharacters,
  );
  if (input.prompt?.kind === 'turn') {
    const memories = (input.prompt.memoryIDs ?? []).map((id, index) => ({
      id,
      summary: `synthetic memory ${id}`,
      observedAt: input.now,
      relevance: 1 - index / 10,
      reasons: ['words'] as const,
    }));
    output.text = buildTurnCognitivePrompt(
      input.prompt.situation, memories, input.prompt.maximumCharacters,
    );
  }
  return output;
}

function repeatedScenarioIDs(candidates: readonly unknown[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = (candidate as Record<string, unknown>).id;
    if (typeof id !== 'string') continue;
    if (seen.has(id)) duplicate.add(id);
    seen.add(id);
  }
  return duplicate;
}

function invalidResult(candidate: unknown, message: string): CognitiveScenarioResult {
  const id = candidate && typeof candidate === 'object'
    && typeof (candidate as Record<string, unknown>).id === 'string'
    ? String((candidate as Record<string, unknown>).id)
    : '<invalid>';
  const assertions: CognitiveAssertionResult[] = [{
    type: 'scenario-validity', status: 'failed', message,
  }];
  return {
    scenarioId: id,
    status: 'invalid',
    assertions,
    fingerprint: stableFingerprint({ id, message }),
    durationMilliseconds: 0,
  };
}
