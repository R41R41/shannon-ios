import { afterEach, describe, expect, it, vi } from 'vitest';
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
afterEach(() => { vi.restoreAllMocks(); });
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
    [context([{ ...expectation, callIndex: 1 }], []), 'expectations[0]', 'call_index'],
    [context([{ ...expectation, observable: { kind: 'json_pointer', path: '/ok' } }], []), 'expectations[0]', 'transport_success'],
    [context([{ ...expectation, observable: { kind: 'json_pointer', path: 'count' } }], []), 'expectations[0]', 'json_pointer_path'],
    [context([{ ...expectation, observable: { kind: 'text_contains', text: '到着' }, expected: '到着' }], []), 'expectations[0]', 'text_contains_expected'],
    [context([{ ...expectation, withinMs: 0 }], []), 'expectations[0]', 'within_ms'],
    [context([{ ...expectation, extra: 1 }], []), 'expectations[0]', 'fields'],
    [context([], [{ ...appraisal, eventId: 'invented' }]), 'appraisals[0]', 'appraisal_event'],
    [context([], [{ ...appraisal, revision: 1 }]), 'appraisals[0]', 'appraisal_revision'],
    [nativeCall('fca_context', 'metadata', { expectations: [] }), 'fca_context', 'context_shape'],
  ])('answers malformed metadata with a correction beside the unchanged action, without a repair call %#', async (annotation, item, reason) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const f = harness([answer([annotation as Record<string, unknown>, nativeCall('task_list', 'action')])]);
    const result = await f.model.decide(input(), signal());
    expect(result.decision).toEqual({ kind: 'tools', calls: [{ id: 'action', name: 'task.list', input: {} }] });
    expect(result.expectations).toEqual([]); expect(result.appraisals).toEqual([]);
    expect(result.auxiliaryResults).toHaveLength(1);
    expect(result.auxiliaryResults![0]).toMatchObject({ id: 'metadata', ok: false });
    expect(JSON.parse(result.auxiliaryResults![0]!.text)).toMatchObject({ received: true, accepted: { expectations: 0, appraisals: 0 },
      rejected: [{ item, reason, rule: expect.any(String) }] });
    // The model reads it as an error result of its context call, next to its action's result.
    expect((f.model.toolResults([...result.auxiliaryResults!, { id: 'action', ok: true, text: '[]' }]) as { content: unknown }).content).toEqual([
      { type: 'tool_result', tool_use_id: 'metadata', content: result.auxiliaryResults![0]!.text, is_error: true },
      { type: 'tool_result', tool_use_id: 'action', content: '[]', is_error: false }]);
    // Content-free: closed reasons only, never the model's values.
    expect(info.mock.calls.map(call => String(call[0]))).toContain(JSON.stringify({ event: 'fca_context_rejected', acceptedExpectations: 0,
      acceptedAppraisals: 0, rejected: [`${item}:${reason}`] }));
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/PRIVATE_|到着|invented/u);
    expect(f.bodies).toHaveLength(1); expect(f.usage).toHaveLength(1); expect(f.usage[0]!.usageComplete).toBe(true);
  });
  it('keeps the items that hold and the first of duplicates, and names each one left out', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const second = { ...expectation, callIndex: 1, observable: { kind: 'text_contains', text: 'done' }, expected: true };
    const f = harness([answer([context([expectation, { ...expectation, expected: 5 }, second, { ...second, probability: 2 }], [appraisal, appraisal]),
      nativeCall('task_list', 'first'), nativeCall('task_list', 'second')])]);
    const result = await f.model.decide(input(), signal());
    expect(result.expectations).toEqual([{ ...expectation, callId: 'first', callIndex: undefined }, { ...second, callId: 'second', callIndex: undefined }]);
    expect(result.appraisals).toEqual([appraisal]);
    expect(JSON.parse(result.auxiliaryResults![0]!.text).rejected.map((item: { item: string; reason: string }) => `${item.item}:${item.reason}`))
      .toEqual(['expectations[1]:duplicate_call', 'expectations[3]:probability', 'appraisals[1]:duplicate_event']);
  });
  it('answers an expectation beside a wait, and two context calls, with corrections in the control round', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const f = harness([answer([context([expectation], []), nativeCall('fca_wait', 'wait', { summary: 'Waiting' })]),
      answer([context([], []), nativeCall('fca_context', 'again', { expectations: [], appraisals: [] }), nativeCall('task_list', 'action')])]);
    const waited = await f.model.decide(input(), signal());
    expect(waited.decision).toEqual({ kind: 'wait', summary: 'Waiting' }); expect(waited.expectations).toEqual([]);
    const results = (waited.history.at(-1) as { content: Array<{ tool_use_id: string; is_error: boolean; content: string }> }).content;
    expect(results.map(item => [item.tool_use_id, item.is_error])).toEqual([['metadata', true], ['wait', false]]);
    expect(JSON.parse(results[0]!.content).rejected).toEqual([expect.objectContaining({ item: 'expectations[0]', reason: 'no_action' })]);
    const twice = await f.model.decide(input(), signal());
    expect(twice.decision).toEqual({ kind: 'tools', calls: [{ id: 'action', name: 'task.list', input: {} }] });
    expect(twice.auxiliaryResults!.map(item => [item.id, item.ok])).toEqual([['metadata', false], ['again', false]]);
    expect(JSON.parse(twice.auxiliaryResults![0]!.text).rejected).toEqual([expect.objectContaining({ item: 'fca_context', reason: 'context_shape' })]);
  });
  it('does not appraise unknown outcomes, accept metadata-only decisions, or silently change the legacy schema prefix', async () => {
    const unknown = input(); unknown.sharedContext!.recentOutcomes = [{ ...unknown.sharedContext!.recentOutcomes[0]!, observation: 'unknown', result: null }];
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const f = harness([answer([context([], [appraisal]), nativeCall('task_list', 'action')]), answer([context([], [])])]);
    const refused = await f.model.decide(unknown, signal());
    expect(refused.appraisals).toEqual([]);
    expect(JSON.parse(refused.auxiliaryResults![0]!.text).rejected).toEqual([expect.objectContaining({ item: 'appraisals[0]', reason: 'appraisal_event' })]);
    await expect(f.model.decide(input(), signal())).rejects.toThrow('FCA_MODEL_DECISION_MISSING');
    const legacy = input(); delete legacy.catalog;
    await expect(f.model.decide(legacy, signal())).rejects.toThrow('FCA_CONTEXT_REQUIRES_SELECTED_MODE');
    expect(f.bodies).toHaveLength(2);
  });
});
