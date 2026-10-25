import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { createBodyTaskRecall, recordEssence } from '../src/mind/recall/bodyTaskRecall.js';
import type { TaskMemory, TaskMemoryItem } from '../src/mind/memory/taskMemoryPorts.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { createSurpriseWatch, forgetSurpriseWatches, stepProbes, surpriseFrame } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { llmcModelNames } from '../src/wiring/minecraftLlmcWiring.js';

/**
 * mb-llmc r5 (production run 28, 2026-10-22) in the modules r4 already had: a pickup's surprise looked at, another task's places marked in
 * the recall, no raise by default, and the completion's receipt replaced by the mistake's line.
 */
afterEach(() => { forgetSurpriseWatches(); });
/** The mark of a record from before the task (bodyTaskRecall.ts ELSEWHERE). */
const ELSEWHERE = '［前のタスクの記録';

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });
describe('a pickup stopped twice the same way (run 28: 19 of 「無い」, probed with the history alone)', () => {
  const pickup = { hands: [{ do: 'pickup', target: 'coal' }] };
  const stop = (line: string) => `act 0/1 済みで止まった（failure）\n1 pickup 止 ${line}\n今 (164,55,197) 体力20 満腹20`;
  const world = (items: Array<{ x: number; y: number; z: number; d: number }>) => frame({ position: at(164.5, 55, 197.5), health: 20, dimension: 'overworld',
    nearbyEntities: items.map(item => ({ name: 'item', distance: item.d, position: at(item.x + 0.3, item.y, item.z + 0.6) })) });

  it('looks at the drop its line names, else the nearest dropped item: a sight when near, a path when far', () => {
    const named = createSurpriseWatch('r5-pick-named');
    named.detect(surpriseFrame(world([]), 1), null);
    // The body's r5 words (r4-contract.md 08:20): the drop's cell first, then where it is from her and what is between.
    const line = '無い: 拾った: なし。拾えなかった: coal（そこまで着けない。(166,56,198) 自分から東2・1.9m、間に (165,56,198) stone）';
    for (let index = 0; index < 2; index++) named.noteResult(MC_ACT_TOOL, false, stop(line), pickup);
    const [one] = named.detect(surpriseFrame(world([]), 1), null);
    expect(one!.probes).toEqual([{ kind: 'history', at: at(164, 55, 197), radius: 4 }, { kind: 'sight', target: at(166, 56, 198) }]);

    const near = createSurpriseWatch('r5-pick-near');
    near.detect(surpriseFrame(world([]), 1), null);
    for (let index = 0; index < 2; index++) near.noteResult(MC_ACT_TOOL, false, stop('無い'), pickup);
    const [two] = near.detect(surpriseFrame(world([{ x: 170, y: 55, z: 200, d: 9 }, { x: 166, y: 54, z: 197, d: 2 }]), 1), null);
    expect(stepProbes([two!])).toEqual([{ kind: 'history', at: at(164, 55, 197), radius: 4 }, { kind: 'sight', target: at(166, 54, 197) }]);

    const far = createSurpriseWatch('r5-pick-far');
    far.detect(surpriseFrame(world([]), 1), null);
    for (let index = 0; index < 2; index++) far.noteResult(MC_ACT_TOOL, false, stop('無い'), pickup);
    const [three] = far.detect(surpriseFrame(world([{ x: 175, y: 55, z: 197, d: 11 }]), 1), null);
    expect(three!.probes[1]).toEqual({ kind: 'path', to: at(175, 55, 197) });
  });
});

describe('another task\'s places in the recall (run 28: run 27\'s plan row, another world, with its coordinates)', () => {
  const item = (id: string, summary: string, observedAt: string): TaskMemoryItem => ({ id, summary, observedAt, evidence: 'e', applicability: 'a',
    confidence: null, conflicts: [], detailRef: id });
  const plan27 = item('plan27', 'タスク経験 [success] 目的: エンドラを討伐してください\n行動: {"id":"toolu_1","name":"plan.update","input":{"ops":[]}}\n'
    + '観測結果: 計画 rev4（済み 6/54）… 廃坑の板材と柵を掘り集める＠83m 西 (-80,33,11)', '2026-10-21T15:00:00.000Z');
  const dig27 = item('dig27', 'タスク経験 [failure] 目的: エンドラを討伐してください\n行動: {"id":"toolu_2","name":"mc.act","input":{}}\n'
    + '観測結果: act 0/2 済みで止まった（failure）: dig 掘れない (12,40,-7) の stone は鉄のツルハシが要る', '2026-10-21T15:10:00.000Z');
  const dig28 = item('dig28', 'タスク経験 [failure] 目的: エンドラを討伐してください\n行動: {"id":"toolu_3","name":"mc.act","input":{}}\n'
    + '観測結果: dig 見えない: (175,53,197) の stone の手前に stone', '2026-10-21T20:30:00.000Z');
  const memory = (items: TaskMemoryItem[]): TaskMemory => ({ available: () => true, search: () => items,
    read: (_scope, ids) => ids.flatMap(id => items.filter(entry => entry.id === id)), sources: (_scope, ids) => ids.map(id => `source:${id}`),
    async execute() { throw new Error('unused'); } });

  it('a plan\'s own rows are no lesson for another task', () => {
    expect(recordEssence(plan27.summary).value).toBe(false);
    expect(recordEssence(dig27.summary).value).toBe(true);
  });

  it('a record from before the task that names a place is marked; one of this task is not', async () => {
    const recall = createBodyTaskRecall({ memory: memory([plan27, dig27, dig28]), state: { snapshot: () => ({}) as never } });
    const found = await recall.packet({ scopeKey: 'owner', taskId: 't28', goal: 'エンドラを討伐してください', present: OWNER_AUDIENCE,
      cues: { words: ['掘れない', 'stone'], tags: [], since: '2026-10-21T20:11:52.101Z' } });
    const byId = new Map(found.packet.items.map(entry => [entry.id, entry.summary]));
    expect(byId.has('plan27')).toBe(false);
    expect(byId.get('dig27')!.startsWith(ELSEWHERE)).toBe(true);
    expect(byId.get('dig28')!.startsWith(ELSEWHERE)).toBe(false);
  });
});

describe('the models and the completion\'s receipt (r5)', () => {
  it('no raise unless the environment asks for one (run 28: 9 raises, 23% of the cost, the same stops after)', () => {
    expect(llmcModelNames({}).escalate).toBeNull();
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_MODEL: 'claude-sonnet-5-5', SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next' }).escalate).toBe('claude-opus-5-5');
  });

  it('the model\'s receipt of a completion is replaced by the line, as an error; nothing else is', async () => {
    // A module of r5's (loaded here so the other tests of this file run on r4's sources too).
    const { amendAnthropicControl } = await import('../src/infra/models/anthropic/anthropicFcaControl.js');
    // The receipt as the model really appends it (a scripted completion through createAnthropicFcaModel).
    const fixture = scriptedAnthropic(() => message([{ type: 'tool_use', id: 'toolu_9', name: 'fca_complete', input: { summary: '区切ります' } }], 'tool_use'));
    const model = createAnthropicFcaModel({ model: 'claude-sonnet-5-5', apiKey: 'k', recordUsage() {}, fetcher: fixture.fetcher });
    const out = await model.decide({ task: { id: 't', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [], children: [], history: [],
      tools: [] }, new AbortController().signal);
    const receipt = out.history.at(-1) as { content: Array<Record<string, unknown>> };
    expect(receipt.content.at(-1)).toMatchObject({ tool_use_id: 'toolu_9', content: '{"received":true,"requestedDecision":"complete"}' });
    const amended = amendAnthropicControl(receipt, '完了の誤り') as unknown as { content: Array<Record<string, unknown>> };
    expect(amended.content.at(-1)).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_9', content: '完了の誤り', is_error: true });
    expect(amendAnthropicControl({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'act 済み' }] }, '完了の誤り')).toBeNull();
  });
});
