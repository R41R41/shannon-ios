import { afterEach, expect, it } from 'vitest';
import { planFromSeeds } from '@shannon/mind';
import { purposeEvidence, travelEvidence, lookTravelEvidence, observedWait, createWaitLedger } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { forgetStalls, noteProgress, noteRan, stallsCheckpoint, restoreStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
afterEach(forgetStalls);
const frame = (world: object) => ({ connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
const snapshot = (iron: number, stone = 0) => ({ node: 'iron', state: 'doing', milestone: 'iron', items: iron + stone,
  inventory: { iron_ingot: iron, cobblestone: stone }, purpose: { iron } });
it('holds pointless stock growth, while real objective growth renews the window', () => {
  noteProgress('bad', snapshot(0), 0);
  expect(noteProgress('bad', snapshot(0, 200), 120000)?.kind).toBe('node_stalled');
  noteProgress('good', snapshot(0), 0);
  expect(noteProgress('good', snapshot(1), 119000)).toBeNull();
  expect(noteProgress('good', snapshot(1), 120000)).toBeNull();
});
it('does not count withdrawing the same stock again, even across a restart', () => {
  noteProgress('t', snapshot(3), 0);
  noteProgress('t', snapshot(0), 60000);
  const saved = stallsCheckpoint('t').minecraftStalls;
  forgetStalls(); restoreStalls('t', saved);
  expect(noteProgress('t', snapshot(3), 120000)?.kind).toBe('node_stalled');
});
it('credits new observed exploration cells once, rather than walking in circles', () => {
  const seen = (cells: string[]) => ({ ...snapshot(0), purpose: Object.fromEntries(cells.map(c => [`explore:${c}`, 1])) });
  noteProgress('t', seen(['a']), 0);
  expect(noteProgress('t', seen(['b']), 110000)).toBeNull();
  expect(noteProgress('t', seen(['a']), 220000)).toBeNull();
  expect(noteProgress('t', seen(['b']), 230000)?.kind).toBe('node_stalled');
});
it('recognizes progress during a long return and not a walk away from its destination', () => {
  const input = { hands: [{ do: 'walk' as const, path: [{ x: 100, y: 64, z: 0 }] }] };
  const seen = (x: number) => ({ ...snapshot(0), purpose: travelEvidence(input, frame({ dimension: 'overworld', position: { x, y: 64, z: 0 } })) });
  expect(travelEvidence({ hands: [{ do: 'walk', to: { x: 100, y: 64, z: 0 } }] },
    frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 } }))).toEqual(seen(0).purpose);
  noteProgress('t', seen(0), 0);
  expect(noteProgress('t', seen(20), 100000)).toBeNull();
  expect(noteProgress('t', seen(40), 200000)).toBeNull();
  expect(noteProgress('t', seen(20), 300000)).toBeNull();
  expect(noteProgress('t', seen(40), 320000)?.kind).toBe('node_stalled');
});
it('counts only target materials, bounds surplus, and treats raw iron as a usable intermediate', () => {
  const node = planFromSeeds([{ id: 'b', title: 'bucket', target: { item: 'bucket', count: 1 }, doneWhen: 'have:bucket' }])!.nodes[0];
  const value = purposeEvidence(node, frame({ inventory: [{ name: 'iron_ingot', count: 2 }, { name: 'raw_iron', count: 1 }, { name: 'cobblestone', count: 99 }] }));
  expect(value).toEqual({ 'have:bucket': 0, 'material:bucket:iron_ingot': 3 });
});
const day = [[{ k: 'time', t: 'day' }]];
it('recognizes actual night, not a reason string, missing time or a thunderstorm', () => {
  expect(observedWait(day, frame({ dimension: 'overworld', timeOfDay: 20000 }))?.remainingMs).toBe(188000);
  expect(observedWait('夜を待つ', frame({ timeOfDay: 20000 }))).toBeNull();
  expect(observedWait(day, frame({ dimension: 'overworld', timeOfDay: 20000, weather: 'thunder' }))).toBeNull();
});
it('does not extend the original deadline from repeated estimates or worker restart', () => {
  const ledger = createWaitLedger(null), wait = { key: 'time:day', remainingMs: 300000 };
  expect(ledger.until('food', wait, 1000)).toBe(301000);
  const restored = createWaitLedger(ledger.checkpoint().minecraftWaitDeadlines);
  expect(restored.until('food', wait, 290000)).toBe(301000);
  expect(restored.until('food', { ...wait, remainingMs: 900000 }, 400000)).toBe(301000);
});
it('permits a bounded legitimate wait but holds beyond its deadline', () => {
  const result = JSON.stringify({ v: 1, done: 1, of: 1, ms: 60000,
    lines: [{ i: 1, do: 'wait', status: 'done', goal: 'done', end: 'finished' }] });
  noteProgress('t', snapshot(0), 0);
  for (const activeMs of [60000, 120000, 180000, 240000]) {
    expect(noteRan('t', { hands: [{ do: 'wait' }], result, activeMs, waitUntil: 300000 })).toBeNull();
    expect(noteProgress('t', { ...snapshot(0), waitUntil: 300000 }, activeMs)).toBeNull();
  }
  expect(noteProgress('t', { ...snapshot(0), waitUntil: 300000 }, 300000)?.kind).toBe('node_stalled');
});
it('permits another night only after observing daylight, and identifies distinct furnace jobs', () => {
  const ledger = createWaitLedger(null), wait = { key: 'time:day', remainingMs: 300000 };
  expect(ledger.until('food', wait, 0)).toBe(300000);
  expect(ledger.observeDay(frame({ dimension: 'overworld', timeOfDay: 18000 }))).toBe(false);
  expect(ledger.until('food', wait, 900000)).toBe(300000);
  expect(ledger.observeDay(frame({ dimension: 'overworld', timeOfDay: 500 }))).toBe(true);
  expect(ledger.until('food', wait, 1000000)).toBe(1300000);
  const at = { x: 1, y: 64, z: 2 };
  const job = (id: string) => observedWait([[{ k: 'furnace', ...at }]], frame({ dimension: 'overworld',
    jobs: [{ id, position: at, status: 'waiting_external', remainingEstimateMs: 30000, input: 'raw_iron', count: 1 }] }));
  expect(job('one')).not.toBeNull();
  expect(job('one')?.key).not.toBe(job('two')?.key);
});
it('run 59 hold 1: a go cut by its time after 120 s of digging toward its goal counts where it ended, at the look that reads its result', () => {
  // The body dug from the village (158,57,54) toward iron at (128,38,86); the go stopped at (136,37,74) on its 120 s.
  const go = { hands: [{ do: 'go' as const, to: { x: 128, y: 38, z: 86 } }] };
  const at = (x: number, y: number, z: number) => frame({ dimension: 'overworld', position: { x, y, z } });
  const look = (running: typeof go | null, ended: typeof go | null, where: BodyObservation) =>
    ({ ...snapshot(0, 74), purpose: lookTravelEvidence(running, ended, where) });
  // The look while it ran (the next act's admission, 3 s in), then the look at its result: nothing runs any more.
  noteProgress('new', look(go, null, at(157, 56, 55)), 0);
  expect(noteProgress('new', look(null, go, at(136, 37, 74)), 121_000)).toBeNull();
  expect(noteProgress('new', look(null, null, at(136, 37, 74)), 125_000)).toBeNull();
  // Before: the result's look saw no running movement, so the approach was never counted and the node was held.
  noteProgress('old', look(go, null, at(157, 56, 55)), 0);
  expect(noteProgress('old', look(null, null, at(136, 37, 74)), 121_000)?.kind).toBe('node_stalled');
  // An ended move that did not come nearer is no progress; one never sampled before earns nothing either.
  noteProgress('stuck', look(go, null, at(157, 56, 55)), 0);
  expect(noteProgress('stuck', look(null, go, at(157, 56, 55)), 121_000)?.kind).toBe('node_stalled');
  noteProgress('unseen', look(null, null, at(157, 56, 55)), 0);
  expect(noteProgress('unseen', look(null, go, at(136, 37, 74)), 121_000)?.kind).toBe('node_stalled');
});
