import { afterEach, describe, expect, it } from 'vitest';
import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { FcaBodyLifecycle } from '../src/mind/action/fca/fcaPorts.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { forgetReplans, REPLAN, withReplanInbox } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { forgetStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { LlmcQueue, RanListener } from '../src/surfaces/minecraft/minecraftLlmcQueueState.js';
import { createWaitLedger } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { doneClaimProblem, unheldReplan, withReplan } from '../src/wiring/minecraftLlmcReplanWiring.js';

afterEach(() => {
  forgetReplans();
  forgetStalls();
});

const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {}, bodyId: 'b', sequence: 1, stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
const idle = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [{ name: 'oak_log', count: 2 }] });
const dragon = seedPlan('エンドラを討伐して')!;
const tree = { ...dragon, current: 'p1.1' };
const signal = new AbortController().signal;

function setup(over: { held?: boolean; reply?: () => Promise<unknown>; checkpoint?: unknown; planTree?: () => PlanTree } = {}) {
  const clock = { now: 0 };
  const listeners: RanListener[] = [];
  const briefs: string[] = [];
  const lines: string[] = [];
  const liveTree = () => over.planTree?.() ?? tree;
  const queue = { onRan: (listener: RanListener) => { listeners.push(listener); }, lines: () => ['▶ q1: go'], runningInput: () => null } as unknown as LlmcQueue;
  const unheld = unheldReplan({ held: over.held ?? false, taskId: 'uw', goal: 'エンドラを討伐して', createdAt: new Date(0).toISOString(), checkpoint: over.checkpoint ?? null,
    replanner: async (_system, brief) => {
      briefs.push(brief);
      return over.reply ? over.reply() : { ops: [{ op: 'caution', text: '木の近くの敵に気をつける' }], why: '木の節に注意を足した' };
    },
    observe: () => idle, plan: { tree: liveTree, view: () => null },
    bodyParts: { plan: () => undefined, planView: () => null, planTree: liveTree, endgame: createEndgame(null) },
    queue, waits: createWaitLedger(null), activeClock: () => clock.now, heldMs: () => 0, validate: () => null, log: line => lines.push(line) });
  return { clock, listeners, briefs, lines, unheld };
}

describe('the look and the plan made again for a task that is not held, wired', () => {
  it('is not made for a task held on a failure (it has its own look)', () => {
    expect(setup({ held: true }).unheld).toBeNull();
  });

  it('finds a stall by the clock, asks once with a brief that names the node and the pack, and hands the answer to the plan\'s next read', async () => {
    const { clock, briefs, lines, unheld } = setup();
    unheld!.watch.look();
    clock.now = 130_000;
    expect(unheld!.watch.look()).toBe(true);
    await unheld!.flow.run(signal);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain('止まった節: p1.1');
    expect(briefs[0]).toContain('持ち物: oak_log×2');
    expect(briefs[0]).toContain('▶p1.1');
    expect(lines.some(line => line.includes('replan task=uw node=p1.1 kind=node_stalled outcome=changed ops=1'))).toBe(true);
    const taken = withReplanInbox({ take: () => null }).take('uw', tree)!;
    expect(taken.tree.nodes.find(node => node.id === 'p1.1')!.caution).toEqual(['木の近くの敵に気をつける']);
    expect(taken.note).toContain('木の節に注意を足した');
    expect(unheld!.checkpoint()).toMatchObject({ minecraftReplans: { v: 1, total: 1, nodes: { 'p1.1': 1 } } });
  });

  it('writes the stall record when it asks (kind, seconds, the strong model wait, the count against the cap, the body state), and says when the body got out of the node', async () => {
    const { clock, lines, unheld } = setup();
    unheld!.watch.look();
    clock.now = 130_000;
    unheld!.watch.look();
    await unheld!.flow.run(signal);
    const record = lines.find(line => line.startsWith('Shannon Minecraft stall record task=uw '));
    expect(JSON.parse(record!.replace('Shannon Minecraft stall record task=uw ', ''))).toMatchObject({ kind: 'node_stalled', node: 'p1.1', idleSeconds: 130, outcome: 'changed',
      gapWaitMs: 0, nodeAsks: 1, nodeCap: 3, vitals: { enemies16: 0 } });
    unheld!.flow.escaped('p1.1');
    expect(lines.some(line => line.startsWith('Shannon Minecraft stall escaped'))).toBe(false);
    clock.now = 190_000;
    unheld!.flow.escaped('p2');
    expect(lines).toContain('Shannon Minecraft stall escaped task=uw node=p1.1 afterSeconds=60 replan=changed');
    unheld!.flow.escaped('p3');
    expect(lines.filter(line => line.startsWith('Shannon Minecraft stall escaped'))).toHaveLength(1);
  });

  it('watches the queue\'s results too (a result is a look), and puts the wait it saved into the checkpoint', () => {
    const { clock, listeners, unheld } = setup();
    expect(listeners).toHaveLength(2);
    clock.now = 10_000;
    listeners[1]!({ call: { id: 'c1', name: 'mc.act', input: { hands: [{ do: 'wait' }] } }, why: 'x' } as never, { ok: true, text: 'x' } as never, undefined);
    expect(unheld!.checkpoint()).toHaveProperty('minecraftActiveWait');
  });

  it('closes the step for a stronger stage at a result too, not only at the start of a step (review of 11/3)', () => {
    let stage: 'end' | null = null;
    const closed: string[] = [];
    const fake = { watch: { look: () => false }, flow: { escaped: () => undefined, run: async () => undefined }, current: () => null,
      stage: () => stage, close: (reason: string) => { closed.push(reason); } };
    const wrapped = withReplan({ noteResult() { /* the inner lifecycle */ } } as unknown as FcaBodyLifecycle, fake as never);
    wrapped.noteResult!({ name: 'mc.act', input: {} } as never, { ok: true, text: '' } as never, 10);
    expect(closed).toEqual([]);
    stage = 'end';
    wrapped.noteResult!({ name: 'mc.act', input: {} } as never, { ok: true, text: '' } as never, 10);
    expect(closed).toEqual(['stage']);
  });

  it('works inside the lifecycle: a look at each decision\'s start and result, and the plan made again before the decision', async () => {
    const { clock, briefs, unheld } = setup();
    const calls: string[] = [];
    const base = { async beforeDecision() { calls.push('before'); }, noteResult() { calls.push('noted'); } } as unknown as FcaBodyLifecycle;
    const wrapped = withReplan(base, unheld);
    clock.now = 1_000;
    wrapped.noteResult!({ name: 'mc.act', input: {} } as never, { ok: true, text: '' } as never, 10);
    clock.now = 140_000;
    await wrapped.beforeDecision!(signal);
    expect(calls).toEqual(['noted', 'before']);
    expect(briefs).toHaveLength(1);
    expect(withReplan(base, null)).toBe(base);
  });

  it('keeps a stall found at the end of a step for the next step (a death is seen once)', async () => {
    const first = setup();
    first.unheld!.flow.note({ kind: 'death', key: '1-1', why: '死んだ（死の回数 1）' });
    const saved = JSON.parse(JSON.stringify(first.unheld!.checkpoint()));
    expect(saved.minecraftReplanPending).toMatchObject({ stall: { kind: 'death', key: '1-1' } });
    const next = setup({ checkpoint: saved });
    await next.unheld!.flow.run(signal);
    expect(next.briefs).toHaveLength(1);
    expect(next.briefs[0]).toContain('死んだ');
    expect(next.unheld!.checkpoint().minecraftReplanPending).toBeNull();
  });

  it('says nothing when the strong model\'s answer cannot be used, and counts the attempt', async () => {
    const { clock, unheld } = setup({ reply: async () => 'not an answer' });
    unheld!.watch.look();
    clock.now = 130_000;
    unheld!.watch.look();
    await unheld!.flow.run(signal);
    expect(unheld!.flow.ledger().total).toBe(1);
    expect(unheld!.flow.ledger().last[0]).toMatchObject({ outcome: 'refused' });
    expect(withReplanInbox({ take: () => null }).take('uw', tree)).toBeNull();
  });
});

describe('a queued stall follows whether its work still exists, not just the current node', () => {
  const waiting = (kind = 'node_stalled') => ({
    minecraftReplans: { v: 1, total: 1, recent: [0], nodes: { 'p1.1': 1 }, last: [] },
    minecraftReplanPending: { stall: { kind, key: 'p1.1', why: '節 p1.1 が進まない' }, at: 0 },
  });

  it.each(['done', 'removed', 'parent_done'] as const)(
    'drops the old node stall after %s during the gap, without asking or spending another attempt', async change => {
      let live: PlanTree = tree;
      const { clock, briefs, lines, unheld } = setup({ checkpoint: waiting(), planTree: () => live });
      clock.now = 1_000;
      await unheld!.flow.run(signal);
      expect(unheld!.checkpoint().minecraftReplanPending).not.toBeNull();
      const changed = change === 'parent_done' ? 'p1' : 'p1.1';
      live = { ...tree, current: 'p1.2', nodes: change === 'removed'
        ? tree.nodes.filter(node => node.id !== 'p1.1')
        : tree.nodes.map(node => node.id === changed ? { ...node, state: 'done' as const } : node) };
      unheld!.flow.escaped('p1.2');
      clock.now = 2_000;
      await unheld!.flow.run(signal);
      expect(unheld!.checkpoint().minecraftReplanPending).toBeNull();
      clock.now = REPLAN.gapMs;
      await unheld!.flow.run(signal);
      expect(briefs).toEqual([]);
      expect(unheld!.flow.ledger().total).toBe(1);
      expect(unheld!.checkpoint().minecraftReplanPending).toBeNull();
      expect(lines.some(line => line.includes('replan task=uw'))).toBe(false);
    },
  );

  it.each(['continue', 'blocked'] as const)('keeps unfinished %s work after the current node moves elsewhere', async state => {
    const live = { ...tree, current: 'p2', nodes: tree.nodes.map(node => node.id === 'p1.1' ? { ...node, state } : node) };
    const { clock, briefs, unheld } = setup({ checkpoint: waiting(), planTree: () => live });
    clock.now = REPLAN.gapMs;
    unheld!.flow.escaped('p2');
    await unheld!.flow.run(signal);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain('止まった節: p1.1');
    expect(unheld!.flow.ledger().total).toBe(2);
  });

  it.each(['death', 'same_spot_stops', 'wait_loop'])(
    'keeps %s recovery when the old node was completed', async kind => {
      const live = { ...tree, current: 'p2', nodes: tree.nodes.map(node => node.id === 'p1' ? { ...node, state: 'done' as const } : node) };
      const { clock, briefs, unheld } = setup({ checkpoint: waiting(kind), planTree: () => live });
      clock.now = kind === 'death' ? 1_000 : REPLAN.gapMs;
      unheld!.flow.escaped('p2');
      await unheld!.flow.run(signal);
      expect(briefs).toHaveLength(1);
      expect(unheld!.flow.ledger().last.at(-1)).toMatchObject({ node: 'p2', kind });
      expect(unheld!.checkpoint().minecraftReplanPending).toBeNull();
    },
  );
});

describe('what the strong model may not close', () => {
  it('refuses a node given as done whose own observed condition does not hold, and lets one that holds (or has none) through', () => {
    const before = tree;
    const claim = (id: string) => ({ ...before, nodes: before.nodes.map(node => node.id === id ? { ...node, state: 'done' as const } : node) });
    const world = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'oak_log', count: 9 }] });
    expect(doneClaimProblem(before, claim('p1.1'), world)).toBeNull();
    expect(doneClaimProblem(before, claim('p1.3'), world)).toContain('p1.3');
    // with no frame to read, a node with an observed condition is not closed either; one with none is
    expect(doneClaimProblem(before, claim('p1.3'), null)).toContain('観測が取れていない');
    const free = { ...before, nodes: before.nodes.map(node => node.id === 'p1.3' ? { ...node, doneWhen: undefined, state: 'done' as const } : node) };
    expect(doneClaimProblem(before, free, null)).toBeNull();
  });
});
