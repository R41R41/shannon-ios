import { afterEach, describe, expect, it } from 'vitest';
import { planFromSeeds, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { createPaceWatch, paceDelay, PACE_GRACE_SECONDS } from '../src/surfaces/minecraft/minecraftLlmcPace.js';
import { forgetReplans, REPLAN, type ReplanLedger } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { forgetStalls, noteProgress } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { createWaitLedger, explorationEvidence } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import type { LlmcQueue } from '../src/surfaces/minecraft/minecraftLlmcQueueState.js';
import { unheldReplan } from '../src/wiring/minecraftLlmcReplanWiring.js';

afterEach(() => {
  forgetReplans();
  forgetStalls();
});

const began = Date.parse('2026-11-05T00:00:00Z');
const frame = (world: object): BodyObservation => ({ connected: true, bodyId: 'b', state: { world }, facts: {} }) as unknown as BodyObservation;
const nether = (x = 0, y = 64): BodyObservation => frame({ dimension: 'the_nether', position: { x, y, z: 0 },
  health: 20, food: 20, inventory: [], localMap: '地図 v1 方式=surface' });
const plan = (): PlanTree => planFromSeeds([
  { id: 'search', title: '要塞を探す', kind: 'fortress', doneWhen: 'see:fortress' },
  { id: 'dragon', title: '竜', kind: 'dragon' },
])!;
const go: ActInput = { hands: [{ do: 'go', to: { x: 1_000, y: 64, z: 0 } }] };
const fortressMarks = ['N ネザー要塞 (10,64,0) 東10m レンガ×30'];

function setup(saved: unknown = null) {
  const tree = plan();
  let observation = nether();
  let elapsed = 3_200;
  let held = 0;
  const briefs: string[] = [];
  const lines: string[] = [];
  const closed: string[] = [];
  const persisted: Record<string, unknown>[] = [];
  const queue = { onRan() {}, lines: () => [], runningInput: () => go,
    closeStep: (why: string) => closed.push(why) } as unknown as LlmcQueue;
  const unheld = unheldReplan({ held: false, taskId: 'pace', goal: 'エンドラを討伐して', createdAt: new Date(began).toISOString(),
    checkpoint: saved, observe: () => observation, plan: { tree: () => tree, view: () => null }, queue,
    bodyParts: { plan: () => undefined, planView: () => null, planTree: () => tree }, waits: createWaitLedger(null),
    activeClock: () => began + (elapsed - held) * 1_000, heldMs: () => held * 1_000, validate: () => null,
    persist: keys => {
      persisted.push(keys);
      return true;
    },
    replanner: async (_system, brief) => {
      briefs.push(brief);
      return { ops: [], why: '観測を確かめた' };
    },
    log: line => lines.push(line) })!;
  return { unheld, briefs, lines, closed, persisted,
    at: (seconds: number, x = 0) => {
      elapsed = seconds;
      observation = nether(x);
    },
    hold: (seconds: number) => { held = seconds; },
    observe: (next: BodyObservation) => { observation = next; } };
}

describe('a running but late stretch', () => {
  it('uses the meter target and a five-minute grace, with no guessed time or non-dragon notice', () => {
    expect(PACE_GRACE_SECONDS).toBe(300);
    expect(paceDelay(plan(), nether(), 3_499)).toBeNull();
    expect(paceDelay(plan(), nether(), 3_500)).toEqual({ milestone: 'ネザー要塞', targetSeconds: 3_200, secondsBehind: 300 });
    expect(paceDelay(plan(), null, 50_000)).toBeNull();
    expect(paceDelay(plan(), nether(), null)).toBeNull();
    expect(paceDelay(plan(), nether(), NaN)).toBeNull();
    const other = planFromSeeds([{ id: 'wood', title: '木', kind: 'wood' }])!;
    expect(paceDelay(other, nether(), 50_000)).toBeNull();
  });

  it('passes behind_pace through the wired replan flow despite fresh exploration on every look', async () => {
    const run = setup();
    for (const [index, seconds] of [3_200, 3_290, 3_380, 3_470, 3_499].entries()) {
      run.at(seconds, index * 16);
      expect(run.unheld.watch.look()).toBe(false);
    }
    run.at(3_500, 100);
    expect(run.unheld.watch.look()).toBe(true);
    await run.unheld.flow.run(new AbortController().signal);
    expect(run.briefs).toHaveLength(1);
    expect(run.briefs[0]).toContain('種類 behind_pace');
    expect(run.briefs[0]).toContain('節目 ネザー要塞・目安 3200 秒・遅れ 300 秒');
    expect(run.briefs[0]).toContain('開始から 58 分 20 秒');
    expect(run.unheld.flow.ledger()).toMatchObject({ total: 1, nodes: { search: 1 } });
    expect(run.closed).toEqual(['stall']);
    expect(run.persisted[0]).toMatchObject({ minecraftBehindPace: ['ネザー要塞'], minecraftReplanPending: null });
  });

  it('raises once per milestone across node changes and serialized worker checkpoints', () => {
    const watch = createPaceWatch(null);
    expect(watch.note(plan(), nether(), 3_500)?.kind).toBe('behind_pace');
    const changed = { ...plan(), current: 'dragon' };
    expect(watch.note(changed, nether(), 3_600)).toBeNull();
    const saved = JSON.parse(JSON.stringify(watch.checkpoint()));
    const restored = createPaceWatch(saved.minecraftBehindPace);
    expect(restored.note(changed, nether(), 4_000)).toBeNull();
    const fortress = frame({ dimension: 'the_nether', inventory: [], mapLandmarks: fortressMarks });
    expect(restored.note(changed, fortress, 5_000)).toMatchObject({ kind: 'behind_pace', why: expect.stringContaining('ブレイズロッド 7 本') });
    expect(restored.note(changed, fortress, 5_100)).toBeNull();
    expect(createPaceWatch(['not a milestone', {}, 'ネザー要塞']).checkpoint()).toEqual({ minecraftBehindPace: ['ネザー要塞'] });
  });

  it('keeps both the one-time marker and pending reason for the next step', async () => {
    const first = setup();
    first.at(3_500);
    first.unheld.watch.look();
    const saved = JSON.parse(JSON.stringify(first.unheld.checkpoint()));
    expect(saved.minecraftReplanPending.stall.kind).toBe('behind_pace');
    forgetStalls();
    const next = setup(saved);
    next.at(3_501);
    expect(next.unheld.watch.look()).toBe(false);
    await next.unheld.flow.run(new AbortController().signal);
    expect(next.briefs).toHaveLength(1);
    expect(next.briefs[0]).toContain('節目 ネザー要塞・目安 3200 秒・遅れ 301 秒');
  });

  it('leaves time held out of detection and the brief, just like the meter', async () => {
    const run = setup();
    run.hold(900);
    run.at(4_399);
    expect(run.unheld.watch.look()).toBe(false);
    run.at(4_400, 16);
    expect(run.unheld.watch.look()).toBe(true);
    await run.unheld.flow.run(new AbortController().signal);
    expect(run.briefs[0]).toContain('遅れ 300 秒');
    expect(run.briefs[0]).toContain('開始から 58 分 20 秒');
  });

  it('drops a pending pace notice when its milestone was reached while waiting for a replan slot', async () => {
    const run = setup();
    run.at(3_500);
    run.unheld.watch.look();
    run.observe(frame({ dimension: 'the_nether', inventory: [], mapLandmarks: fortressMarks }));
    await run.unheld.flow.run(new AbortController().signal);
    expect(run.briefs).toHaveLength(0);
    expect(run.unheld.checkpoint().minecraftReplanPending).toBeNull();
  });
});

describe('the existing replan limits still bound behind_pace', () => {
  const empty = (): ReplanLedger => ({ v: 1, total: 0, recent: [], nodes: {}, last: [] });
  const now = began + 3_500_000;
  const cases: Array<[string, ReplanLedger]> = [
    ['gap', { ...empty(), total: 1, recent: [now - 1] }],
    ['hour', { ...empty(), total: REPLAN.perHour, recent: Array.from({ length: REPLAN.perHour }, (_, index) => now - 600_000 - index) }],
    ['run', { ...empty(), total: REPLAN.perRun }],
    ['node', { ...empty(), total: REPLAN.perNode, nodes: { search: REPLAN.perNode } }],
  ];
  it.each(cases)('obeys %s without an extra model call', async (why, ledger) => {
    const run = setup({ minecraftReplans: ledger });
    run.at(3_500);
    expect(run.unheld.watch.look()).toBe(true);
    await run.unheld.flow.run(new AbortController().signal);
    expect(run.briefs).toHaveLength(0);
    expect(run.lines.some(line => line.includes(`kind=behind_pace why=${why}`))).toBe(true);
    if (why !== 'gap') return;
    run.at(3_500 + REPLAN.gapMs / 1_000);
    await run.unheld.flow.run(new AbortController().signal);
    expect(run.briefs).toHaveLength(1);
  });
});

describe('exploration credit follows the direction of the search', () => {
  it.each(['pearl', 'blaze', 'fortress', 'wood', 'food', 'village'] as const)('%s ignores vertical motion but credits new columns', kind => {
    const node = planFromSeeds([{ id: 's', title: '探す', kind }])!.nodes[0]!;
    const evidence = (x: number, y: number) => explorationEvidence(node, go, nether(x, y));
    expect(evidence(0, 64)).toEqual(evidence(0, 80));
    expect(evidence(16, 80)).not.toEqual(evidence(0, 80));
    const progress = (y: number) => ({ node: 's', state: 'continue', milestone: null, items: 0, purpose: evidence(0, y) });
    noteProgress('vertical', progress(64), 0);
    expect(noteProgress('vertical', progress(72), 60_000)).toBeNull();
    expect(noteProgress('vertical', progress(80), 120_000)?.kind).toBe('node_stalled');
  });

  it.each(['stronghold', 'iron', 'diamond', 'obsidian'] as const)('%s keeps vertical credit for descent and mining', kind => {
    const node = planFromSeeds([{ id: 's', title: '下りる', kind }])!.nodes[0]!;
    const evidence = (y: number) => explorationEvidence(node, go, nether(0, y));
    expect(evidence(64)).not.toEqual(evidence(48));
    const progress = (y: number) => ({ node: 's', state: 'continue', milestone: null, items: 0, purpose: evidence(y) });
    noteProgress('descent', progress(170), 0);
    expect(noteProgress('descent', progress(130), 100_000)).toBeNull();
    expect(noteProgress('descent', progress(90), 200_000)).toBeNull();
  });
});
