import { describe, expect, it } from 'vitest';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { tapEyes } from '../src/surfaces/minecraft/minecraftEyeTap.js';
import type { SettledEvent } from '../src/surfaces/minecraft/minecraftControlState.js';

/** The eyes' record on the receipts: a flight the body saw is noted though the queue did not count the item as run. */
const receipt = (id: string, extra: Record<string, unknown> = {}) => ({ id, connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: 't',
  result: JSON.stringify({ v: 1, done: 0, of: 1, lines: [{ i: 1, do: 'use', status: 'stopped' }], stoppedBy: 'reflex',
    eye: { from: { x: 0, z: 0 }, to: { x: 12, z: 0 }, bearingDeg: 90, flew: 12, broke: false, ...extra } }) });
const settled = (taskId: string, id: string): SettledEvent => ({ id, command: { context: { taskId } } as never, receipt: receipt(id) as never, from: null, to: 'settled_known' });

describe('tapEyes', () => {
  it('notes a flight from a settled receipt of its task, once, and leaves another task\'s alone', () => {
    const control = { settledListeners: new Set<(event: SettledEvent) => void>() };
    const endgame = createEndgame(null);
    tapEyes(control, 't1', (id, result) => endgame.noteResult(id, result, null));
    for (const listener of control.settledListeners) { listener(settled('t1', 'a')); listener(settled('t1', 'a')); listener(settled('t2', 'b')); }
    expect(endgame.checkpoint().minecraftEyes.throws).toHaveLength(1);
  });
  it('is replaced by the next step of the task (one listener a task)', () => {
    const control = { settledListeners: new Set<(event: SettledEvent) => void>() };
    tapEyes(control, 't3', () => undefined);
    tapEyes(control, 't3', () => undefined);
    expect(control.settledListeners.size).toBe(1);
  });
});
