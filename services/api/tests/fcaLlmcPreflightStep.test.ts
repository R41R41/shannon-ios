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
 * act-preflight (SHANNON_MINECRAFT_ACT_PREFLIGHT) through the real control and tools: with the switch on, an act whose walk goes into rock by the
 * newest frame's map is answered at once and nothing is sent to the body; with it off (or for an act the map does not fault) the command goes
 * as it always did.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); forgetActNodes(); });
const at = () => '2026-10-23T00:00:00.000Z';

/** A layers map of rock around the feet (220,56,62) with a corridor along +x two cells long. */
function map(): string {
  const lines = ['地図 v1 足=(220,56,62) x=213..227 z=55..69 方式=layers 上=北'];
  for (const dy of [1, 0, -1]) {
    const y = 56 + dy;
    lines.push(`y=${y}`);
    for (let z = 55; z <= 69; z += 1) {
      lines.push(` ${z} ${Array.from({ length: 15 }, (_, i) => {
        const x = 213 + i;
        if (z === 62 && x >= 220 && x <= 222 && dy >= 0) return x === 220 && dy === 0 ? '@' : '.';
        return '#';
      }).join(' ')}`);
    }
  }
  return lines.join('\n');
}

function run(preflight: boolean, hands: unknown[]) {
  const h = actionHarness(at), store = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.parse(at()), ownerAlone: () => true, pollMilliseconds: 1,
    leaseValid: lease => !!h.store.check(lease, at())?.resources.includes(actionResource('minebot', 'minecraft-body')) });
  const loose = { type: 'object', properties: {}, required: [], additionalProperties: false };
  let sequence = 0;
  const poll = () => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
    schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: at(), receivedAt: at(), connected: true,
      state: { world: { position: { x: 220.5, y: 56, z: 62.5 }, health: 20, localMap: map() } as never }, facts: {} as never },
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose }], candidates: [], receipts: [], activeOperationIds: [] } satisfies MinecraftControlPoll);
  poll();
  const plan = { revision: 3, current: 'p1.2', nodes: [{ id: 'p1', parentId: null, title: '出発の点検', state: 'continue' as const },
    { id: 'p1.2', parentId: 'p1', title: '西の幹へ', state: 'continue' as const }] };
  let decided = 0;
  const seen: string[] = [];
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: at,
    model: { async decide(input: unknown) {
      decided += 1;
      seen.push(JSON.stringify(input));
      if (decided > 1) return { decision: { kind: 'wait', summary: 'next' }, history: [{ role: 'assistant', content: 'read' }] };
      return { decision: { kind: 'tools', calls: [{ id: 'c-1', name: MC_ACT_TOOL, input: { hands, why: '[p1.2] 東へ' } }] }, history: [{ role: 'assistant', content: 'call' }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => ({ tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true,
      llmc: { plan: () => plan, probe: true, ...(preflight ? { preflight: true } : {}) } }) }),
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'End', goal: 'エンドラを討伐して' }, 'owner-request');
  store.bind(task.id, 'minecraft:world');
  cleanups.push(async () => { await driver.close(); h.close(); });
  return { driver, pending: () => store.pending('minecraft:world').length, seen };
}

describe('the switch SHANNON_MINECRAFT_ACT_PREFLIGHT in the real tools', () => {
  const intoRock = [{ do: 'walk', to: { x: 221, y: 56, z: 62 } }, { do: 'walk', to: { x: 224, y: 56, z: 62 } }];
  it('on: an act that walks into rock by the frame\'s map is answered at once, the second decision reads the fact, the body is sent nothing', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    const held = run(true, intoRock);
    await held.driver.tick();
    await held.driver.drain();
    await held.driver.tick();
    await held.driver.drain();
    expect(held.pending()).toBe(0);
    expect(held.seen.join('\n')).toContain('送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: 手 2 walk 一歩ではない: 足のマス (224,56,62) が 石の類（地図 #） で埋まっている');
    expect(lines.find(line => line.startsWith('Shannon Minecraft act held before send'))).toMatch(/hand=2 do=walk code=feet_solid$/u);
  });

  it('off: the same act goes to the body as it always did; on, an act the map does not fault goes too', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const off = run(false, intoRock);
    await off.driver.tick();
    for (let count = 0; count < 1000 && !off.pending(); count++) await delay(2);
    expect(off.pending()).toBe(1);
    const on = run(true, [{ do: 'walk', to: { x: 222, y: 56, z: 62 } }]);
    await on.driver.tick();
    for (let count = 0; count < 1000 && !on.pending(); count++) await delay(2);
    expect(on.pending()).toBe(1);
  });
});
