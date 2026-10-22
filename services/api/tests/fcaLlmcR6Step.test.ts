import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlPoll } from '../src/contracts/minecraftControlContract.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { forgetActNodes } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { FCA_WAIT_REFUSALS, type FcaWaitAnswer } from '../src/mind/action/fca/fcaWaitGate.js';
import { amendAnthropicControl } from '../src/infra/models/anthropic/anthropicFcaControl.js';
import { actionHarness } from './support/actionThreadHarness.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';

/**
 * mb-llmc r6 in the common runner (production run 29, 2026-10-22: an operator's request, nobody to answer; Sonnet called fca_wait three
 * times, 「ここでタスクを止めます。再開には食料の補給が要ります」, and the third, past the two refusals, stopped the task 47 minutes early):
 * with the mode's answer a wait is no step toward a stop; it is answered in one line in place of its receipt and the task goes on.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); forgetActNodes(); });
const at = () => '2026-10-22T00:00:00.000Z';
const RECEIPT = JSON.stringify({ received: true, requestedDecision: 'wait' });

/** A task model that asks to wait at every decision, with the provider's history (the wait and its receipt). */
function waitingRun(answer?: FcaWaitAnswer) {
  const h = actionHarness(at);
  cleanups.push(h.close);
  const inputs: FcaModelInput[] = [];
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: at,
    model: { async decide(input) {
      inputs.push(input);
      const id = `toolu_${inputs.length}`;
      return { decision: { kind: 'wait', summary: `食料0・体力3.7で回復しない。ここでタスクを止めます（${inputs.length}）` }, history: [
        { role: 'assistant', content: [{ type: 'tool_use', id, name: 'fca_wait', input: { summary: 's' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: RECEIPT }] }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: () => ({ waitCounterpart: () => false, ...(answer ? { waitAnswer: answer } : {}) }),
  });
  cleanups.push(() => driver.close());
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '（運用者経由）エンドラを討伐してください', goal: 'エンドラを討伐してください' }, 'operator:run-29');
  const step = async () => { await driver.tick(); await driver.drain(); return driver.runtime.get('owner', task.id)!; };
  return { driver, task, inputs, step };
}

describe('a wait nobody can answer, in the mode (run 29: the third fca_wait stopped the task)', () => {
  const answer: FcaWaitAnswer = { line: () => '待ちではタスクは止まらない（運用者の依頼: 返事を待つ相手はいない）。待つ物が無い（焼いている物は無い）。計画の今の節を続ける。',
    amend: amendAnthropicControl };

  it('never stops the task and counts no refusal; the decision is told waits are answered', async () => {
    const run = waitingRun(answer);
    for (let index = 0; index < FCA_WAIT_REFUSALS + 3; index++) {
      const view = await run.step();
      expect(view.phase).toBe('ready');
      expect(run.driver.runtime.snapshot('owner', run.task.id)!.checkpoint).not.toHaveProperty('fcaWaitRefusals');
    }
    expect(run.inputs).toHaveLength(FCA_WAIT_REFUSALS + 3);
    expect(run.inputs[0]!.waiting).toEqual({ replyPossible: false, waits: 'answered' });
  });

  it('is answered in one line in place of its receipt, as an error the next decision reads', async () => {
    const run = waitingRun(answer);
    await run.step();
    await run.step();
    const last = JSON.stringify(run.inputs[1]!.history.at(-1));
    expect(last).toContain('待つ物が無い');
    expect(last).toContain('"is_error":true');
    expect(last).not.toContain('received');
  });

  it('without the answer (another task): turned away twice, then the task stops, as before', async () => {
    const run = waitingRun();
    for (let refused = 1; refused <= FCA_WAIT_REFUSALS; refused++) expect((await run.step()).phase).toBe('ready');
    expect(await run.step()).toMatchObject({ phase: 'stopped', pauseReason: 'fca_stopped' });
  });
});

/** The real control and tools (as fcaLlmcR4.test.ts): one act decided, its command read as the body would receive it. */
function actRun(why: string) {
  const h = actionHarness(at), store = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.parse(at()), ownerAlone: () => true, pollMilliseconds: 1,
    leaseValid: lease => !!h.store.check(lease, at())?.resources.includes(actionResource('minebot', 'minecraft-body')) });
  const loose = { type: 'object', properties: {}, required: [], additionalProperties: false };
  let sequence = 0;
  const poll = (receipts: MinecraftControlPoll['receipts'] = []) => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
    schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: at(), receivedAt: at(), connected: true,
      state: { world: { position: { x: 310.5, y: 61, z: 73.5 }, health: 20 } }, facts: {} },
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose }], candidates: [], receipts, activeOperationIds: [] } satisfies MinecraftControlPoll);
  poll();
  const plan = { revision: 3, current: 'p1.1', nodes: [{ id: 'p1', parentId: null, title: '出発の点検', state: 'continue' as const },
    { id: 'p1.1', parentId: 'p1', title: '作業台と板を作る', state: 'continue' as const }, { id: 'p2.1', parentId: null, title: 'ブレイズ', state: 'continue' as const }] };
  let decided = 0;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: at,
    model: { async decide() {
      decided += 1;
      if (decided > 1) return { decision: { kind: 'wait', summary: 'next' }, history: [{ role: 'assistant', content: 'read' }] };
      return { decision: { kind: 'tools', calls: [{ id: 'c-1', name: MC_ACT_TOOL, input: { hands: [{ do: 'wait', seconds: 1 }], why } }] },
        history: [{ role: 'assistant', content: 'call' }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => ({ tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true,
      llmc: { plan: () => plan, probe: true } }) }),
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'End', goal: 'エンドラを討伐して' }, 'owner-request');
  store.bind(task.id, 'minecraft:world');
  cleanups.push(async () => { await driver.close(); h.close(); });
  const command = async () => {
    await driver.tick();
    for (let count = 0; count < 1000 && !store.pending('minecraft:world').length; count++) await delay(1);
    const sent = poll().commands[0];
    // The body's receipt, so the step ends and the task closes.
    if (sent) poll([{ id: sent.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: at(), result: 'act 済み' }]);
    await driver.drain();
    return sent;
  };
  return { command, task };
}

describe('an act names its plan node, through the real tools (a hypothesis; the share is in the log)', () => {
  it('a why without a tag goes to the body with the current node first, and the act is counted', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    const run = actRun('ブレイズを倒す');
    const command = (await run.command())!;
    expect(command.arguments).toMatchObject({ why: '[p1.1] ブレイズを倒す' });
    expect(lines.find(line => line.startsWith('Shannon Minecraft act node')))
      .toBe(`Shannon Minecraft act node task=${run.task.id} node=p1.1 current=p1.1 by=head on=1 reason=0 acts=1 onPlan=0 off=0 offReason=0 urgent=0 head=1 parent=0 share=0.00`);
  });

  it('a tag of the model is sent as written and read: another node with its reason', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    const run = actRun('[p2.1] 理由: 4m にいる');
    expect((await run.command())!.arguments).toMatchObject({ why: '[p2.1] 理由: 4m にいる' });
    expect(lines.find(line => line.startsWith('Shannon Minecraft act node'))).toContain('node=p2.1 current=p1.1 by=model on=0 reason=1');
  });
});