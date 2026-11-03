import { afterEach, describe, expect, it } from 'vitest';
import { forgetStalls, noteProgress, noteRan } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { progressEvents } from '../src/surfaces/minecraft/minecraftProgressEvents.js';
import type { ActHandLine } from '../src/contracts/minecraftActContract.js';

afterEach(forgetStalls);
const TASK = 'task-events';
const line = (over: Record<string, unknown>): ActHandLine => ({ i: 1, do: 'fight', status: 'done', goal: 'done', end: 'finished', line: '', ...over }) as ActHandLine;
const result = (lines: ActHandLine[]) => JSON.stringify({ v: 1, ok: true, done: lines.length, of: lines.length, ms: 9000, at: { x: 1, y: 64, z: 1 }, hp: 20, food: 20, lines });
const snapshot = { node: 'p9', state: 'doing', milestone: 'ブレイズロッド', items: 4, inventory: {}, purpose: {} };

describe('the work the stall look counts as progress although the pack does not show it', () => {
  it('names a blaze or enderman kill, the gate frame, its ignition and an eye put in the frame', () => {
    expect(progressEvents([{ do: 'fight', target: 'blaze' }], [line({ code: 'target_killed' })])).toEqual(['kill']);
    expect(progressEvents([{ do: 'fight', target: '#41' }], [line({ code: 'target_killed' })])).toEqual(['kill']);
    expect(progressEvents([{ do: 'attack', target: 'enderman' }], [line({ do: 'attack' })])).toEqual(['kill']);
    expect(progressEvents([{ do: 'obsidian' }], [line({ do: 'obsidian' })])).toEqual(['frame']);
    expect(progressEvents([{ do: 'portal' }], [line({ do: 'portal' })])).toEqual(['ignition']);
    expect(progressEvents([{ do: 'use', item: 'ender_eye', at: { x: 1, y: 2, z: 3 } }], [line({ do: 'use' })])).toEqual(['eye']);
  });
  it('names nothing for a hand that did not end done, did not run, threw an eye, or fought something else', () => {
    expect(progressEvents([{ do: 'fight', target: 'blaze' }], [line({ goal: 'partial', end: 'cut', code: 'target_escaped' })])).toEqual([]);
    expect(progressEvents([{ do: 'portal' }], [line({ do: 'portal', end: 'not_run' })])).toEqual([]);
    expect(progressEvents([{ do: 'use', item: 'ender_eye' }], [line({ do: 'use' })])).toEqual([]);
    expect(progressEvents([{ do: 'fight', target: 'zombie' }], [line({ code: 'target_killed' })])).toEqual([]);
  });
  it('starts the node window again, so a node that only killed blazes is not called stalled', () => {
    noteProgress(TASK, snapshot, 0);
    expect(noteRan(TASK, { hands: [{ do: 'fight', target: 'blaze' }], result: result([line({ code: 'target_killed' })]), activeMs: 100_000 })).toBeNull();
    expect(noteProgress(TASK, snapshot, 100_000 + 119_000)).toBeNull();
    expect(noteProgress(TASK, snapshot, 100_000 + 120_000)).toMatchObject({ kind: 'node_stalled' });
  });
  it('without such a kill the same node is stalled at 120 seconds', () => {
    noteProgress(TASK, snapshot, 0);
    expect(noteRan(TASK, { hands: [{ do: 'fight', target: 'blaze' }], result: result([line({ goal: 'partial', end: 'cut', code: 'target_escaped' })]), activeMs: 100_000 })).toBeNull();
    expect(noteProgress(TASK, snapshot, 120_000)).toMatchObject({ kind: 'node_stalled' });
  });
  it('a wait that follows work is not counted among the waits of a run', () => {
    const waitHand = [{ do: 'wait' }];
    const waited = line({ do: 'wait' });
    expect(noteRan(TASK, { hands: waitHand, result: result([waited]) })).toBeNull();
    expect(noteRan(TASK, { hands: waitHand, result: result([waited]) })).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'use', item: 'ender_eye', at: { x: 1, y: 2, z: 3 } }], result: result([line({ do: 'use' })]) })).toBeNull();
    expect(noteRan(TASK, { hands: waitHand, result: result([waited]) })).toBeNull();
  });
});
