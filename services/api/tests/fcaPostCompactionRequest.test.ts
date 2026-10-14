import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import type { FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import { providerToolName, toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';
import { anthropicRejection, anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * Minebot lane run 3 (2026-10-14 10:16 JST, production 4a41551b, Haiku): task a5ad9996 compacted its first round on its third step,
 * the summary was accepted, and the decision that followed was refused with a 400 (`invalid_request_error`, unclassified). The
 * request was a new public epoch: [bootstrap (user), inline tool definitions (system), current decision (user)]. A system message
 * that carries content must be the last message or be followed by an assistant turn, so a system message between two user
 * messages is refused. At 10:17:11 the root fd99df55 sent the same shape from a clipped public epoch (a lone round too long) and
 * was left unknown. Here the requests are built by the real runtime, native model, summarizer and history codec, and the
 * fixture answers a request the provider would refuse with the provider's 400, as production did.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const GOAL = '原木を集める', CRITERIA = '原木を持っていることを新しい観測で確かめる。';
const definition = (name: string, effect: 'read' | 'write'): FcaToolDefinition => ({ name, description: `${name} の身体操作。`,
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
const OBSERVE = definition('minecraft.observe', 'read'), EVIDENCE = definition('mc.goal-evidence', 'read'), FIND = definition('mc.find-blocks', 'read');
const isSummary = (body: Record<string, unknown>) => (body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary');
const roles = (body: Record<string, unknown>) => (body.messages as Array<{ role: string }>).map(entry => entry.role);
const use = (id: string, name: string) => ({ type: 'tool_use', id, name: providerToolName(name), input: {} });
const template = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木を集める作業の事実`]]));
const summaryCall = (): AnthropicMessage =>
  message([{ type: 'tool_use', id: `toolu_summary_${Math.random().toString(36).slice(2, 8)}`, name: 'fca_history_summary', input: { template: JSON.stringify(template) } }], 'tool_use');

interface Options {
  /** The decisions' answers, in order; the last one repeats. */
  answers: Array<Array<Record<string, unknown>>>;
  /** Characters of each tool result. */
  result: number;
  /** The selected tool names for the n-th selection (0-based); every catalog tool when absent. */
  selection?: (index: number, names: string[]) => string[];
  root?: boolean;
}

function run(options: Options) {
  let time = Date.parse('2026-10-14T01:16:20.000Z');
  const now = () => new Date(time).toISOString();
  const h = actionHarness(now);
  const violations: string[] = [];
  let decisions = 0;
  const fixture = scriptedAnthropic(body => {
    const violation = anthropicRequestViolation(body);
    if (violation) { violations.push(violation); return anthropicRejection(violation); }
    if (isSummary(body)) return summaryCall();
    const answer = options.answers[Math.min(decisions, options.answers.length - 1)]!;
    decisions += 1;
    return message(answer, 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const tools: FcaExternalTools = { definitions: [OBSERVE, EVIDENCE, FIND],
    async execute() { return toolOk(JSON.stringify({ found: 'oak_log', distance: 33, blocks: 'x'.repeat(options.result) })); } };
  let selections = 0;
  const selector: FcaToolSelector = { async select(request) {
    const names = request.tools.map(tool => tool.name);
    return { names: options.selection ? options.selection(selections++, names) : names, source: 'fallback' };
  } };
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    canRunTask: (_runtime, id) => id === only,
    stepPorts: () => ({ tools, selector, history: { codec: anthropicFcaHistoryCodec, summarizer } }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: GOAL, goal: GOAL, completionCriteria: CRITERIA }, 'minecraft-request');
  only = options.root ? root.id : task.id;
  async function settle(done: () => boolean) { for (let i = 0; i < 40 && !done(); i++) { await driver.tick(); await driver.drain(); time += 1_000; } }
  const decisionBodies = () => fixture.bodies.filter(body => !isSummary(body));
  return { driver, root, task, fixture, violations, settle, decisionBodies, summaryBodies: () => fixture.bodies.filter(isSummary) };
}
const stepLines = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA step'));

describe('the decision after an FCA history compaction is a request the provider accepts (Minebot lane run 3, task a5ad9996)', () => {
  it('runs a Minecraft-shaped task through compaction to completion: observe and goal evidence, find, compact, find, complete', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = run({ result: 40_000, answers: [
      [{ type: 'thinking', thinking: '周りを見る', signature: 'signed-round-1' }, use('toolu_observe_1', 'minecraft.observe'), use('toolu_evidence_1', 'mc.goal-evidence')],
      [{ type: 'thinking', thinking: '原木を探す', signature: 'signed-round-2' }, use('toolu_find_2', 'mc.find-blocks')],
      [{ type: 'thinking', thinking: 'もう一度探す', signature: 'signed-round-3' }, use('toolu_find_3', 'mc.find-blocks')],
      [use('toolu_find_4', 'mc.find-blocks')],
      [{ type: 'tool_use', id: 'toolu_complete_5', name: 'fca_complete', input: { summary: '原木を見つけて確かめた' } }],
    ] });
    await r.settle(() => ['completed', 'failed', 'unknown'].includes(r.driver.runtime.get('owner', r.task.id)?.phase ?? ''));
    expect(r.violations).toEqual([]);
    expect(r.summaryBodies().length).toBeGreaterThanOrEqual(1);
    const decisions = r.decisionBodies();
    expect(decisions.length).toBeGreaterThanOrEqual(5);
    for (const body of r.fixture.bodies) expect(anthropicRequestViolation(body)).toBeNull();
    // The first decision after a compaction opens a new epoch: the bootstrap, the current decision, then the definitions again.
    const firstSummary = r.fixture.bodies.findIndex(isSummary);
    const afterCompaction = r.fixture.bodies.slice(firstSummary + 1).find(body => !isSummary(body))!;
    expect(roles(afterCompaction)).toEqual(['user', 'user', 'system']);
    expect(JSON.stringify(afterCompaction)).not.toContain('signed-round-1');
    // Later decisions keep that epoch's prefix and append: no system message sits before a user message anywhere.
    for (const body of decisions) {
      const sequence = roles(body);
      sequence.forEach((role, index) => { if (role === 'system') expect(sequence[index + 1] ?? 'assistant').toBe('assistant'); });
    }
    expect(r.driver.runtime.get('owner', r.task.id)?.phase).toBe('completed');
    expect(stepLines(log)).toEqual([]);
  });

  it('adds a definition opened in the middle of a task after the current decision, not before it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // The selection loads only mc.find-blocks; the first decision opens minecraft.observe, whose definition the next one adds.
    const r = run({ result: 200, selection: (_index, names) => names.filter(name => name === 'mc.find-blocks'), answers: [
      [{ type: 'tool_use', id: 'toolu_open_1', name: 'tool_open', input: { name: providerToolName('minecraft.observe') } }],
      [use('toolu_observe_2', 'minecraft.observe')],
      [{ type: 'tool_use', id: 'toolu_wait_3', name: 'fca_wait', input: { summary: '原木へ近づく結果を待つ' } }],
    ] });
    await r.settle(() => r.decisionBodies().length >= 3);
    expect(r.violations).toEqual([]);
    const second = r.decisionBodies()[1]!;
    expect(roles(second)).toEqual(['user', 'system', 'assistant', 'user', 'user', 'system']);
    expect(JSON.stringify((second.messages as unknown[]).at(-1))).toContain(providerToolName('minecraft.observe'));
    expect(stepLines(log)).toEqual([]);
  });
});

describe('the root replays a clipped public epoch the provider accepts (Minebot lane run 3, root fd99df55)', () => {
  it('takes its next step after a lone round too long by itself, without a 400 or an unknown step', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = run({ root: true, result: 90_000, answers: [
      [{ type: 'thinking', thinking: '確かめる', signature: 'signed-root-1' }, use('toolu_find_1', 'mc.find-blocks')],
      [{ type: 'tool_use', id: 'toolu_wait_2', name: 'fca_wait', input: { summary: '子の結果を待つ' } }],
    ] });
    r.driver.runtime.send('owner', r.task.id, r.root.id, '原木を集める: failed', 'result:first');
    await r.settle(() => r.decisionBodies().length >= 1 && r.driver.runtime.get('owner', r.root.id)?.phase !== 'executing');
    r.driver.runtime.send('owner', r.task.id, r.root.id, '原木を集める: 再試行の結果', 'result:second');
    await r.settle(() => r.decisionBodies().length >= 2 && r.driver.runtime.get('owner', r.root.id)?.phase !== 'executing');
    expect(r.violations).toEqual([]);
    const second = r.decisionBodies()[1];
    expect(second).toBeDefined();
    expect(roles(second!)).toEqual(['user', 'user', 'system']);
    expect(JSON.stringify(second)).not.toContain('signed-root-1');
    expect(r.driver.runtime.get('owner', r.root.id)?.phase).not.toMatch(/unknown|failed/u);
    expect(stepLines(log)).toEqual([]);
  });
});
