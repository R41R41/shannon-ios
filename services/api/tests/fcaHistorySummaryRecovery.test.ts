import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import type { FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import { providerToolName, toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { FCA_HISTORY_POLICY } from '../src/mind/action/fca/fcaHistory.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * Minebot lane run 2 (2026-10-14 09:07 JST, production 581f3ebd, Haiku): task 94e879f8's third step had to compact its first round.
 * The summary call came back (stop tool_use, one fca_history_summary call, 2,105 of 4,000 output tokens), an exact shape check
 * refused it as FCA_SUMMARY_INVALID, and the step was left unknown: the task paused as fca_unknown and was retired as failed three
 * minutes later. Here the same task shape runs through the real runtime, native model, summarizer and history codec.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const GOAL = '原木を集める', CRITERIA = '原木を持っていることを新しい観測で確かめる。';
const find: FcaToolDefinition = { name: 'mc.find-blocks', description: '近くのブロックを探す。',
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const isSummary = (body: Record<string, unknown>) => (body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary');
const messages = (body: Record<string, unknown>) => body.messages as Array<{ role: string; content: unknown }>;
const summaryCall = (template: unknown): AnthropicMessage =>
  message([{ type: 'tool_use', id: `toolu_summary_${Math.random().toString(36).slice(2, 8)}`, name: 'fca_history_summary', input: { template } }], 'tool_use');

/** Steps 1–3 call mc.find-blocks (each result about 40,000 characters), step 4 waits; `summary` answers every summary request. */
function run(summary: () => AnthropicMessage) {
  let time = Date.parse('2026-10-14T00:06:57.000Z');
  const now = () => new Date(time).toISOString();
  const h = actionHarness(now);
  let decisions = 0;
  const fixture = scriptedAnthropic(body => {
    const violation = anthropicRequestViolation(body);
    if (violation) throw new Error(violation);
    if (isSummary(body)) return summary();
    decisions += 1;
    return decisions <= 3
      ? message([{ type: 'thinking', thinking: '探す', signature: `signed-round-${decisions}` },
        { type: 'tool_use', id: `toolu_find_${decisions}`, name: providerToolName('mc.find-blocks'), input: {} }], 'tool_use')
      : message([{ type: 'tool_use', id: `toolu_wait_${decisions}`, name: 'fca_wait', input: { summary: '原木へ近づく結果を待つ' } }], 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const tools: FcaExternalTools = { definitions: [find],
    async execute() { return toolOk(JSON.stringify({ found: 'oak_log', distance: 33, blocks: 'x'.repeat(40_000) })); } };
  const selector: FcaToolSelector = { async select(request) { return { names: request.tools.map(tool => tool.name), source: 'catalog' }; } };
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    canRunTask: (_runtime, id) => id === only,
    stepPorts: () => ({ tools, selector, history: { codec: anthropicFcaHistoryCodec, summarizer } }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: GOAL, goal: GOAL, completionCriteria: CRITERIA }, 'minecraft-request');
  only = task.id;
  async function settle(done: () => boolean) { for (let i = 0; i < 30 && !done(); i++) { await driver.tick(); await driver.drain(); time += 1_000; } }
  const decisionBodies = () => fixture.bodies.filter(body => !isSummary(body));
  const summaryBodies = () => fixture.bodies.filter(isSummary);
  return { driver, task, fixture, settle, decisionBodies, summaryBodies };
}
const stepLines = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA'));

describe('a third Minecraft step compacts its first round (Minebot lane run 2, task 94e879f8)', () => {
  it('installs the summary Haiku sent in the shape that was refused: an object, a long item, six items and an extra key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const long = 'mc.find-blocks で北東約33mにオークの原木を見つけた。座標 (112, 71, -40)。まだ近づいておらず、道中の段差と水場を確かめる必要がある。';
    const template = { ...Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木を集める作業の事実`]])),
      '済み': ['skill.read を読んだ', 'mc.find-blocks を実行', '原木を発見', '距離は約33m', '体力は満タン', long], coversFromId: 'fca-round:1' };
    const r = run(() => summaryCall(template));
    await r.settle(() => r.decisionBodies().length >= 3);
    expect(r.summaryBodies().length).toBeGreaterThanOrEqual(1);
    const third = messages(r.decisionBodies()[2]!);
    // A new epoch: the installed summary and round 2's public transcript in one bootstrap message, then the current decision.
    const bootstrap = String(third[0]!.content);
    expect(bootstrap).toContain('原木を発見');
    expect(JSON.stringify(third)).not.toContain('signed-round-1');
    expect(r.driver.runtime.history('owner', r.task.id)?.summary?.template['済み']).toHaveLength(5);
    expect(r.driver.runtime.get('owner', r.task.id)?.phase).not.toMatch(/unknown|failed/u);
    expect(stepLines(log).filter(line => line.startsWith('Shannon FCA step'))).toEqual([]);
  });

  it('replays a public epoch for the step when the summary is unusable, stores nothing, and asks again on the next step', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = run(() => summaryCall('{"目的": ["原木を集める"'));
    await r.settle(() => r.decisionBodies().length >= 4);
    const decisions = r.decisionBodies();
    expect(decisions).toHaveLength(4);
    const third = messages(decisions[2]!);
    // One public user message, then the current decision, the definitions added again after it (they end the request: a system
    // message between two user messages was a live 400, Minebot lane run 3); no signed block in it.
    expect(third.map(entry => entry.role)).toEqual(['user', 'user', 'system']);
    expect(JSON.stringify(third[0])).not.toContain('signed-round');
    expect(JSON.stringify(third[0]).length).toBeLessThanOrEqual(FCA_HISTORY_POLICY.maximumNativeCharacters + 100);
    const replay = JSON.parse(String(third[0]!.content)) as { kind: string; rounds: Array<{ sequence: number; messages: Array<{ role: string; callId?: string; content: string }> }> };
    expect(replay.kind).toBe('fca_public_history');
    expect(replay.rounds.map(round => round.messages.filter(entry => entry.role === 'tool_call').map(entry => entry.callId)))
      .toEqual([['toolu_find_1'], ['toolu_find_2']]);
    expect(replay.rounds.flatMap(round => round.messages.filter(entry => entry.role === 'tool_result').map(entry => entry.callId)))
      .toEqual(['toolu_find_1', 'toolu_find_2']);
    // The decision messages are projected without the parts each decision restates.
    const decision = replay.rounds[0]!.messages.find(entry => entry.role === 'user')!;
    expect(JSON.parse(decision.content)).toMatchObject({ task: { goal: GOAL }, restatedEachDecision: expect.arrayContaining(['catalog']) });
    expect(JSON.parse(decision.content)).not.toHaveProperty('catalog');
    const current = JSON.parse(String(third[1]!.content)) as { task: { goal: string; completionCriteria: string } };
    expect(current.task).toMatchObject({ goal: GOAL, completionCriteria: CRITERIA });
    // Nothing stored: no summary, the original rounds whole and signed.
    const window = r.driver.runtime.history('owner', r.task.id)!;
    expect(window.summary).toBeNull();
    expect(JSON.stringify(r.driver.runtime.snapshot('owner', r.task.id)!.history)).toContain('signed-round-1');
    // One summary call per step that needed one (steps 3 and 4), never a hidden retry; the task went on and waits.
    expect(r.summaryBodies()).toHaveLength(2);
    expect(r.driver.runtime.get('owner', r.task.id)?.phase).toBe('waiting');
    const lines = stepLines(log);
    expect(lines.filter(line => line.startsWith('Shannon FCA step'))).toEqual([]);
    expect(lines.filter(line => line.startsWith('Shannon FCA history summary unusable'))).toEqual([
      expect.stringMatching(/^Shannon FCA history summary unusable task=\S+ code=FCA_SUMMARY_INVALID reason=template fallback=public_epoch clipped=\d+ omittedRounds=0$/u),
      expect.stringMatching(/code=FCA_SUMMARY_INVALID reason=template fallback=public_epoch/u),
    ]);
    expect(lines.join('\n')).not.toContain(GOAL);
  });
});
