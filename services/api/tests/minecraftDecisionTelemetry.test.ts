import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { requestLayers } from '../src/infra/models/anthropic/anthropicFcaMetrics.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { fcaDecisionMetrics } from '../src/mind/action/fca/fcaDecisionMetrics.js';
import { fcaTaskTelemetry } from '../src/mind/action/fca/fcaTaskTelemetry.js';
import { isolatedModelCall } from '../src/mind/action/fca/fcaModelIsolation.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { createReflexTimings, reflexTimingLine } from '../src/surfaces/minecraft/minecraftReflexTiming.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

/** Syzygy ADR-0014 D8: the decision telemetry (measurement only): its fields, its privacy and that no request changes. */
const SECRET = 'owner-text-must-never-appear-in-a-journal-line';
const usage = { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 700, cache_read_input_tokens: 2_000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const wait = () => message([{ type: 'tool_use', name: 'fca_wait', id: 'wait-1', input: { summary: 'Waiting' } }], 'tool_use', { model: 'claude-sonnet-5-5', usage });
const input = (): FcaModelInput => ({ task: { id: 'task-1', title: 'Task', goal: SECRET, completionCriteria: 'Done' }, messages: [], tools: [], history: [] });
const execution = (telemetry?: ActionExecution['telemetry']) => ({ signal: new AbortController().signal, ...(telemetry ? { telemetry } : {}) }) as unknown as ActionExecution;
const model = (fixture: ReturnType<typeof scriptedAnthropic>) => createAnthropicFcaModel({ apiKey: 'synthetic-fca-key', fetcher: fixture.fetcher, recordUsage: () => undefined });

afterEach(() => { vi.restoreAllMocks(); fcaTaskTelemetry.reset(); });

describe('the decision metrics line (ADR-0014 D8)', () => {
  const emit = async (prior: Record<string, unknown>, setup: (metrics: ReturnType<typeof fcaDecisionMetrics>) => void = () => undefined) => {
    const lines: string[] = [];
    const metrics = fcaDecisionMetrics('task-1', '2026-10-17T00:00:00.000Z', prior, { log: line => lines.push(line), now: () => Date.parse('2026-10-17T00:01:00.000Z') });
    setup(metrics);
    const layers = { policy: 900, tools: 4_000, history: 12_000, task: 300, live: 1_500, retrieved: 0 };
    await inActionExecution({ modelMetrics: { storedTokens: 1, tailTokens: 1, inputNew: 5, inputRead: 90, inputWrite: 10, outputTokens: 30, inputTransformations: 0,
      model: 'claude-sonnet-5-5', ttftMs: null, layers } } as never, async () => metrics.emit());
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  };
  it('carries the kind, the model, a null first-token time and the layers', async () => {
    const line = await emit({ fcaDecisionIndex: 4 });
    expect(line).toMatchObject({ event: 'fca_decision_metrics', kind: 'main', d: 5, model: 'claude-sonnet-5-5', ttftMs: null,
      layers: { policy: 900, tools: 4_000, history: 12_000, task: 300, live: 1_500, retrieved: 0 } });
  });
  it('tags the first decision of a task first_plan and an urgent one urgent', async () => {
    expect((await emit({})).kind).toBe('first_plan');
    expect((await emit({ fcaDecisionIndex: 7 }, metrics => metrics.urgent())).kind).toBe('urgent');
    expect((await emit({ fcaDecisionIndex: 7 }, metrics => metrics.interrupted(900))).kind).toBe('urgent');
  });
  it('never writes 0 for a first-token time it could not measure, and marks a step that took the decision asked ahead', async () => {
    const lines: string[] = [];
    const metrics = fcaDecisionMetrics('task-1', '2026-10-17T00:00:00.000Z', { fcaDecisionIndex: 2 }, { log: line => lines.push(line) });
    expect(metrics.lookahead({ answer: 1 })).toEqual({ answer: 1 });
    metrics.emit();
    expect(JSON.parse(lines[0]!)).toMatchObject({ ttftMs: null, lookahead: 'taken', in: null });
  });
});

describe('the input layers', () => {
  it('are numbers from the pieces the request holds, never a text', () => {
    const layers = requestLayers({ system: [{ type: 'text', text: 'You are the body planner. '.repeat(40) }], tools: [{ name: 'mc.act', input_schema: { type: 'object' } }] },
      [{ role: 'user', content: 'earlier turn' }], [{ role: 'user', content: JSON.stringify({ task: { goal: SECRET } }) }], { recall: { items: ['a memory'] } }, false);
    expect(Object.keys(layers)).toEqual(['policy', 'tools', 'history', 'task', 'live', 'retrieved']);
    expect(Object.values(layers).every(value => Number.isInteger(value) && value >= 0)).toBe(true);
    expect(layers.policy).toBeGreaterThan(layers.tools);
    expect(layers.retrieved).toBeGreaterThan(0);
    expect(JSON.stringify(layers)).not.toContain(SECRET);
  });
  it('count a transient request\'s turn-scoped state message as live', () => {
    const live = { role: 'system', content: [{ type: 'text', text: 'state '.repeat(200) }], clear_at: true } as never;
    const layers = requestLayers({}, [], [{ role: 'user', content: 'row' }, live], {}, true);
    expect(layers.live).toBeGreaterThanOrEqual(0);
    expect(layers.task).toBeGreaterThan(0);
  });
});

describe('the model adapter (ADR-0014 D8)', () => {
  it('puts the answering model, a null first-token time and the layers on the step\'s metrics, and counts the call for its task', async () => {
    const fixture = scriptedAnthropic([wait()]);
    const run = execution({ taskId: 'task-1', kind: 'main' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await inActionExecution(run, () => model(fixture).decide(input(), new AbortController().signal));
    expect(run.modelMetrics).toMatchObject({ model: 'claude-sonnet-5-5', ttftMs: null, layers: expect.objectContaining({ policy: expect.any(Number), tools: expect.any(Number) }) });
    expect(info.mock.calls.map(call => String(call[0])).filter(line => line.includes('"fca_aux_call"'))).toEqual([]);
    const lines: string[] = [];
    fcaTaskTelemetry.summary('task-1', 'waiting', line => lines.push(line));
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'fca_task_summary', state: 'waiting', calls: { main: 1, urgent: 0, lookahead: 0, first_plan: 0, summary: 0 },
      outTokens: 30, uncachedIn: 712 });
  });
  it('writes its own line, with the same fields, for a call asked ahead or a history summary, and no text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fixture = scriptedAnthropic([wait(), wait()]);
    const base = execution({ taskId: 'task-1', kind: 'main' });
    await inActionExecution(base, () => isolatedModelCall(() => model(fixture).decide(input(), new AbortController().signal)));
    await inActionExecution(base, () => model(fixture).decide({ ...input(), task: { ...input().task, id: 'fca-history-summary' } }, new AbortController().signal));
    const aux = info.mock.calls.map(call => String(call[0])).filter(line => line.includes('"fca_aux_call"'));
    expect(aux).toHaveLength(2);
    expect(aux.map(line => JSON.parse(line).kind)).toEqual(['lookahead', 'summary']);
    for (const line of aux) {
      expect(JSON.parse(line)).toMatchObject({ task: 'task-1', model: 'claude-sonnet-5-5', ttftMs: null, out: 30, in: { new: 12, read: 2_000, write: 700 },
        layers: expect.objectContaining({ history: expect.any(Number) }) });
      expect(line).not.toContain(SECRET);
    }
  });
  it('sends byte-identical request bodies with and without the telemetry', async () => {
    const plain = scriptedAnthropic([wait()]), measured = scriptedAnthropic([wait()]);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await inActionExecution(execution(), () => model(plain).decide(input(), new AbortController().signal));
    await inActionExecution(execution({ taskId: 'task-1', kind: 'urgent' }), () => model(measured).decide(input(), new AbortController().signal));
    expect(JSON.stringify(measured.bodies)).toBe(JSON.stringify(plain.bodies));
  });
});

describe('the task summary (ADR-0014 D8)', () => {
  const summary = (state: 'waiting' | 'completed' = 'waiting') => {
    const lines: string[] = [];
    fcaTaskTelemetry.summary('task-9', state, line => lines.push(line));
    return lines.length ? JSON.parse(lines[0]!) as Record<string, unknown> : null;
  };
  it('counts a same call repeated after it failed, whatever the order of its arguments, and not a call that followed a success', () => {
    fcaTaskTelemetry.toolCall('task-9', 'mc.act', { plan: [1, 2], at: { x: 1, y: 2 } }, false);
    fcaTaskTelemetry.toolCall('task-9', 'mc.act', { at: { y: 2, x: 1 }, plan: [1, 2] }, false);
    fcaTaskTelemetry.toolCall('task-9', 'mc.act', { plan: [3] }, true);
    fcaTaskTelemetry.toolCall('task-9', 'mc.act', { plan: [3] }, true);
    expect(summary()).toMatchObject({ sameArgsRetries: 1 });
  });
  it('counts plan-only decisions, recoveries, calls by kind, tokens and the decisions asked ahead that were taken', () => {
    fcaTaskTelemetry.call('task-9', 'first_plan', { out: 100, uncached: 4_000 });
    fcaTaskTelemetry.call('task-9', 'lookahead', { out: 50, uncached: 10 });
    fcaTaskTelemetry.decision('task-9', { attempts: 3, interrupted: true, surprised: true, taken: true,
      planned: [{ name: 'plan.update', act: false }, { name: 'mc.view', act: false }] });
    fcaTaskTelemetry.decision('task-9', { attempts: 1, interrupted: false, surprised: false, taken: false, planned: [{ name: 'plan.update', act: false }, { name: 'mc.act', act: true }] });
    expect(summary()).toEqual({ event: 'fca_task_summary', task: 'task-9', state: 'waiting', calls: { main: 0, urgent: 0, lookahead: 1, first_plan: 1, summary: 0 },
      lookaheadTaken: 1, outTokens: 150, uncachedIn: 4_010, sameArgsRetries: 0, planOnly: 1, recoveries: { retry: 1, interrupt: 1, surprise: 1 } });
  });
  it('is written when a step commits a waiting or ended task, for a body task only, and an ended task\'s counters are dropped', async () => {
    const lines: string[] = [];
    const finish = (body: boolean, phase: string) => {
      const metrics = fcaDecisionMetrics('task-9', '2026-10-17T00:00:00.000Z', {}, { body, log: () => undefined, summaryLog: line => lines.push(line) });
      metrics.tool('mc.act', 1, { input: { plan: [1] }, ok: false });
      metrics.emit(phase);
    };
    finish(false, 'waiting');
    finish(true, 'ready');
    expect(lines).toEqual([]);
    finish(true, 'completed');
    expect(JSON.parse(lines[0]!)).toMatchObject({ task: 'task-9', state: 'completed' });
    expect(summary('completed')).toBeNull();
    expect(lines.join('')).not.toContain('mc.act');
  });
});

describe('the reflex timing lines (ADR-0014 D8)', () => {
  it('keep only closed codes and times, never free text', () => {
    const line = JSON.parse(reflexTimingLine({ path: 'fast', task: 'task-1', kind: 'a free text with spaces', rule: 'respawn_shelter', skill: 'dig-shelter', detectedAt: 1_000.4,
      decidedAt: 1_010, dispatchedAt: null, receiptAt: Number.NaN, outcome: 'completed', discard: null })) as Record<string, unknown>;
    expect(line).toEqual({ event: 'minecraft_reflex_timing', path: 'fast', task: 'task-1', kind: null, rule: 'respawn_shelter', skill: 'dig-shelter', detectedAt: 1_000,
      decidedAt: 1_010, dispatchedAt: null, receiptAt: null, outcome: 'completed', discard: null });
  });
  it('write one line for a held entry (after its fixed line) and one for a session, with its dispatch and receipt', async () => {
    const lines: string[] = [];
    let clock = 5_000;
    const timings = createReflexTimings({ task: 'task-1', now: () => (clock += 10), log: line => lines.push(line), held: true });
    timings.seen({ receivedAt: new Date(4_990).toISOString() });
    timings.held('floor_active', { kind: 'shelter', skill: 'dig-shelter' });
    expect(lines[0]).toBe('Shannon reflex entry held task=task-1 reason=floor_active');
    expect(JSON.parse(lines[1]!)).toMatchObject({ path: 'fast', kind: 'shelter', skill: 'dig-shelter', detectedAt: 4_990, decidedAt: 5_010, discard: 'floor_active', dispatchedAt: null });
    const session = timings.session('s1', 'danger');
    let finish!: (receipt: { control: string; reason: string; actions: unknown[] }) => void;
    const job = session.track(new Promise<{ control: string; reason: string; actions: unknown[] }>(resolve => { finish = resolve; }));
    await timings.around('s1', 'minecraft.step-back', async () => 1);
    finish({ control: 'returned', reason: 'hazard_cleared', actions: [{}] });
    await job;
    await Promise.resolve();
    const ended = JSON.parse(lines[2]!) as Record<string, number | string | null>;
    expect(ended).toMatchObject({ path: 'image', kind: 'danger', skill: 'minecraft.step-back', outcome: 'returned', discard: null, detectedAt: 4_990 });
    expect(ended.decidedAt! <= ended.dispatchedAt! && ended.dispatchedAt! <= ended.receiptAt!).toBe(true);
  });
  it('write nothing for a held entry while the fast judgment is off, and the discard reason of a session that did nothing', async () => {
    const lines: string[] = [];
    const timings = createReflexTimings({ task: 'task-1', now: () => 1_000, log: line => lines.push(line), held: false });
    timings.held('floor_active', {});
    expect(lines).toEqual([]);
    await timings.session('s2', 'explicit').track(Promise.resolve({ control: 'returned', reason: 'no_progress', actions: [] }));
    expect(JSON.parse(lines[0]!)).toMatchObject({ path: 'explicit', outcome: 'returned', discard: 'no_progress', dispatchedAt: null });
  });
});
