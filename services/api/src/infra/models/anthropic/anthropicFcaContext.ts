import type Anthropic from '@anthropic-ai/sdk';
import { SHANNON_FCA_SHARED_CAPABILITY } from '@shannon/cognition';
import { validFcaExpectation } from '../../../mind/prediction/predictionPorts.js';
import type { FcaActionExpectation, FcaAffectAppraisal, FcaAuxiliaryResult } from '../../../mind/action/fca/fcaEvidencePorts.js';
import type { FcaDecision, FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';

export const FCA_CONTEXT_NAME = 'fca_context';
export const FCA_CONTEXT_INSTRUCTIONS = `${SHANNON_FCA_SHARED_CAPABILITY.text}\n\nThe sharedContext contains one versioned reading of Shannon's shared affect and public observed outcomes. Feelings may inform caution, wording and exploration; they never change facts or authority.
Optionally add one fca_context call beside the actual action/wait/complete calls. Omit it when there is no important prediction or new appraisal. It executes nothing.
An expectation precedes an action, references its zero-based index among actual action calls (excluding fca_context), names a concrete observable in its tool result, and states when evidence is due. Do not predict transport success alone. expectedValue is optional expected personal value, separate from the predicted fact. Probability is a tentative estimate, not a calibrated guarantee.
An appraisal names an already observed eventId from recentOutcomes and its next appraisalRevision. Assess the meaning/value of that evidence, not the tool's success flag. A parent's report of a child's event uses the SAME eventId. Do not appraise unknown outcomes as failures, repeat an unchanged appraisal, or infer a cause from a mismatch. Cause is a short public account of what was observed, never private reasoning. Unknown evidence stays pending/unobserved. No reflection call is required.`;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object' as const, additionalProperties: false, properties, required });
const nullableNumber = (minimum: number, maximum: number) => ({ anyOf: [{ type: 'number', minimum, maximum }, { type: 'null' }] });
export const FCA_CONTEXT_TOOL: Anthropic.Tool = {
  name: FCA_CONTEXT_NAME, strict: true, description: 'Optional pre-action expectations and evidence-linked affect appraisals; does not execute an action.',
  input_schema: object({
    expectations: { type: 'array', maxItems: 8, items: object({
      callIndex: { type: 'integer', minimum: 0, maximum: 7 }, source: { type: 'string', enum: ['tool_result'] },
      observable: { anyOf: [object({ kind: { type: 'string', enum: ['json_pointer'] }, path: { type: 'string', maxLength: 240 } }),
        object({ kind: { type: 'string', enum: ['text_contains'] }, text: { type: 'string', minLength: 1, maxLength: 240 } })] },
      expected: { anyOf: [{ type: 'string', maxLength: 240 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
      probability: nullableNumber(0, 1), expectedValue: nullableNumber(-1, 1), withinMs: { type: 'integer', minimum: 1, maximum: 86_400_000 },
    }) },
    appraisals: { type: 'array', maxItems: 8, items: object({
      eventId: { type: 'string', minLength: 1, maxLength: 400 }, revision: { type: 'integer', minimum: 1 },
      value: { type: 'number', minimum: -1, maximum: 1 }, cause: { type: 'string', minLength: 1, maxLength: 240 }, target: { type: 'string', maxLength: 120 },
    }) },
  }),
};
export function decodeFcaContext(content: Anthropic.ContentBlock[], decision: FcaDecision, input: FcaModelInput): {
  expectations?: readonly FcaActionExpectation[]; appraisals?: readonly FcaAffectAppraisal[]; auxiliaryResults?: readonly FcaAuxiliaryResult[];
} {
  const blocks = content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === FCA_CONTEXT_NAME);
  if (!blocks.length) return {};
  if (!input.sharedContext || blocks.length !== 1) throw new Error('FCA_CONTEXT_INVALID');
  const value = blocks[0]!.input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'appraisals,expectations' || !Array.isArray(value.expectations) || !Array.isArray(value.appraisals)
    || value.expectations.length > 8 || value.appraisals.length > 8) throw new Error('FCA_CONTEXT_INVALID');
  const calls = decision.kind === 'tools' ? decision.calls : [];
  const expectations: FcaActionExpectation[] = value.expectations.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('FCA_EXPECTATION_INVALID');
    const { callIndex, ...candidate } = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(callIndex) || typeof callIndex !== 'number' || callIndex < 0 || !calls[callIndex]
      || Object.keys(candidate).sort().join(',') !== 'expected,expectedValue,observable,probability,source,withinMs') throw new Error('FCA_EXPECTATION_INVALID');
    const expectation = { ...candidate, callId: calls[callIndex]!.id };
    if (!validFcaExpectation(expectation)) throw new Error('FCA_EXPECTATION_INVALID');
    return expectation;
  });
  if (new Set(expectations.map(item => item.callId)).size !== expectations.length) throw new Error('FCA_EXPECTATION_INVALID');
  const appraisals: FcaAffectAppraisal[] = value.appraisals.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('FCA_APPRAISAL_INVALID');
    const item = raw as FcaAffectAppraisal;
    const event = input.sharedContext!.recentOutcomes.find(event => event.eventId === item.eventId);
    if (Object.keys(item).sort().join(',') !== 'cause,eventId,revision,target,value' || !event || event.observation !== 'observed'
      || item.revision !== event.appraisalRevision + 1 || !Number.isFinite(item.value) || Math.abs(item.value) > 1
      || typeof item.cause !== 'string' || !item.cause.trim() || item.cause.length > 240 || typeof item.target !== 'string' || item.target.length > 120) throw new Error('FCA_APPRAISAL_INVALID');
    return item;
  });
  if (new Set(appraisals.map(item => item.eventId)).size !== appraisals.length) throw new Error('FCA_APPRAISAL_INVALID');
  return { expectations, appraisals, auxiliaryResults: [{ id: blocks[0]!.id, ok: true, text: JSON.stringify({ received: true }) }] };
}
