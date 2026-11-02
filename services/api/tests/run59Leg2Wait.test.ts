import { describe, expect, it } from 'vitest';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { sendItem } from '../src/wiring/fcaMinecraftActItem.js';
import { lookTravelEvidence, travelEvidence } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { forgetStalls, noteProgress } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

/** Run 59 leg 2, hold 1: the stairs down to the iron (y=41 to 16) were no progress, and a wait queued behind them idled 30 s. */
const signal = new AbortController().signal;
const send = (input: ActInput, after: string | null) => {
  const queue = { open: () => after !== null, async add() { return { ok: true as const, item: after ? 'q2' : 'q1', after, startInMs: 1000 }; } };
  return sendItem({ queue: queue as never, control: { observe: () => null } as never, bodyId: 'b',
    call: { scopeKey: 's', taskId: 't', operationId: 'op', name: 'mc.act', input, signal } as never, skill: 'act', fixes: [], node: null, frame: null });
};

describe('a wait queued behind a running act is told what it does to the next decision', () => {
  it('a wait-only act after another item: it runs after it and holds the next decision back by its seconds', async () => {
    const sent = await send({ hands: [{ do: 'wait', seconds: 30 }], why: '下り完了待ち' }, 'q1');
    expect(sent.ok).toBe(true);
    expect(sent.text).toContain('列に入れた q2（q1 の後');
    expect(sent.text).toContain('wait は q1 が終わってから動く（並行には待たない）');
    expect(sent.text).toContain('その秒数だけ次の判断を遅らせる');
  });
  it('says nothing for a wait into an empty queue, for an act with other hands, or for a wait with its own condition (a furnace, the day)', async () => {
    expect((await send({ hands: [{ do: 'wait', seconds: 30 }], why: 'w' }, null)).text).not.toContain('並行には待たない');
    expect((await send({ hands: [{ do: 'wait', seconds: 5 }, { do: 'pickup', range: 4 } as never], why: 'w' }, 'q1')).text).not.toContain('並行には待たない');
    expect((await send({ hands: [{ do: 'wait', seconds: 30 }], why: 'w', done: [[{ k: 'time', t: 'day' }]] } as never, 'q1')).text).not.toContain('並行には待たない');
  });
});

describe('a vertical approaches its height', () => {
  const frame = (y: number) => ({ connected: true, state: { world: { dimension: 'overworld', position: { x: 167, y, z: 60 } } }, facts: {} }) as unknown as BodyObservation;
  const stairs = { hands: [{ do: 'vertical', dir: 'down', shape: 'stairs', toward: 'south', toY: 16 } as never] } as ActInput;
  it('is a travel goal of its height, nearer as the feet come down', () => {
    expect(travelEvidence(stairs, frame(41))).toEqual({ 'travel:overworld:y16': -13 });
    expect(travelEvidence(stairs, frame(16))).toEqual({ 'travel:overworld:y16': -0 });
  });
  it('the stairs that arrived are progress at the look that reads their result (before: held 54 s later as stalled)', () => {
    forgetStalls();
    const look = (running: ActInput | null, ended: ActInput | null, y: number) => ({ node: 'p3.3', state: 'continue', milestone: 'nether', items: 600,
      inventory: {}, purpose: lookTravelEvidence(running, ended, frame(y)) });
    noteProgress('new', look(stairs, null, 41), 0);
    expect(noteProgress('new', look(null, stairs, 16), 66_000)).toBeNull();
    expect(noteProgress('new', look(null, null, 16), 66_000 + 119_000)).toBeNull();
    forgetStalls();
  });
});
