import { afterEach, describe, expect, it } from 'vitest';
import type { PlanPromise, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { InventoryEvent } from '../src/contracts/continueContract.js';
import { applyLedger, breakingOf, emptyLedgerSeen, readLedgerSeen } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { forgetStalls, noteProgress, noteRan } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { followNode, forgetActNodes, missingNodeFact, noteItemStart, workingNode } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { staleNodeFacts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { forgetOnceFacts, pending } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';

afterEach(() => { forgetStalls(); forgetActNodes(); forgetOnceFacts(); });
const stamp = '2026-10-30T00:00:00Z';
const promise = (over: Partial<PlanPromise> = {}): PlanPromise => ({ id: 1, rev: 1, item: 'iron_ingot', count: 1, use: '火打ち金', state: 'open', ledger: [], ...over });
const frame = (items: Record<string, number>, seq = 1): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:w', sequence: seq, stateAt: stamp, receivedAt: stamp, connected: true,
  state: { world: { inventory: items, dimension: 'overworld', position: { x: 0, y: 64, z: 0 } }, bodyRun: { bodyBoot: 'bb', connectionId: 'c' } }, facts: {} } as BodyObservation);
const event = (id: string, item: string, count: number, reason: InventoryEvent['reason']): InventoryEvent => ({ id, item, count, reason, obsSeq: 2 });

describe('run 48: an actual use for the reserved product is not a breach', () => {
  const make = [{ do: 'make', item: 'flint_and_steel' }];
  it('does not escalate flint and steel; a different use still breaks the reservation', () => {
    const pack = frame({ iron_ingot: 1, flint: 1 });
    expect(breakingOf([promise()], make, pack)).toMatchObject({ lines: [], keptBy: ['約束 #1 は申告の用途（火打ち金）に使う見込み'] });
    expect(breakingOf([promise()], [{ do: 'make', item: 'iron_boots' }], pack).lines).toHaveLength(1);
    expect(breakingOf([promise({ use: '帰り道の予備' })], make, pack).lines).toHaveLength(1);
  });
  it('leaves other promises reserved, without counting the fulfilled reservation against them', () => {
    const others = [promise(), promise({ id: 2, use: '予備' })];
    expect(breakingOf(others, make, frame({ iron_ingot: 2, flint: 1 })).lines).toEqual([]);
    expect(breakingOf(others, make, frame({ iron_ingot: 1, flint: 1 })).lines).toHaveLength(1);
  });
  it('closes only from ingredient and product events of the same real hand; a repeat is idempotent', () => {
    const before = applyLedger([promise()], emptyLedgerSeen(), { events: [], observation: frame({ iron_ingot: 1, flint: 1 }), at: stamp });
    const events = [event('skill:c:1:1:0', 'iron_ingot', -1, 'ingredient'), event('skill:c:1:1:1', 'flint_and_steel', 1, 'crafted')];
    const used = applyLedger(before.promises, before.ledgerSeen, { events, observation: frame({ flint_and_steel: 1 }, 2), at: stamp });
    expect(used.promises[0]).toMatchObject({ state: 'closed', closedBy: 'used', have: 0 });
    expect(used.added.filter(line => line.kind === 'closed')).toHaveLength(1);
    expect(applyLedger(used.promises, used.ledgerSeen, { events, observation: frame({ flint_and_steel: 1 }, 2), at: stamp }).added).toEqual([]);
    for (const changed of [events.slice(0, 1), [events[0]!, { ...events[1]!, id: 'skill:c:1:2:1' }]]) {
      expect(applyLedger(before.promises, before.ledgerSeen, { events: changed, observation: frame({ flint_and_steel: 1 }, 2), at: stamp }).promises[0]!.state).toBe('open');
    }
  });
  it('does not close a larger promise from one unit, or a revised purpose using the previous definition', () => {
    const events = [event('skill:c:1:1:0', 'iron_ingot', -1, 'ingredient'), event('skill:c:1:1:1', 'flint_and_steel', 1, 'crafted')];
    for (const held of [promise({ count: 4 }), promise({ rev: 2, use: '予備' })]) {
      expect(applyLedger([held], emptyLedgerSeen(), { events, observation: frame({ flint_and_steel: 1 }, 2), at: stamp }).promises[0]!.state).toBe('open');
    }
  });
  it.each([false, true])('joins receipt pages across a checkpoint (product first: %s)', productFirst => {
    const ingredient = event('skill:c:1:1:0', 'iron_ingot', -1, 'ingredient'), product = event('skill:c:1:1:1', 'flint_and_steel', 1, 'crafted');
    const first = applyLedger([promise()], emptyLedgerSeen(), { events: [productFirst ? product : ingredient], observation: null, at: stamp });
    expect(first.promises[0]!.state).toBe('open');
    const next = applyLedger(first.promises, readLedgerSeen(JSON.parse(JSON.stringify(first.ledgerSeen))), {
      events: [productFirst ? ingredient : product], observation: frame({ flint_and_steel: 1 }, 2), at: stamp,
    });
    expect(next.promises[0]).toMatchObject({ state: 'closed', closedBy: 'used' });
  });
});

describe('run 48: n2–n4 were tags, never nodes of the saved plan', () => {
  const tree = { schema: 'shannon.plan-tree.v2', revision: 1, current: 'n1', nodes: [{ id: 'n1', parentId: null, order: 0, title: '鉄へ', state: 'continue', kind: 'iron' }], promises: [] } as PlanTree;
  it('explains a missing node even when there is no dragon node; the model adds it and the existing follower moves to it', () => {
    noteItemStart('t', 'n2', 'n1'); noteItemStart('t', 'n2', 'n1');
    expect(workingNode('t')).toBe('n2');
    expect(workingNode('t', 'n3')).toBeNull(); // an explicit plan update supersedes work sent under another current node
    expect(followNode('t', tree)).toBeNull();
    expect(missingNodeFact('t', tree)).toContain('計画に存在しない');
    expect(staleNodeFacts('t', tree, null).some(fact => fact.text.includes('plan_update'))).toBe(true);
    const repaired = { ...tree, nodes: [...tree.nodes, { ...tree.nodes[0]!, id: 'n2', order: 1 }] };
    expect(followNode('t', repaired)).toMatchObject({ to: 'n2' });
    staleNodeFacts('t', repaired, null);
    expect(pending('t').some(fact => fact.key === 'missing_node')).toBe(false);
  });
  it('counts a new work tag, a gained product with a smaller total pack, and a new milestone as progress', () => {
    const base = { node: 'n1', state: 'continue', milestone: null, items: 50, inventory: { iron_ingot: 5 }, reached: ['鉄'] };
    for (const changed of [{ ...base, node: 'n2' }, { ...base, items: 46, inventory: { iron_ingot: 0, flint_and_steel: 1 } }, { ...base, reached: ['鉄', 'ネザー'] }]) {
      forgetStalls(); noteProgress('t', base, 0);
      expect(noteProgress('t', changed, 119_000)).toBeNull();
      expect(noteProgress('t', changed, 120_000)).toBeNull();
      expect(noteProgress('t', changed, 239_000)?.kind).toBe('node_stalled');
    }
  });
});

describe('run 48: a reflex is not the first failed attempt at an explained path', () => {
  const at = { x: 159, y: -8, z: 241 };
  const ran = (code: string, cutBy?: string) => noteRan('t', { hands: [{ do: 'vertical' }], result: JSON.stringify({ v: 1, ok: false, done: 0, of: 1, at, hp: 20, food: 20, ms: 5_000,
    lines: [{ i: 1, do: 'vertical', status: 'stopped', line: '', goal: 'partial', end: cutBy ? 'cut' : 'finished', code, ...(cutBy ? { cutBy } : {}), progress: { unit: 'step', done: 1, left: 3, at } }] }) });
  it('returns the first threat to the model, and holds the repeated threat', () => {
    expect(ran('wall_escape', 'reflex')).toBeNull();
    expect(ran('threat_exposed')).toBeNull();
    expect(ran('threat_exposed')?.kind).toBe('same_spot_stops');
  });
  it('does not mix different explained causes into two attempts', () => {
    expect(ran('falling_above')).toBeNull();
    expect(ran('threat_exposed')).toBeNull();
    expect(ran('threat_exposed')?.kind).toBe('same_spot_stops');
  });
});
