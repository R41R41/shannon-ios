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
 * SHANNON_MINECRAFT_LLMC_V2 (the guards): through the real control and tools, with the act-preflight on, an act whose third walk goes into rock is
 * (v2) sent as its first two hands, with the fact of the third and the one after it added to the body's own result, and (not v2) turned back whole;
 * an act whose first hand is the held one is turned back whole either way; the rule guard stops a bare bridge while a hostile sees her.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); forgetActNodes(); });
const at = () => '2026-10-23T00:00:00.000Z';

type World = { position: { x: number; y: number; z: number }; localMap: string; nearbyThreats?: unknown[]; health: number; recentStops?: string[] };
/** Rock around the feet (220,56,62) with a corridor along +x two cells long. */
function rock(): World {
  const lines = ['地図 v1 足=(220,56,62) x=213..227 z=55..69 方式=layers 上=北'];
  for (const dy of [1, 0, -1]) {
    lines.push(`y=${56 + dy}`);
    for (let z = 55; z <= 69; z += 1) {
      lines.push(` ${z} ${Array.from({ length: 15 }, (_, i) => {
        const x = 213 + i;
        if (z === 62 && x >= 220 && x <= 222 && dy >= 0) return x === 220 && dy === 0 ? '@' : '.';
        return '#';
      }).join(' ')}`);
    }
  }
  return { position: { x: 220.5, y: 56, z: 62.5 }, localMap: lines.join('\n'), health: 20 };
}
/** A ledge at x <= 10 (rock up to y=9), open air and a deep drop beyond it, feet (10,10,0); a wither skeleton in sight (or not). */
function ledge(sees: boolean): World {
  const lines = ['地図 v1 足=(10,10,0) x=4..14 z=-3..3 方式=layers 上=北'];
  for (let y = 11; y >= 4; y -= 1) {
    lines.push(`y=${y} x=4..14 z=-3..3`, 'z\\x 4 5 6 7 8 9 0 1 2 3 4');
    for (let z = -3; z <= 3; z += 1) lines.push(` ${z} ${Array.from({ length: 11 }, (_, i) => (4 + i === 10 && y === 10 && z === 0 ? '@' : 4 + i <= 10 && y <= 9 ? '#' : '.')).join(' ')}`);
  }
  return { position: { x: 10.5, y: 10, z: 0.5 }, localMap: lines.join('\n'), health: 20,
    nearbyThreats: [{ name: 'wither_skeleton', id: 4, distance: 6.7, position: { x: 13, y: 11, z: -2 }, canSee: sees }] };
}
const ACT_DONE = (n: number) => JSON.stringify({ v: 1, ok: true, done: n, of: n, ms: 1000, at: { x: 222, y: 56, z: 62 }, hp: 20, food: 20,
  lines: Array.from({ length: n }, (_, i) => ({ i: i + 1, do: 'walk', status: 'done', line: `(22${i + 1},56,62) に着いた` })) });

function run(flags: { urgent?: boolean }, world: World, hands: unknown[]) {
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
      state: { world: world as never }, facts: {} as never },
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose }], candidates: [], receipts, activeOperationIds: [] } satisfies MinecraftControlPoll);
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
      return { decision: { kind: 'tools', calls: [{ id: 'c-1', name: MC_ACT_TOOL, input: { hands, why: '[p1.2] 東へ', stopIf: { hpBelow: 12 } } }] }, history: [{ role: 'assistant', content: 'call' }] };
    }, toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => ({ tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true,
      llmc: { plan: () => plan, ...(flags.urgent ? { urgent: () => true } : {}) } }) }),
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'End', goal: 'エンドラを討伐して' }, 'owner-request');
  store.bind(task.id, 'minecraft:world');
  cleanups.push(async () => { await driver.close(); h.close(); });
  const pending = () => store.pending('minecraft:world').length;
  const waitPending = async () => { for (let count = 0; count < 1000 && !pending(); count++) await delay(2); };
  /** The body answers the sent command with `result`; the second decision then reads the tool result. */
  const answer = async (result: string) => {
    const sent = poll().commands[0];
    if (sent) poll([{ id: sent.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: at(), result }]);
    await driver.drain();
    await driver.tick();
    await driver.drain();
    return sent;
  };
  return { driver, pending, waitPending, answer, seen };
}
const walk = (x: number) => ({ do: 'walk', to: { x, y: 56, z: 62 } });

describe('the guards of SHANNON_MINECRAFT_LLMC_V2 in the real tools', () => {
  const hands = [walk(221), walk(222), walk(224)];
  it('v2: the two hands before the held walk go to the body, and the result carries the fact of the third as a tail, after the body\'s own line', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    const held = run({}, rock(), hands);
    await held.driver.tick();
    await held.waitPending();
    expect(held.pending()).toBe(1);
    const sent = await held.answer(ACT_DONE(2));
    expect((sent?.arguments as { hands: unknown[]; stopIf: unknown; why: string }).hands).toEqual([walk(221), walk(222)]);
    expect(sent?.arguments).toMatchObject({ stopIf: { hpBelow: 12 }, why: '[p1.2] 東へ' });
    const text = held.seen.join('\n');
    expect(text).toContain('act 全部済み（2/2');
    expect(text).toContain('手 3 から先 1 手（全 3 手のうち）は体へ送っていない（送る前に止めた。手は 1 つも動いていない）: 手 3 walk 一歩ではない: 足のマス (224,56,62) が 石の類');
    expect(text.indexOf('act 全部済み（2/2')).toBeLessThan(text.indexOf('手 3 から先 1 手'));
    expect(text).toContain('"ok":false');
    expect(lines.find(line => line.startsWith('Shannon Minecraft act held partway'))).toMatch(/hand=3 sent=2 code=feet_solid$/u);
  });

  it('v2: when the first hand is the held one nothing is sent either', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const first = run({}, rock(), [walk(224), walk(222)]);
    await first.driver.tick();
    await first.driver.drain();
    await first.driver.tick();
    await first.driver.drain();
    expect(first.pending()).toBe(0);
    expect(first.seen.join('\n')).toContain('送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: 手 1 walk 一歩ではない');
  });

  it('v2: an act the guards do not fault goes whole, and its result has no tail', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const clean = run({}, rock(), [walk(221), walk(222)]);
    await clean.driver.tick();
    await clean.waitPending();
    expect(clean.pending()).toBe(1);
    const sent = await clean.answer(ACT_DONE(2));
    expect((sent?.arguments as { hands: unknown[] }).hands).toHaveLength(2);
    expect(clean.seen.join('\n')).not.toContain('体へ送っていない');
  });

  const bridge = [{ do: 'sneak', on: true }, { do: 'place', block: 'nether_bricks', at: [{ x: 11, y: 9, z: 0 }] }, { do: 'walk', to: { x: 11, y: 10, z: 0 } }];
  it('v2: a bare bridge over a deep drop with a hostile in sight is held at its place; the sneak before it is sent', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen = run({}, ledge(true), bridge);
    await seen.driver.tick();
    await seen.waitPending();
    expect(seen.pending()).toBe(1);
    const sent = await seen.answer(ACT_DONE(1));
    expect((sent?.arguments as { hands: unknown[] }).hands).toEqual([{ do: 'sneak', on: true }]);
    expect(seen.seen.join('\n')).toContain('手 2 から先 2 手（全 3 手のうち）は体へ送っていない');
    expect(seen.seen.join('\n')).toContain('#4 wither_skeleton が見えている');
    expect(seen.seen.join('\n')).toContain('壁の無い橋');
  });

  it('v2: the same bridge with nothing in sight goes whole', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const quiet = run({}, ledge(false), bridge);
    await quiet.driver.tick();
    await quiet.waitPending();
    expect(((await quiet.answer(ACT_DONE(3)))?.arguments as { hands: unknown[] }).hands).toHaveLength(3);
  });

  it('v2, an urgent decision: the act goes to the body three hands at most, and the rest comes back as a fact (not urgent: whole)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const five = [walk(221), walk(222), walk(221), walk(222), walk(221)];
    const urgent = run({ urgent: true }, rock(), five);
    await urgent.driver.tick();
    await urgent.waitPending();
    expect(((await urgent.answer(ACT_DONE(3)))?.arguments as { hands: unknown[] }).hands).toHaveLength(3);
    expect(urgent.seen.join('\n')).toContain('手 4 から先 2 手（全 5 手のうち）は体へ送っていない');
    expect(urgent.seen.join('\n')).toContain('急ぎの判断は 3 手まで');
    const calm = run({}, rock(), five);
    await calm.driver.tick();
    await calm.waitPending();
    expect(((await calm.answer(ACT_DONE(5)))?.arguments as { hands: unknown[] }).hands).toHaveLength(5);
  });

  it('v2: a dig of the cell that stopped for 「見られる」 a moment ago is not sent without exposeOk, and goes with it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const world = { ...rock(), recentStops: ['(221,56,62) 見られる 3秒前'],
      nearbyThreats: [{ name: 'blaze', id: 7, distance: 6, position: { x: 226, y: 58, z: 60 }, canSee: true }] };
    const dig = (extra: object) => [{ do: 'dig', at: [{ x: 221, y: 56, z: 62 }], ...extra }];
    const held = run({}, world, dig({}));
    await held.driver.tick();
    await held.driver.drain();
    await held.driver.tick();
    await held.driver.drain();
    expect(held.pending()).toBe(0);
    expect(held.seen.join('\n')).toContain('(221,56,62) は直前に「見られる」で止まった（3秒前。今も見える敵: blaze #7 6.0m）');
    const open = run({}, world, dig({ exposeOk: true }));
    await open.driver.tick();
    await open.waitPending();
    expect(open.pending()).toBe(1);
  });
});
