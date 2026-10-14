import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import type { FcaBodyLifecycle, FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import { SQLiteFcaEvidenceStore } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import { providerToolName, toolFailure, toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';
import { memoryWorld } from './support/memoryWorld.js';

/**
 * Minecraft operator run 5 (production 9fa6033c, 2026-10-14, task 68395576), as a simulation through the real runtime, decision model,
 * summarizer, codec, history policy, progress tools and evidence store: mining rounds whose results grow the history past two
 * summaries, an mc.move-to that fails "Action interrupted", a task.replan bound to that failure, and then, as the first decision of
 * a new epoch, an action beside an fca_context whose expectation breaks a rule (text_contains with a text as its expected value).
 * There that answer left the step unknown and paused the task (FCA_EXPECTATION_INVALID). Here the action runs, the model reads the
 * correction in the context call's tool result, states a valid expectation next, which is recorded, and the task completes.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const skill = (name: string): FcaToolDefinition => ({ name, description: `${name} の身体スキル。近くのブロックを探して移動し、結果を観測で確かめる。`.repeat(2),
  input: { type: 'object', properties: { target: { type: 'string', description: '対象。省略すると現在の観測から決める。' } }, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
const SKILLS = ['mc.mine-block', 'mc.move-to', 'mc.check-path-to', ...Array.from({ length: 40 }, (_, index) => `mc.skill-${index}`)].map(skill);
const MINE_STEPS = 12;
type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }>; tools: Array<{ name?: string }> };
const isSummary = (body: Body) => body.tools.some(tool => tool.name === 'fca_history_summary');
const toolResults = (body: Body) => body.messages.flatMap(entry => Array.isArray(entry.content)
  ? (entry.content as Array<Record<string, unknown>>).filter(block => block.type === 'tool_result') : []);
const call = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const expectation = (expected: unknown) => ({ callIndex: 0, source: 'tool_result', observable: { kind: 'text_contains', text: '到着' },
  expected, probability: 0.7, expectedValue: null, withinMs: 60_000 });

function run() {
  let time = Date.parse('2026-10-14T04:10:09.000Z');
  const now = () => new Date(time).toISOString();
  const world = memoryWorld(), h = actionHarness(now, world.path);
  const evidence = new SQLiteFcaEvidenceStore({ db: h.db, state: world.store, now,
    validStep: step => !!h.store.check(step.lease, now()) && h.db.prepare('SELECT step_id FROM fca_task_checkpoints WHERE task_id=?').get(step.taskId)?.step_id === step.id,
    sourcesVisible: () => true, taskVisible: () => true, observeContext: () => true });
  const violations: string[] = [], decisions: Body[] = [], executed: string[] = [];
  let decision = 0, failedOperation = '', phase: 'mine' | 'move' | 'replan' | 'invalid' | 'valid' | 'done' = 'mine';
  const template = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木と移動の事実`]]));
  const think = (index: number) => ({ type: 'thinking', thinking: '次の作業', signature: `signed-${index}-${'s'.repeat(300)}` });
  const fixture = scriptedAnthropic(raw => {
    const body = raw as Body;
    const violation = anthropicRequestViolation(body);
    if (violation) violations.push(violation);
    if (isSummary(body)) {
      return message([call(`toolu_summary_${decision}_${Math.random().toString(36).slice(2, 8)}`, 'fca_history_summary', { template: JSON.stringify(template) })], 'tool_use');
    }
    decision += 1; decisions.push(body);
    const id = `toolu_${decision}`;
    if (phase === 'mine' && decision > MINE_STEPS) phase = 'move';
    switch (phase) {
      case 'mine': return message([think(decision), call(id, providerToolName('mc.mine-block'), { target: 'oak_log' })], 'tool_use');
      case 'move': phase = 'replan'; return message([think(decision), call(id, providerToolName('mc.move-to'), { target: '29 67 33' })], 'tool_use');
      case 'replan': phase = 'invalid';
        return message([think(decision), call(id, providerToolName('task.replan'), { failureOperationId: failedOperation, summary: '経路はある',
          nextSteps: ['もう一度移動する'] })], 'tool_use');
      case 'invalid': phase = 'valid';
        return message([think(decision), call(id, providerToolName('mc.move-to'), { target: '29 67 33' }),
          call(`${id}_context`, 'fca_context', { expectations: [expectation('到着')], appraisals: [] })], 'tool_use');
      case 'valid': phase = 'done';
        return message([think(decision), call(id, providerToolName('mc.check-path-to'), { target: '29 67 33' }),
          call(`${id}_context`, 'fca_context', { expectations: [expectation(true)], appraisals: [] })], 'tool_use');
      default: return message([call(id, 'fca_complete', { summary: '目的地に着いた' })], 'tool_use');
    }
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const base: FcaExternalTools = { definitions: SKILLS, async execute(request) {
    executed.push(request.name);
    if (request.name === 'mc.move-to' && phase === 'replan') { failedOperation = request.operationId; return toolFailure('failed', '移動エラー: Action interrupted'); }
    if (request.name === 'mc.move-to') return toolOk('到着しました: (29, 67, 33)');
    if (request.name === 'mc.check-path-to') return toolOk('到着しました。経路あり: (29, 67, 33)');
    return toolOk(`原木を1個掘った。周囲: ${'樫の原木、草、石。'.repeat(decision % 3 === 0 ? 1_400 : 200)}`);
  } };
  const selector: FcaToolSelector = { async select(request) { return { names: request.tools.map(tool => tool.name), source: 'fallback' }; } };
  const body: FcaBodyLifecycle = { start() {}, revision: () => 0, guard: async () => true, toolSignal: (_name, signal) => signal, async close() {},
    context: () => ({ revision: 0, observation: { position: { x: decision, y: 62, z: 34 }, nearby: '樫の原木、草、石'.repeat(120) } as never }) };
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    canRunTask: (_runtime, id) => id === only,
    stepPorts: (_runtime, step) => ({ selector, body, evidence, history: { codec: anthropicFcaHistoryCodec, summarizer, policy: RUN5_POLICY },
      tools: createFcaProgressTools(base, { checkpoint: step.snapshot.checkpoint, async permit() {} }) }) });
  cleanups.push(async () => { await driver.close(); h.close(); world.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '拠点へ戻る', goal: '原木を集めて (29, 67, 33) へ移動する',
    completionCriteria: '目的地に着いたことを新しい観測で確かめる。' }, 'minecraft-request');
  only = task.id;
  async function settle() {
    for (let i = 0; i < 200 && !['completed', 'failed', 'unknown', 'waiting'].includes(driver.runtime.get('owner', task.id)?.phase ?? ''); i++) {
      await driver.tick(); await driver.drain(); time += 1_000;
    }
  }
  return { h, driver, task, fixture, violations, decisions, executed, settle };
}

/** Operator run 5's history policy (a 32,000-character summary input, two batches back to back), which this replay reproduces. */
const RUN5_POLICY = { maximumSummaryCharacters: 32_000 };

describe('Minecraft operator run 5: an invalid expectation after two summaries and a replan is corrected, never unknown', () => {
  it('runs the action, returns the correction to the model, records its next valid expectation and completes', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => { logged.push(String(line)); });
    const r = run();
    await r.settle();
    expect(r.violations).toEqual([]);
    expect(r.driver.runtime.get('owner', r.task.id)?.phase).toBe('completed');
    // The run crosses at least two history summaries, and the invalid context is the first decision after one (a fresh epoch).
    const bodies = r.fixture.bodies as Body[];
    const invalidAt = bodies.indexOf(r.decisions[MINE_STEPS + 2]!);
    // As in production: the failed move, the replan, two summaries back to back (a batch, then its settling), then the invalid context.
    expect(bodies.slice(invalidAt - 4, invalidAt).map(body => isSummary(body) ? 'summary' : 'decision')).toEqual(['decision', 'decision', 'summary', 'summary']);
    expect(bodies.slice(0, invalidAt).filter(isSummary).length).toBeGreaterThanOrEqual(4);
    // The failed move, its replan, the corrected move and the read all ran.
    expect(r.executed.slice(MINE_STEPS)).toEqual(['mc.move-to', 'mc.move-to', 'mc.check-path-to']);
    const progress = (r.driver.runtime.snapshot('owner', r.task.id)!.checkpoint as { fcaProgress: { failures: unknown[]; replans: unknown[] } }).fcaProgress;
    expect(progress.replans).toEqual([expect.objectContaining({ failureOperationId: expect.stringContaining(':toolu_13') })]);
    // The decision after the invalid one reads the correction as an error result of the context call, beside the move's result.
    const corrected = toolResults(r.decisions[MINE_STEPS + 3]!).slice(-2);
    expect(corrected[0]).toMatchObject({ tool_use_id: `toolu_${MINE_STEPS + 3}_context`, is_error: true });
    expect(JSON.parse(String(corrected[0]!.content))).toMatchObject({ accepted: { expectations: 0, appraisals: 0 },
      rejected: [{ item: 'expectations[0]', reason: 'text_contains_expected' }] });
    expect(corrected[1]).toMatchObject({ tool_use_id: `toolu_${MINE_STEPS + 3}`, is_error: false });
    expect(logged.filter(line => line.includes('fca_context_rejected'))).toEqual([
      JSON.stringify({ event: 'fca_context_rejected', acceptedExpectations: 0, acceptedAppraisals: 0, rejected: ['expectations[0]:text_contains_expected'] })]);
    // Only the valid expectation is recorded, and its comparison is observed from the read's result.
    const recorded = r.h.db.prepare('SELECT name, expectation_json, comparison_json FROM fca_action_evidence WHERE expectation_json IS NOT NULL').all() as
      Array<{ name: string; expectation_json: string; comparison_json: string }>;
    expect(recorded.map(row => [row.name, JSON.parse(row.expectation_json).expected, JSON.parse(row.comparison_json).status]))
      .toEqual([['mc.check-path-to', true, 'observed']]);
  }, 120_000);
});
