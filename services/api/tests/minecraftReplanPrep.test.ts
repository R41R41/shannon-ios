import { afterEach, describe, expect, it } from 'vitest';
import { planFromSeeds } from '@shannon/mind';
import type { DoneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { closedUnder, nodesSeenDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { keepPreparation } from '../src/surfaces/minecraft/minecraftReplanPrep.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { sheepAbsentLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { forgetReplans } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { createReplanFlow, type ReplanSources } from '../src/surfaces/minecraft/minecraftLlmcReplanFlow.js';
import { forgetStalls, type Stall } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';

/** e1111h2 (00:19): a same-spot stall in a water hole took the village node out and the current to iron; the beds were never taken. */
afterEach(() => { forgetReplans(); forgetStalls(); });
const facts = (extra: Partial<DoneFacts> = {}, items: Record<string, number> = {}): DoneFacts => ({ counts: new Map(Object.entries(items)), dimension: 'overworld',
  feet: { x: 250, y: 62, z: -92 }, food: 30, ...extra });
const tree = () => planFromSeeds([
  { title: '食料とベッド', kind: 'prep_descent', doneWhen: 'food>=40&have:bed>=1', children: [{ title: '村を回る', kind: 'village', doneWhen: 'have:bed>=8' }] },
  { title: '鉄', kind: 'iron', doneWhen: 'have:iron_pickaxe' },
])!;

describe('keepPreparation', () => {
  it('drops the set-blocked of the owed village node and the current moved past it', () => {
    const t = tree();
    const kept = keepPreparation(t, facts(), { ops: [{ op: 'set', id: 'p1.1', state: 'blocked', reason: '羊が見えない' }], current: 'p2' });
    expect(kept.update.ops ?? []).toEqual([]);
    expect(kept.update.current).toBeUndefined();
    expect(kept.dropped).toEqual(['p1.1', 'p2']);
    expect(kept.owed[0]).toContain('p1.1');
  });
  it('drops drop and move, and empties the update when nothing else is left', () => {
    const kept = keepPreparation(tree(), facts(), { ops: [{ op: 'drop', id: 'p1.1' }, { op: 'move', id: 'p1', after: 'p2' }], current: 'p2' });
    expect(kept.update).toEqual({});
    expect(kept.dropped).toEqual(['p1.1', 'p1', 'p2']);
  });
  it('lets a caution, an add and a current inside the owed node through', () => {
    const update = { ops: [{ op: 'caution' as const, id: 'p1.1', text: '水の縦穴' }, { op: 'add' as const, parent: 'p1.1', title: '穴から出る' }], current: 'p1.1' };
    const kept = keepPreparation(tree(), facts(), update);
    expect(kept.update).toBe(update);
    expect(kept.dropped).toEqual([]);
  });
  it('leaves a node the model wrote prep skipped on (or above), underground, without a frame, and without a done-condition', () => {
    const blocked = { ops: [{ op: 'set' as const, id: 'p1.1', state: 'blocked' as const }] };
    const skipped = tree();
    skipped.nodes.find(node => node.id === 'p1')!.prep = { state: 'skipped', why: '昼のうちに下る' };
    expect(keepPreparation(skipped, facts(), blocked).dropped).toEqual([]);
    expect(keepPreparation(tree(), facts({ feet: { x: 0, y: 30, z: 0 } }), blocked).dropped).toEqual([]);
    expect(keepPreparation(tree(), null, blocked).dropped).toEqual([]);
    const free = planFromSeeds([{ title: '村', kind: 'village' }, { title: '鉄', kind: 'iron', doneWhen: 'have:iron_pickaxe' }])!;
    expect(keepPreparation(free, facts(), { ops: [{ op: 'set', id: 'p1', state: 'blocked' }] }).dropped).toEqual([]);
  });
  it('leaves a node already met alone', () => {
    expect(keepPreparation(tree(), facts({ food: 40 }, { white_bed: 8 }), { ops: [{ op: 'set', id: 'p1.1', state: 'blocked' }] }).dropped).toEqual([]);
  });
});

describe('the flow keeps the preparation for a same-spot stall only', () => {
  const sources = (): ReplanSources => ({ node: 'p1.1', goal: 'x', seconds: 600, tree: tree(), doneStatus: null, now: [], facts: [], results: [], queue: [], knowledge: '' });
  async function run(kind: Stall['kind']) {
    const logs: string[] = [];
    const flow = createReplanFlow({ taskId: 'prep-t', saved: undefined, clock: () => 1_000, sources, check: () => null, log: line => logs.push(line),
      replanner: async () => ({ ops: [JSON.stringify({ op: 'set', id: 'p1.1', state: 'blocked', reason: '羊が見えない' })], current: 'p2', why: '外す' }),
      unskipped: update => keepPreparation(tree(), facts(), update) });
    flow.note({ kind, key: 'p1.1', why: 'x' });
    await flow.run(new AbortController().signal);
    return { logs, last: flow.ledger().last.at(-1) };
  }
  it('same_spot_stops: unchanged, with the reason in the record', async () => {
    const { logs, last } = await run('same_spot_stops');
    expect(logs.some(line => line.includes('replan kept preparation'))).toBe(true);
    expect(last?.outcome).toBe('unchanged');
    expect(last?.why).toContain('p1.1');
  });
  it('node_stalled: not touched', async () => {
    const { logs } = await run('node_stalled');
    expect(logs.some(line => line.includes('replan kept preparation'))).toBe(false);
  });
});

describe('the sheep line for a village node', () => {
  const now = (kind: string) => ({ id: 'p2.1', parentId: 'p2', title: '村のベッド', kind, doneWhen: 'have:bed>=8' }) as never;
  it('says nothing for a village node and still says it for a bed node', () => {
    const world = { position: { x: 0, y: 64, z: 0 } };
    expect(sheepAbsentLine(world, new Map(), 'overworld', [], now('village'))).toBeNull();
    expect(sheepAbsentLine(world, new Map(), 'overworld', [now('bed')], now('bed'))).toContain('羊: 今の節 p2.1');
  });
});

describe('the seed plan: the wood of the whole run is waited for', () => {
  it('has no done-condition on p1, and p1.4 stays open when the iron pickaxe is made with 3 logs', () => {
    const t = seedPlan('ネザーに行って')!;
    const p1 = t.nodes.find(node => node.id === 'p1')!;
    expect(p1.doneWhen).toBeUndefined();
    const f = facts({}, { oak_log: 3, iron_pickaxe: 1 });
    const seen = nodesSeenDone(t, f, true);
    expect(seen).not.toContain('p1');
    expect(closedUnder(t, seen, f).map(item => item.id)).not.toContain('p1.4');
  });
});
