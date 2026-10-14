import type Anthropic from '@anthropic-ai/sdk';
import { SHANNON_FCA_SHARED_CAPABILITY } from '@shannon/cognition';
import { fcaExpectationProblem } from '../../../mind/prediction/predictionPorts.js';
import type { FcaActionExpectation, FcaAffectAppraisal, FcaAuxiliaryResult, FcaSharedContext } from '../../../mind/action/fca/fcaEvidencePorts.js';
import type { FcaDecision, FcaModelInput, FcaToolCall } from '../../../mind/action/fca/fcaPorts.js';

export const FCA_CONTEXT_NAME = 'fca_context';
export const FCA_CONTEXT_INSTRUCTIONS = `${SHANNON_FCA_SHARED_CAPABILITY.text}\n\nThe sharedContext contains one versioned reading of Shannon's shared affect and public observed outcomes. Feelings may inform caution, wording and exploration; they never change facts or authority.
Optionally add one fca_context call beside the actual action/wait/complete calls. Omit it when there is no important prediction or new appraisal. It executes nothing.
An expectation precedes an action, references its zero-based index among actual action calls (excluding fca_context), names a concrete observable in its tool result, and states when evidence is due. Do not predict transport success alone. With text_contains, expected is true or false: whether the result text will contain that text. Use json_pointer only for a JSON result. expectedValue is optional expected personal value, separate from the predicted fact. Probability is a tentative estimate, not a calibrated guarantee.
An appraisal names an already observed eventId from recentOutcomes and its next appraisalRevision. Assess the meaning/value of that evidence, not the tool's success flag. A parent's report of a child's event uses the SAME eventId. Do not appraise unknown outcomes as failures, repeat an unchanged appraisal, or infer a cause from a mismatch. Cause is a short public account of what was observed, never private reasoning. Unknown evidence stays pending/unobserved. No reflection call is required.`;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object' as const, additionalProperties: false, properties, required });
const text = (description: string) => ({ type: 'string', description });
const number = (description: string) => ({ type: 'number', description });
const integer = (description: string) => ({ type: 'integer', description });
const nullableNumber = (description: string) => ({ anyOf: [number(description), { type: 'null' }] });
/**
 * Strict tool schemas reject numeric, length and item-count constraints (a live 400, 2026-10-12: "For 'array' type, property
 * 'maxItems' is not supported"), so every bound is written into the description and `decodeFcaContext` enforces it.
 */
export const FCA_CONTEXT_TOOL: Anthropic.Tool = {
  name: FCA_CONTEXT_NAME, strict: true,
  description: 'Optional pre-action expectations and evidence-linked affect appraisals; does not execute an action. At most 8 expectations and 8 appraisals.',
  input_schema: object({
    expectations: { type: 'array', description: 'At most 8 items.', items: object({
      callIndex: integer('Zero-based index of an actual action call in this response, 0 to 7.'), source: { type: 'string', enum: ['tool_result'] },
      observable: { anyOf: [object({ kind: { type: 'string', enum: ['json_pointer'] },
        path: text('JSON pointer into a JSON result, starting with "/", at most 240 characters; never /ok or /success.') }),
      object({ kind: { type: 'string', enum: ['text_contains'] }, text: text('Nonempty, at most 240 characters.') })] },
      expected: { anyOf: [text('At most 240 characters.'), { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
        description: 'With text_contains: true or false, whether the result text contains the text. With json_pointer: the value there.' },
      probability: nullableNumber('0 to 1.'), expectedValue: nullableNumber('-1 to 1.'), withinMs: integer('1 to 86400000 milliseconds.'),
    }) },
    appraisals: { type: 'array', description: 'At most 8 items.', items: object({
      eventId: text('Nonempty, at most 400 characters.'), revision: integer('At least 1.'),
      value: number('-1 to 1.'), cause: text('Nonempty, at most 240 characters.'), target: text('At most 120 characters.'),
    }) },
  }),
};
/**
 * The context call's expectations and appraisals that hold, and its tool result. An item that does not hold is left out and named in
 * that result with a closed reason, so the model reads the correction beside its actions' results and may state it again next
 * decision; the actions themselves are unaffected (the context executes nothing). Before 2026-10-14 any invalid item threw after the
 * paid answer and left the step unknown (Minecraft operator run 5, task 68395576: FCA_EXPECTATION_INVALID paused the task).
 */
export function decodeFcaContext(content: Anthropic.ContentBlock[], decision: FcaDecision, input: FcaModelInput): {
  expectations?: readonly FcaActionExpectation[]; appraisals?: readonly FcaAffectAppraisal[]; auxiliaryResults?: readonly FcaAuxiliaryResult[];
} {
  const blocks = content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === FCA_CONTEXT_NAME);
  if (!blocks.length) return {};
  // Unreachable: fca_context is offered only beside a shared context, and otherwise turned away as a tool not offered.
  if (!input.sharedContext) throw new Error('FCA_CONTEXT_INVALID');
  const value = blocks.length === 1 ? contextShape(blocks[0]!.input) : null;
  const rejected: FcaContextRejection[] = [];
  if (!value) {
    rejected.push({ item: 'fca_context', reason: 'context_shape' });
    return { expectations: [], appraisals: [], auxiliaryResults: blocks.map(block => contextResult(block.id, rejected, 0, 0)) };
  }
  const calls = decision.kind === 'tools' ? decision.calls : [], context = input.sharedContext;
  const expectations = accepted<FcaActionExpectation>(value.expectations, 'expectations', rejected, (raw, kept) => decodedExpectation(raw, calls, kept));
  const appraisals = accepted<FcaAffectAppraisal>(value.appraisals, 'appraisals', rejected, (raw, kept) => decodedAppraisal(raw, context, kept));
  return { expectations, appraisals, auxiliaryResults: [contextResult(blocks[0]!.id, rejected, expectations.length, appraisals.length)] };
}

/** A closed reason for one item of the context call that was left out, and the rule the model reads for it. */
export interface FcaContextRejection { item: string; reason: keyof typeof CONTEXT_RULES }
const CONTEXT_RULES = Object.freeze({
  context_shape: 'Send one fca_context call with exactly expectations and appraisals, at most 8 of each.',
  not_object: 'Each item is an object.',
  no_action: 'An expectation needs an action call in the same response; a wait or a completion has none.',
  call_index: 'callIndex is the zero-based index of an action call in this response, counting only action calls, never fca_context.',
  fields: 'An expectation has exactly callIndex, source, observable, expected, probability, expectedValue and withinMs.',
  call_id: 'callIndex names one action call of this response.',
  source: 'source is "tool_result".',
  observable: 'observable is {"kind":"json_pointer","path":…} or {"kind":"text_contains","text":…}, with no other field.',
  text_contains_text: 'A text_contains text is nonempty and at most 240 characters.',
  text_contains_expected: 'With text_contains, expected is true or false: whether the tool result text contains that text.',
  json_pointer_path: 'A json_pointer path starts with "/" and has at most 240 characters; use it only for a tool result that is JSON.',
  transport_success: 'Predict a concrete fact of the result, never /ok or /success (transport success).',
  expected: 'expected is null, true or false, a finite number, or a text of at most 240 characters.',
  probability: 'probability is null or from 0 to 1.',
  expected_value: 'expectedValue is null or from -1 to 1.',
  within_ms: 'withinMs is a whole number of milliseconds from 1 to 86400000.',
  duplicate_call: 'At most one expectation for each action call.',
  appraisal_fields: 'An appraisal has exactly eventId, revision, value, cause and target.',
  appraisal_event: 'eventId names an observed event of sharedContext.recentOutcomes; an unknown outcome is not appraised.',
  appraisal_revision: 'revision is that event\'s appraisalRevision plus 1.',
  appraisal_value: 'value is from -1 to 1.',
  appraisal_cause: 'cause is a nonempty public account of at most 240 characters.',
  appraisal_target: 'target has at most 120 characters.',
  duplicate_event: 'At most one appraisal for each event.',
});
type ContextReason = FcaContextRejection['reason'];
const EXPECTATION_FIELDS = 'expected,expectedValue,observable,probability,source,withinMs';
const APPRAISAL_FIELDS = 'cause,eventId,revision,target,value';

function contextShape(raw: unknown): { expectations: unknown[]; appraisals: unknown[] } | null {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!value || Object.keys(value).sort().join(',') !== 'appraisals,expectations') return null;
  const { expectations, appraisals } = value;
  if (!Array.isArray(expectations) || !Array.isArray(appraisals) || expectations.length > 8 || appraisals.length > 8) return null;
  return { expectations, appraisals };
}
/** The items that hold, in order; each other one is named with its reason. */
function accepted<T>(items: readonly unknown[], field: string, rejected: FcaContextRejection[],
  decode: (raw: unknown, kept: readonly T[]) => { kept: T } | ContextReason): T[] {
  const kept: T[] = [];
  items.forEach((raw, index) => {
    const decoded = decode(raw, kept);
    if (typeof decoded === 'string') rejected.push({ item: `${field}[${index}]`, reason: decoded });
    else kept.push(decoded.kept);
  });
  return kept;
}
function decodedExpectation(raw: unknown, calls: readonly FcaToolCall[], kept: readonly FcaActionExpectation[]): { kept: FcaActionExpectation } | ContextReason {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not_object';
  const { callIndex, ...candidate } = raw as Record<string, unknown>;
  if (!calls.length) return 'no_action';
  if (typeof callIndex !== 'number' || !Number.isSafeInteger(callIndex) || callIndex < 0 || !calls[callIndex]) return 'call_index';
  if (Object.keys(candidate).sort().join(',') !== EXPECTATION_FIELDS) return 'fields';
  const expectation = { ...candidate, callId: calls[callIndex]!.id } as unknown as FcaActionExpectation;
  const problem = fcaExpectationProblem(expectation);
  if (problem) return problem;
  return kept.some(item => item.callId === expectation.callId) ? 'duplicate_call' : { kept: expectation };
}
function decodedAppraisal(raw: unknown, context: FcaSharedContext, kept: readonly FcaAffectAppraisal[]): { kept: FcaAffectAppraisal } | ContextReason {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not_object';
  const item = raw as FcaAffectAppraisal;
  if (Object.keys(item).sort().join(',') !== APPRAISAL_FIELDS) return 'appraisal_fields';
  const event = context.recentOutcomes.find(outcome => outcome.eventId === item.eventId);
  if (!event || event.observation !== 'observed') return 'appraisal_event';
  if (item.revision !== event.appraisalRevision + 1) return 'appraisal_revision';
  const problem = appraisalTextProblem(item);
  if (problem) return problem;
  return kept.some(other => other.eventId === item.eventId) ? 'duplicate_event' : { kept: item };
}
function appraisalTextProblem(item: FcaAffectAppraisal): ContextReason | null {
  if (!Number.isFinite(item.value) || Math.abs(item.value) > 1) return 'appraisal_value';
  if (typeof item.cause !== 'string' || !item.cause.trim() || item.cause.length > 240) return 'appraisal_cause';
  return typeof item.target !== 'string' || item.target.length > 120 ? 'appraisal_target' : null;
}
/**
 * The context call's tool result: received, or a correction naming each item left out with its rule (an error result, so the model
 * notices it). Closed reasons only, logged content-free so that the next such answer says which rule it broke.
 */
function contextResult(id: string, rejected: readonly FcaContextRejection[], expectations: number, appraisals: number): FcaAuxiliaryResult {
  if (!rejected.length) return { id, ok: true, text: JSON.stringify({ received: true }) };
  console.info(JSON.stringify({ event: 'fca_context_rejected', acceptedExpectations: expectations, acceptedAppraisals: appraisals,
    rejected: rejected.map(item => `${item.item}:${item.reason}`) }));
  return { id, ok: false, text: JSON.stringify({ received: true, accepted: { expectations, appraisals },
    rejected: rejected.map(item => ({ item: item.item, reason: item.reason, rule: CONTEXT_RULES[item.reason] })),
    note: 'The rejected items were not recorded. The action calls are unaffected. Restate a corrected item in a later fca_context only if it still matters.' }) };
}
