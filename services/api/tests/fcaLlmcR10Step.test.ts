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
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * mb-llmc r10 (H2; run 34, 2026-10-22, the seventh unknown): the flee reflex held the body at 17:30:00–12 and dug her down nine blocks; an urgent
 * act sent at 17:30:05 was cut by the reflex's lease, sat unsettled 4 s and made the step unknown, and the recovery limit stopped the task.
 * Through the real control and tools: an act is not sent to the body while one of its multi-hand reflexes holds it (the body's ledger, newest
 * first, with whole seconds of age), and goes as soon as the ledger has been silent for two seconds.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); forgetActNodes(); });
const at = () => '2026-10-22T00:00:00.000Z';
const FLEE = (ageSec: number) => ({ ageSec, kind: 'flee', detail: '低体力で逃げ道なし：足元を掘って下がった' });

function actRun(reflexes: () => Array<Record<string, unknown>>, held: () => string | null = () => null, withKey = false) {
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
      state: { world: { position: { x: 220.5, y: 56, z: 62.5 }, health: 7.5, reflexes: { recent: reflexes(), counts: { flee: 3 } } } as never }, facts: (withKey ? { reflexHeld: held() } : {}) as never },
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose }], candidates: [], receipts, activeOperationIds: [] } satisfies MinecraftControlPoll);
  poll();
  const plan = { revision: 3, current: 'p1.2', nodes: [{ id: 'p1', parentId: null, title: '出発の点検', state: 'continue' as const },
    { id: 'p1.2', parentId: 'p1', title: '西の幹へ', state: 'continue' as const }] };
  let decided = 0;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: at,
    model: { async decide() {
      decided += 1;
      if (decided > 1) return { decision: { kind: 'wait', summary: 'next' }, history: [{ role: 'assistant', content: 'read' }] };
      return { decision: { kind: 'tools', calls: [{ id: 'c-1', name: MC_ACT_TOOL, input: { hands: [{ do: 'dig', at: [{ x: 220, y: 56, z: 62 }] }], why: '[急ぎ] 北の岩へ入り塞ぐ' } }] },
        history: [{ role: 'assistant', content: 'call' }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => ({ tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true,
      llmc: { plan: () => plan } }) }),
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'End', goal: 'エンドラを討伐して' }, 'owner-request');
  store.bind(task.id, 'minecraft:world');
  cleanups.push(async () => { await driver.close(); h.close(); });
  const pending = () => store.pending('minecraft:world').length;
  const sendReceipt = async () => {
    const sent = poll().commands[0];
    if (sent) poll([{ id: sent.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: at(), result: 'act 済み' }]);
    await driver.drain();
    return sent;
  };
  return { driver, poll, pending, sendReceipt, task };
}

describe('an act waits for facts.reflexHeld of the body r10 (the key decides, the ledger is not asked)', () => {
  it('is not sent while the body names the reflex that holds it, goes when the key is null again, with a fresh ledger all the while', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let held: string | null = 'floor-flee';
    const run = actRun(() => [FLEE(0)], () => held, true);
    await run.driver.tick();
    await delay(700);
    run.poll();
    expect(run.pending()).toBe(0);
    held = null;
    run.poll();
    for (let count = 0; count < 1000 && !run.pending(); count++) await delay(5);
    expect(run.pending()).toBe(1);
    await run.sendReceipt();
  });
});

describe('an act waits for the reflex that holds the body (run 34, the seventh unknown)', () => {
  it('is not sent while the flee reflex wrote a hand a second ago; goes once the ledger has been silent, said in the log', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    let ledger = [FLEE(0), FLEE(1), FLEE(2)];
    const run = actRun(() => ledger);
    await run.driver.tick();
    await delay(700);
    // 0.7 s on, the reflex's last hand is still a second or less old: nothing went to the body.
    run.poll();
    expect(run.pending()).toBe(0);
    ledger = [FLEE(3), FLEE(4), FLEE(5)];
    run.poll();
    for (let count = 0; count < 1000 && !run.pending(); count++) await delay(5);
    expect(run.pending()).toBe(1);
    const sent = await run.sendReceipt();
    expect(sent?.arguments).toMatchObject({ why: '[急ぎ] 北の岩へ入り塞ぐ' });
    expect(lines.find(line => line.startsWith('Shannon Minecraft act waited for reflex'))).toMatch(/kind=flee ms=\d+ gaveUp=0$/u);
  });

  it('no reflex in the ledger, or one that is not a multi-hand one: sent at once, nothing waited for', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    const run = actRun(() => [{ ageSec: 0, kind: 'eat', detail: '食べた' }]);
    await run.driver.tick();
    for (let count = 0; count < 1000 && !run.pending(); count++) await delay(1);
    expect(run.pending()).toBe(1);
    await run.sendReceipt();
    expect(lines.some(line => line.startsWith('Shannon Minecraft act waited for reflex'))).toBe(false);
  });
});
