import { describe, expect, it } from 'vitest';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { FCA_CONTEXT_INSTRUCTIONS, FCA_CONTEXT_TOOL } from '../src/infra/models/anthropic/anthropicFcaContext.js';
import { SHANNON_FCA_SHARED_CAPABILITY } from '@shannon/cognition';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { TASK_TOOLS } from '../src/mind/tools/toolRunnerPorts.js';
import { message, scriptedAnthropic, type AnthropicMessage, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';

const input = (history: readonly unknown[] = []): FcaModelInput => ({
  task: { id: 'task', title: 'Research', goal: 'Find public facts', completionCriteria: 'Measurements compared' },
  messages: [], history, tools: [TASK_TOOLS[1]!], catalog: TASK_TOOLS.map(({ name, description }) => ({ name, description })),
  sharedContext: { affect: { version: 'fca_affect.v1', revision: 12, updatedAt: '2026-10-09T00:00:00Z',
    emotion: { valence: 0.2, arousal: 0.3, openness: 0.4 }, feeling: null,
    causes: [{ eventId: 'old-event', revision: 1, cause: 'PRIVATE_AFFECT_CAUSE', target: 'research' }] },
    recentOutcomes: [{ eventId: 'old-event', taskId: 'child-task', operationId: 'old-operation', name: 'web.search', observation: 'observed',
      result: { ok: true, text: 'PRIVATE_OBSERVED_RESULT' }, expectation: null, comparison: null, appraisalRevision: 1 }] },
  recall: { contextVersion: 'version', observedAt: '2026-10-09T00:00:00Z', status: 'ready', items: [], sourceIds: ['PRIVATE_RECALL_SOURCE'] },
});
const nativeCall = (name: string, id: string, value: unknown = {}) => ({ type: 'tool_use', name, id, input: value });
const expectation = { callIndex: 0, source: 'tool_result', observable: { kind: 'json_pointer', path: '/count' },
  expected: 2, probability: 0.8, expectedValue: 0.2, withinMs: 1000 };
const appraisal = { eventId: 'old-event', revision: 2, value: 0.6, cause: 'PRIVATE_APPRAISAL_MEANING', target: 'research' };
const context = (expectations: unknown[] = [expectation], appraisals: unknown[] = [appraisal]) => nativeCall('fca_context', 'metadata', { expectations, appraisals });
const signed = { type: 'thinking', thinking: 'PRIVATE_THINKING_BODY', signature: 'PRIVATE_NATIVE_SIGNATURE' };
const answer = (content: Array<Record<string, unknown>>) => message(content, 'tool_use');
const signal = () => new AbortController().signal;
function harness(script: AnthropicMessage[]) {
  const fixture = scriptedAnthropic(script), usage: AnthropicFcaUsage[] = [];
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage: value => { usage.push(value); } });
  return { ...fixture, model, usage };
}
const changes = (history: readonly unknown[]) => history.flatMap(entry => {
  const item = entry as { role: string; content: unknown[] }; return item.role === 'system' ? item.content : [];
});
describe('FCA shared context native protocol', () => {
  it('adds context inline to an existing signed epoch while keeping its cached prefix and prior native bytes unchanged', async () => {
    const f = harness([answer([signed, nativeCall('fca_wait', 'first', { summary: 'Waiting' })]),
      answer([context(), nativeCall('task_list', 'actual-call')]), answer([nativeCall('fca_wait', 'later', { summary: 'Waiting' })])]);
    const firstInput = input(); delete firstInput.sharedContext; delete firstInput.recall;
    const first = await f.model.decide(firstInput, signal()), original = JSON.stringify(first.history);
    const second = await f.model.decide(input(first.history), signal());
    expect(second.decision).toEqual({ kind: 'tools', calls: [{ id: 'actual-call', name: 'task.list', input: {} }] });
    expect(second.expectations).toEqual([{ ...expectation, callId: 'actual-call', callIndex: undefined }]);
    expect(second.appraisals).toEqual([appraisal]);
    expect(second.auxiliaryResults).toEqual([{ id: 'metadata', ok: true, text: '{"received":true}' }]);
    expect(changes(second.history)).toEqual([{ type: 'tool_addition', tool: { type: 'tool_definition', definition: FCA_CONTEXT_TOOL } }]);
    expect(withoutCacheMarkers((f.bodies[1]!.messages as unknown[]).slice(0, first.history.length))).toEqual(first.history);
    expect(JSON.stringify(first.history)).toBe(original);
    expect(f.bodies[1]!.system).toEqual(f.bodies[0]!.system); expect(f.bodies[1]!.tools).toEqual(f.bodies[0]!.tools);
    // The current decision, then the added definition, which ends the request (a system message between two user messages is a
    // provider 400: Minebot lane run 3, 2026-10-14).
    const sent = f.bodies[1]!.messages as Array<{ role: string; content: string }>;
    expect(sent.slice(-2).map(entry => entry.role)).toEqual(['user', 'system']);
    expect(anthropicRequestViolation(f.bodies[1]!)).toBeNull();
    const current = JSON.parse(sent.at(-2)!.content);
    expect(current.sharedContext).toEqual(input().sharedContext);
    // The model reads the packet's source ids as a count; the runner has pinned and rechecks the ids themselves.
    const { sourceIds, ...recall } = input().recall!;
    expect(current.recall).toEqual({ ...recall, sourceCount: sourceIds.length });
    expect(JSON.stringify(f.bodies[1]!.messages)).not.toContain('PRIVATE_RECALL_SOURCE');
    expect(FCA_CONTEXT_INSTRUCTIONS).toContain(SHANNON_FCA_SHARED_CAPABILITY.text);
    expect(JSON.stringify(f.bodies[1]!.system)).not.toMatch(/PRIVATE_AFFECT_CAUSE|PRIVATE_RECALL_SOURCE|fca_context/u);
    const complete = [...second.history, f.model.toolResults([...second.auxiliaryResults!, { id: 'actual-call', ok: true, text: '{"count":3}' }])];
    expect(anthropicFcaHistoryCodec.project({ sequence: 1, stepId: 'step', committedAt: '2026-10-09T00:00:00Z', entries: complete, status: 'queued', sources: [] })).not.toBeNull();
    const third = await f.model.decide(input([...first.history, ...complete]), signal());
    expect(changes(third.history)).toEqual([]); expect(third.expectations).toBeUndefined();
    expect(f.bodies).toHaveLength(3); expect(f.usage.every(item => item.usageComplete)).toBe(true);
  });
  it('acknowledges metadata and control together and exposes only counts and tool names to Observer', async () => {
    const events: ObserverDraft[] = [], restore = installObserverSink(event => { events.push(event); });
    const f = harness([answer([signed, context([], [appraisal]), nativeCall('fca_complete', 'done', { summary: 'PRIVATE_COMPLETE_SUMMARY' })])]);
    try {
      const result = await withObserverRun({ runId: 'context-safe', surface: 'fca', scopeKey: 'owner' }, () => f.model.decide(input(), signal()));
      expect(result.auxiliaryResults).toBeUndefined();
      expect(result.history.at(-1)).toEqual({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'metadata', content: '{"received":true}', is_error: false },
        { type: 'tool_result', tool_use_id: 'done', content: '{"received":true,"requestedDecision":"complete"}', is_error: false },
      ] });
      expect(events.filter(event => event.node === 'llm' && event.kind === 'span.completed')).toHaveLength(1);
      expect(JSON.stringify(events)).toContain('fca_context');
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|thinking|signature|probability|appraisals|sharedContext/u);
    } finally { restore(); }
  });
  it.each([
    [context([{ ...expectation, callIndex: 1 }], []), 'FCA_EXPECTATION_INVALID'],
    [context([{ ...expectation, observable: { kind: 'json_pointer', path: '/ok' } }], []), 'FCA_EXPECTATION_INVALID'],
    [context([expectation, expectation], []), 'FCA_EXPECTATION_INVALID'],
    [context([], [{ ...appraisal, eventId: 'invented' }]), 'FCA_APPRAISAL_INVALID'],
    [context([], [{ ...appraisal, revision: 1 }]), 'FCA_APPRAISAL_INVALID'],
    [context([], [appraisal, appraisal]), 'FCA_APPRAISAL_INVALID'],
    [nativeCall('fca_context', 'metadata', { expectations: [] }), 'FCA_CONTEXT_INVALID'],
  ])('rejects malformed metadata without a repair call %#', async (annotation, code) => {
    const f = harness([answer([annotation as Record<string, unknown>, nativeCall('task_list', 'action')])]);
    await expect(f.model.decide(input(), signal())).rejects.toThrow(String(code));
    expect(f.bodies).toHaveLength(1); expect(f.usage).toHaveLength(1); expect(f.usage[0]!.usageComplete).toBe(true);
  });
  it('does not appraise unknown outcomes, accept metadata-only decisions, or silently change the legacy schema prefix', async () => {
    const unknown = input(); unknown.sharedContext!.recentOutcomes = [{ ...unknown.sharedContext!.recentOutcomes[0]!, observation: 'unknown', result: null }];
    const f = harness([answer([context([], [appraisal]), nativeCall('task_list', 'action')]), answer([context([], [])])]);
    await expect(f.model.decide(unknown, signal())).rejects.toThrow('FCA_APPRAISAL_INVALID');
    await expect(f.model.decide(input(), signal())).rejects.toThrow('FCA_MODEL_DECISION_MISSING');
    const legacy = input(); delete legacy.catalog;
    await expect(f.model.decide(legacy, signal())).rejects.toThrow('FCA_CONTEXT_REQUIRES_SELECTED_MODE');
    expect(f.bodies).toHaveLength(2);
  });
});
