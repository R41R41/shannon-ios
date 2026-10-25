import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { forgetLlmcEvents, urgentDecision, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { isUrgentLive, seenReopenStop, seenStops, urgentLimitStop } from '../src/surfaces/minecraft/minecraftLlmcHandGuards.js';
import { heldBeforeSend } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { candidateAct } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { URGENT_ANSWER } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, two more guards before an act is sent (the decision replay's A: the live state had the fact and the answer went
 * against it): an urgent decision's act is held to three hands (s12, s34), and a dig of a cell that stopped for 「見られる」 a moment ago goes
 * only with exposeOk (s30, s02). Both send the hands before the held one and say the rest, as the part sent does.
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const walk = (x: number) => ({ do: 'walk', to: { x, y: 56, z: 62 } });
const dig = (x: number, extra: object = {}) => ({ do: 'dig', at: [{ x, y: 61, z: 73 }], ...extra });

describe('the urgent limit', () => {
  it('holds the fourth hand of an urgent decision\'s act and says so; three hands or fewer, or not urgent, are let go', () => {
    const five = { hands: [walk(1), walk(2), walk(3), dig(4), walk(5)] };
    const stop = urgentLimitStop(five, true)!;
    expect(stop).toMatchObject({ hand: 4, kind: 'dig', code: 'urgent_limit' });
    expect(stop.line).toContain('急ぎの判断は 3 手まで');
    expect(urgentLimitStop(five, false)).toBeNull();
    expect(urgentLimitStop({ hands: [walk(1), walk(2), walk(3)] }, true)).toBeNull();
    expect(urgentLimitStop(null, true)).toBeNull();
  });
  it('knows an urgent decision by the answer line of its live state', () => {
    expect(isUrgentLive({ body: { answer: URGENT_ANSWER } })).toBe(true);
    expect(isUrgentLive({ body: { map: 'x' } })).toBe(false);
    expect(isUrgentLive({})).toBe(false);
  });
  it('is the three hands sent and the tail of the rest through the part-send, and nothing when the decision is not urgent', () => {
    const five = { hands: [walk(1), walk(2), walk(3), dig(4), walk(5)], why: '[急ぎ] 離れる' };
    const sent = heldBeforeSend(true, five, null, 't')!;
    expect((sent.input as { hands: unknown[]; why: string }).hands).toHaveLength(3);
    expect(sent.tail).toContain('手 4 から先 2 手（全 5 手のうち）は体へ送っていない');
    expect(heldBeforeSend(false, five, null, 't')).toBeNull();
  });
  it('through the replay\'s entry: the lines of the model are made into hands and held at the fourth', () => {
    const act = candidateAct({ hands: ['wait 1', 'wait 1', 'wait 1', 'wait 1', 'wait 1'], why: '[急ぎ] x' }, null, 'replay', { urgent: true });
    expect(act.guard).toMatchObject({ stopped: false, sentHands: 3, hand: 4 });
    expect(act.guard!.text).toContain('急ぎの判断は 3 手まで');
    expect(candidateAct({ hands: ['wait 1', 'wait 1', 'wait 1', 'wait 1', 'wait 1'] }, null).guard).toBeUndefined();
  });
});

describe('a dig of a cell that stopped for 「見られる」 a moment ago', () => {
  const stops = ['(308,66,73) 見られる ×2 12秒前', '(300,60,73)→(299,61,73) 一歩ではない 5秒前', '(250,60,73) 見られる 200秒前'];
  const world = { recentStops: stops, nearbyThreats: [{ name: 'blaze', id: 7, distance: 6, canSee: true }, { name: 'zombie', id: 8, distance: 3, canSee: false }] };
  const at = (x: number, y: number, z: number) => ({ do: 'dig', at: [{ x, y, z }] });
  it('reads the stops of the body: the cells of 「見られる」 within 90 seconds', () => {
    expect([...seenStops(stops)]).toEqual([['308,66,73', 12]]);
    expect(seenStops(undefined).size).toBe(0);
  });
  it('holds the dig without exposeOk, naming the hostile that sees her, and the hand number', () => {
    const stop = seenReopenStop({ hands: [walk(1), at(308, 66, 73)] }, frame(world))!;
    expect(stop).toMatchObject({ hand: 2, kind: 'dig', code: 'reopen_seen' });
    expect(stop.line).toContain('(308,66,73) は直前に「見られる」で止まった（12秒前。今も見える敵: blaze #7 6.0m）');
    expect(stop.line).toContain('開けるなら exposeOk');
  });
  it('lets go: exposeOk, another cell, an old stop, a relative hand, a hand that is not a dig, no stops', () => {
    expect(seenReopenStop({ hands: [{ ...at(308, 66, 73), exposeOk: true }] }, frame(world))).toBeNull();
    expect(seenReopenStop({ hands: [at(309, 66, 73)] }, frame(world))).toBeNull();
    expect(seenReopenStop({ hands: [at(250, 60, 73)] }, frame(world))).toBeNull();
    expect(seenReopenStop({ hands: [{ ...at(308, 66, 73), rel: true }] }, frame(world))).toBeNull();
    expect(seenReopenStop({ hands: [{ do: 'place', block: 'stone', at: [{ x: 308, y: 66, z: 73 }] }] }, frame(world))).toBeNull();
    expect(seenReopenStop({ hands: [at(308, 66, 73)] }, frame({}))).toBeNull();
    expect(seenReopenStop({ hands: [at(308, 66, 73)] }, null)).toBeNull();
  });
  it('through the replay\'s entry: turned back whole at the first hand, and let through with exposeOk', () => {
    const f = frame(world);
    const whole = candidateAct({ hands: ['dig 308,66,73'] }, f);
    expect(whole.guard).toMatchObject({ stopped: true, hand: 1 });
    expect(whole.guard!.text).toContain('「見られる」で止まった');
    expect(candidateAct({ hands: ['dig 308,66,73 exposeOk'] }, f).guard).toBeUndefined();
    expect(candidateAct({ hands: ['wait 1', 'dig 308,66,73'] }, f).guard).toMatchObject({ stopped: false, sentHands: 1 });
  });
});

describe('the urgent decision of a task, as the tools ask it', () => {
  const PIGLIN = { id: 848, name: 'piglin', kind: 'hostile', distance: 5, position: { x: 219.5, y: 58, z: 62.5 }, canSee: true, canReachMe: true };
  const base = () => ({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; }, tools: undefined }) as never;
  it('is true when the live state of the decision is the urgent one, false when the next is not', () => {
    forgetLlmcEvents();
    let seen = frame({ position: { x: 226.5, y: 57, z: 63.5 }, health: 16, nearbyThreats: [PIGLIN] });
    const mode = withLlmcBody(base(), { llmc: { plan: () => undefined, planView: () => null }, taskId: 'v2-task', createdAt: '2026-10-23T00:00:00.000Z',
      observe: () => seen, arrival: () => ({ at: null, kind: null }), log() {}, r4: { probe: () => null, planWhere: () => null } });
    mode.context();
    mode.urgent?.();
    mode.transient?.();
    expect(urgentDecision('v2-task')).toBe(true);
    seen = frame({ position: { x: 226.5, y: 57, z: 63.5 }, health: 20, nearbyThreats: [] });
    mode.context();
    mode.urgent?.();
    mode.transient?.();
    expect(urgentDecision('v2-task')).toBe(false);
    forgetLlmcEvents();
  });
});
