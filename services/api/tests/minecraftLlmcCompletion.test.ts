import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PLAN_TREE_SCHEMA, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaBodyLifecycle, FcaModel, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { llmcCompletionMistake, llmcTools } from '../src/wiring/minecraftLlmcWiring.js';
import { COMPLETION_WAY, planCompletion, type LlmcCompletion } from '../src/surfaces/minecraft/minecraftLlmcCompletion.js';

/**
 * Production 2026-10-26 04:43 and 04:49 (Sonnet 5.5): 「木を3本集めて」 and 「原木を10本集めて、作業台と木のツルハシを作って」 had their plans done by the
 * head's code and the goods in hand, and were stopped by five completions turned back: a request bound to no goal needs conditions set with
 * `goal.set_conditions`, which the mode's six tools do not include. A completion of such a task is now checked by the plan and the new frame.
 */
const at = '2026-10-26T00:00:00.000Z';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function frame(world: Record<string, unknown> | null): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: at, receivedAt: at, connected: true,
    state: { world: (world ?? {}) as never }, facts: { alive: true } };
}
const pack = (...items: Array<[string, number]>) => frame({ position: { x: -337, y: 67, z: -313 }, dimension: 'overworld',
  inventory: items.map(([name, count]) => ({ name, count })) });
const node = (id: string, title: string, doneWhen: string | undefined, state: PlanNode['state'] = 'done', extra: Partial<PlanNode> = {}): PlanNode =>
  ({ id, parentId: null, order: Number(id.replace(/\D/gu, '')), title, state, ...(doneWhen ? { doneWhen } : {}), ...extra });
const tree = (...nodes: PlanNode[]): PlanTree => ({ schema: PLAN_TREE_SCHEMA, revision: 4, current: null, nodes });

/** The plans the two tasks ended with (fca_task checkpoints of production, 2026-10-26). */
const WOOD = tree(node('p1', '近くのオークを3本切る', 'have:log>=11'), node('n1', '木を3本集める', 'have:oak_log>=3'));
const PICKAXE = tree(node('p1', '原木を10本集める', 'have:log>=10'), node('p2', '板にして作業台を作る', 'have:crafting_table'),
  node('p3', '棒と木のツルハシを作る', 'have:wooden_pickaxe'));

describe('a completion of a request bound to no goal is checked by the plan and the new frame', () => {
  it('stands for 「木を3本集めて」 as production ended it: both nodes done, 10 oak and 2 birch in the pack', () => {
    const result = planCompletion(WOOD, pack(['oak_log', 10], ['birch_log', 2], ['stick', 1]), null);
    expect(result).toMatchObject({ ok: true });
    expect(result.reason).toContain('計画の全ての節が済み');
  });

  it('is turned back while a node is open, and names it (the first completion of the task, 8 logs of the 11 the first plan asked)', () => {
    const open = tree(node('p1', '近くのオークを3本切る', 'have:log>=11', 'continue'));
    const result = planCompletion(open, pack(['oak_log', 8]), null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('p1 近くのオークを3本切る');
    expect(result.reason).toContain('済んでいない節');
  });

  it('stands for the pickaxe request with the table placed and the logs made into planks: one node the frame holds is enough', () => {
    expect(planCompletion(PICKAXE, pack(['oak_log', 9], ['birch_log', 2], ['wooden_pickaxe', 1]), null).ok).toBe(true);
    // p1 (10 logs) and p2 (a table in the pack) no longer hold: they were seen done when they were true.
    expect(planCompletion(PICKAXE, pack(['oak_log', 4], ['wooden_pickaxe', 1]), null).ok).toBe(true);
  });

  it('is turned back when no node that an observation can show holds now (the pickaxe is gone), and says what the last one lacks', () => {
    const result = planCompletion(PICKAXE, pack(['oak_log', 2]), null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('1 つも満たされていない');
    expect(result.reason).toContain('p3 have:wooden_pickaxe');
    expect(result.reason).toContain('wooden_pickaxe 0/1');
  });

  it('counts a node the frame shows done now as done, though the plan still says continue (the act that made it came just before)', () => {
    const lagging = tree(node('p1', '原木を10本集める', 'have:log>=10'), node('p2', 'ツルハシ', 'have:wooden_pickaxe', 'continue'));
    expect(planCompletion(lagging, pack(['oak_log', 10], ['wooden_pickaxe', 1]), null).ok).toBe(true);
    expect(planCompletion(lagging, pack(['oak_log', 10]), null).ok).toBe(false);
  });

  it('counts a node open under a done parent as no longer needed (the plan closes it the same way), but not a blocked one', () => {
    const child = (state: PlanNode['state']) => tree(node('p1', '道具', 'have:wooden_pickaxe'),
      node('p1.1', '原木を集める', undefined, state, { parentId: 'p1', order: 1 }));
    expect(planCompletion(child('continue'), pack(['wooden_pickaxe', 1]), null).ok).toBe(true);
    expect(planCompletion(child('blocked'), pack(['wooden_pickaxe', 1]), null).ok).toBe(false);
  });

  it('wants a node that an observation can show: a plan of free words only is turned back, with the way to a completion', () => {
    const words = tree(node('p1', '木を集める', '原木3本を持つ'), node('p2', '作業台', undefined));
    const result = planCompletion(words, pack(['oak_log', 3]), null);
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain('観測で確かめられる済む条件');
    expect(COMPLETION_WAY).toContain('have:');
    expect(planCompletion(tree(), pack(['oak_log', 3]), null).reason).toContain('節が無く');
  });

  it('needs a new frame', () => {
    expect(planCompletion(WOOD, null, null)).toMatchObject({ ok: false });
    expect(planCompletion(WOOD, null, null).reason).toContain('観測がまだ取れていない');
  });

  it('asks the Nether as well for a request that names it, and never stands for the dragon (its proof is the binding)', () => {
    const nether = tree(node('p1', '木の道具', 'have:wooden_pickaxe'), node('p2', 'ネザーへ', 'dim:nether'));
    const inOverworld = pack(['wooden_pickaxe', 1]);
    expect(planCompletion(nether, inOverworld, 'nether').reason).toContain('ネザーにいる観測が無い');
    const inNether = frame({ position: { x: 1, y: 70, z: 1 }, dimension: 'the_nether', inventory: [{ name: 'wooden_pickaxe', count: 1 }] });
    expect(planCompletion(nether, inNether, 'nether').ok).toBe(true);
    expect(planCompletion(nether, inNether, 'dragon')).toEqual({ ok: false, reason: '' });
  });
});

describe('the mode\'s tools check a completion that is bound to no goal, and leave the dragon\'s binding as it was', () => {
  const definition: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
  const base = combineFcaTools({ definitions: [definition], async execute() { return { ok: true, text: 'x', retryable: true }; } });
  const call = { scopeKey: 'owner', taskId: 't', operationId: 'op', name: 'goal.verify', input: {}, signal: new AbortController().signal };
  const check = (state: { tree: PlanTree; observation: BodyObservation | null }, goal: string): LlmcCompletion => ({ tree: () => state.tree, observe: () => state.observation, goal });

  it('verifies 「木を3本集めて」 from its plan, and turns it back with the reason while a node is open', async () => {
    const state = { tree: tree(node('p1', '近くのオークを3本切る', 'have:log>=11', 'continue')), observation: pack(['oak_log', 8]) };
    const tools = llmcTools(createFcaProgressTools(base, { permit: async () => undefined, requireConditions: true }), check(state, '木を3本集めて'));
    const turned = await tools.progress!.verifyCompletion(call, async () => undefined);
    expect(turned).toMatchObject({ status: 'not_verified', bindingId: null });
    expect(turned.reason).toContain('p1 近くのオークを3本切る');
    state.tree = WOOD; state.observation = pack(['oak_log', 10], ['birch_log', 2]);
    const stood = await tools.progress!.verifyCompletion(call, async () => undefined);
    expect(stood).toMatchObject({ status: 'verified', bindingId: null });
    expect(stood.checks).toHaveLength(1);
  });

  it('leaves a completion bound to a goal as the binding judged it, with no reason of the plan', async () => {
    const binding = { id: 'minecraft-dragon:x', conditions: [{ id: 'never', tool: MC_ACT_TOOL, input: {}, path: 'x', operator: 'exists' as const }] };
    const state = { tree: WOOD, observation: pack(['oak_log', 10]) };
    const tools = llmcTools(createFcaProgressTools(base, { permit: async () => undefined, requireConditions: true, binding }), check(state, 'エンドラを討伐してください'));
    const result = await tools.progress!.verifyCompletion(call, async () => undefined);
    expect(result.status).toBe('not_verified');
    expect(result.bindingId).toBe('minecraft-dragon:x');
    expect(result.reason).toBeUndefined();
  });

  it('does not tell the model to set conditions with a tool it has not: the rule it reads is the plan\'s', () => {
    const state = { tree: WOOD, observation: pack(['oak_log', 10]) };
    const plain = createFcaProgressTools(base, { permit: async () => undefined, requireConditions: true });
    expect(plain.progress.context().completionRule).toContain('goal.set_conditions');
    const rule = (goal: string) => llmcTools(plain, check(state, goal)).progress!.context().completionRule;
    expect(rule('木を3本集めて')).toBe(COMPLETION_WAY);
    expect(rule('木を3本集めて')).not.toContain('goal.set_conditions');
    expect(rule('エンドラを討伐して')).toContain('エンドラの死を見届けた記録に結び付いていない');
    // Without the check (the tools as they were) the progress is as it was.
    expect(llmcTools(plain).progress!.context().completionRule).toContain('goal.set_conditions');
  });

  it('says the reason in the mistake\'s line, after the count, with the way to a completion; without one the line is as it was', () => {
    const mistake = llmcCompletionMistake('木を3本集めて');
    const line = mistake.line(2, '計画にまだ済んでいない節がある（p1 近くのオークを3本切る）');
    expect(line).toContain('完了の誤り（続けて 2 回目）: 計画にまだ済んでいない節がある（p1 近くのオークを3本切る）。');
    expect(line).toContain(COMPLETION_WAY);
    expect(mistake.line(1)).toContain('完了は依頼の目的を観測した時だけ');
    expect(llmcCompletionMistake('エンドラを討伐してください').line(1)).toContain('ドラゴンの死を見た時だけ');
  });
});

describe('through the runner: the two production tasks complete instead of stopping at the fifth', () => {
  function fixture(goal: string, state: { tree: PlanTree; observation: BodyObservation | null }) {
    const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
    const actions = new SQLiteActionStore(db);
    const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => at,
      leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
    const root = runtime.ensureRoot('owner');
    const task = runtime.createChild('owner', root.id, { title: 'Body task', goal, completionCriteria: '目的の達成を新しいワールド観測と実行結果から確認する。' }, 'body');
    const inputs: FcaModelInput[] = [];
    const lifecycle: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false, transient: () => ({ map: 'm' }) };
    const RECEIPT = JSON.stringify({ received: true, requestedDecision: 'complete' });
    const model: FcaModel = {
      async decide(input) {
        const index = inputs.length, id = `toolu_${index}`;
        inputs.push(input);
        const head = { role: 'user', content: `decision ${index} ${'x'.repeat(400)}` };
        return { decision: { kind: 'complete', summary: '依頼は済んだ' },
          history: [head, { role: 'assistant', content: [{ type: 'tool_use', id, name: 'fca_complete', input: { summary: 's' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: RECEIPT }] }] };
      },
      toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; },
    };
    const amend = (turn: unknown, text: string) => {
      const message = turn as { role: string; content: Array<Record<string, unknown>> };
      return Array.isArray(message?.content) && message.content[0]?.content === RECEIPT
        ? { role: 'user', content: [{ ...message.content[0], content: text, is_error: true }] } : null;
    };
    const definition: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
    const run = async () => {
      const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `c-${inputs.length}-${Math.random()}`, kind: 'agentTask', origin: 'owner_request' }, at).id,
        'worker', at)!;
      const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
      const progress = createFcaProgressTools(combineFcaTools({ definitions: [definition], async execute() { return { ok: true, text: 'x', retryable: true }; } }),
        { permit: async () => undefined, requireConditions: true });
      const tools = llmcTools(progress, { tree: () => state.tree, observe: () => state.observation, goal });
      const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body: lifecycle, permit: async () => true, model, tools,
        completionMistake: { ...llmcCompletionMistake(goal), amend } };
      await runFcaStep(step, ports, new AbortController().signal);
      actions.finish(step.lease, 'completed', 'yielded', at); runtime.acknowledgeReceipt('owner', step.id);
    };
    return { run, inputs, phase: () => runtime.get('owner', task.id)?.phase };
  }

  it('「木を3本集めて」: turned back with the open node named, then completed once the plan and the pack show it', async () => {
    const state = { tree: tree(node('p1', '近くのオークを3本切る', 'have:log>=11', 'continue')), observation: pack(['oak_log', 8]) as BodyObservation | null };
    const f = fixture('木を3本集めて', state);
    await f.run();
    expect(f.phase()).toBe('ready');
    await f.run();
    expect(JSON.stringify(f.inputs[1]!.history.at(-1))).toContain('p1 近くのオークを3本切る');
    state.tree = WOOD; state.observation = pack(['oak_log', 10], ['birch_log', 2]);
    await f.run();
    expect(f.phase()).toBe('completed');
  });

  it('「原木を10本集めて、作業台と木のツルハシを作って」: completes at its first completion with the plan done and the pickaxe in hand', async () => {
    const f = fixture('原木を10本集めて、作業台と木のツルハシを作って', { tree: PICKAXE, observation: pack(['oak_log', 9], ['birch_log', 2], ['wooden_pickaxe', 1]) });
    await f.run();
    expect(f.phase()).toBe('completed');
  });

  it('a plan of free words stops at the fifth turned-back completion, as the task did before, each told what it lacks', async () => {
    const f = fixture('村を見つけて', { tree: tree(node('p1', '村を探す', '村が見える')), observation: pack(['oak_log', 3]) });
    for (let index = 0; index < 4; index++) await f.run();
    expect(f.phase()).toBe('ready');
    expect(JSON.stringify(f.inputs[3]!.history.at(-1))).toContain('観測で確かめられる済む条件');
    await f.run();
    expect(f.phase()).toBe('stopped');
  });
});
