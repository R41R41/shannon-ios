import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { toolFailure, toolOk } from '../src/mind/tools/toolRegistryPorts.js';
import { heldBeforeSend, heldOfFrame, heldTail, heldWhole, holdV2, sentPart, withHeldTail } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { preflightOfFrame, preflightText } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';

/**
 * 部分送り (SHANNON_MINECRAFT_LLMC_V2): the guards hold hand k; hands 1 … k−1 go to the body, the rest comes back as a fact after the body's own
 * result. k = 1 is turned back whole in the words of 4f98156. Made-up maps: rock around the feet (220,56,62), a corridor along +x two cells long.
 */
afterEach(() => { vi.restoreAllMocks(); });

function map(): string {
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
  return lines.join('\n');
}
const frame = (threats: unknown[] = []): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: '', receivedAt: '', connected: true,
  state: { world: { position: { x: 220.5, y: 56, z: 62.5 }, localMap: map(), nearbyThreats: threats } as never }, facts: {} as never });
const walk = (x: number) => ({ do: 'walk', to: { x, y: 56, z: 62 } });
const intoRock = { hands: [walk(221), walk(222), walk(224), { do: 'wait', seconds: 1 }], why: '[p1.2] 東へ', stopIf: { hpBelow: 12 }, accept: ['zombie'] };

describe('the hand held, the part sent', () => {
  it('holds the first hand the map faults, in the words of the act-preflight, and sends the hands before it with everything else of the act', () => {
    const held = heldOfFrame(intoRock, frame(), 'task-1')!;
    expect(held).toMatchObject({ hand: 3, kind: 'walk', code: 'feet_solid' });
    expect(held.line).toMatch(/^手 3 walk 一歩ではない: 足のマス \(224,56,62\) が 石の類（地図 #） で埋まっている（隣の立てるマスは地図に無い）（地図で確かめた）。/u);
    expect(sentPart(intoRock, held)).toEqual({ ...intoRock, hands: [walk(221), walk(222)] });
  });

  it('turns the whole act back when the first hand is the one held, in the very words of 4f98156', () => {
    const input = { hands: [walk(224), walk(222)] };
    const stop = preflightOfFrame(input, frame(), 'task-1', { bodyRules: true })!;
    expect(preflightText(preflightOfFrame(input, frame(), 'task-1')!)).toBe(preflightText(stop).replace('（隣の立てるマスは地図に無い）', ''));
    const hold = holdV2(input, frame(), 'task-1')!;
    expect(hold).toMatchObject({ whole: preflightText(stop) });
    expect(heldWhole(heldOfFrame(input, frame(), 'task-1')!)).toBe(preflightText(stop));
    expect(sentPart(input, heldOfFrame(input, frame(), 'task-1')!)).toBeNull();
  });

  it('holds nothing when the map faults nothing', () => {
    expect(heldOfFrame({ hands: [walk(221), walk(222)] }, frame(), 'task-1')).toBeNull();
    expect(holdV2({ hands: [walk(222)] }, frame(), 'task-1')).toBeNull();
    expect(heldOfFrame(intoRock, null, 'task-1')).toBeNull();
  });

  it('says what was not sent: from hand k on, how many of all, the fact, and that nothing of them moved', () => {
    const held = heldOfFrame(intoRock, frame(), 'task-1')!;
    const tail = heldTail(held, 4);
    expect(tail).toMatch(/^手 1〜2 は体へ送った（結果は上の行。動いた手は書き直さない）。手 3 から先 2 手（全 4 手のうち）は体へ送っていない（送る前に止めた。手は 1 つも動いていない）: 手 3 walk 一歩ではない/u);
    expect(heldTail(held, 4, { at: { x: 222, y: 56, z: 62 }, via: null })).toContain('送った手のあと、足は (222,56,62)（地図での見積もり。体の「今」の行が正）。手 3 から先');
    const hold = holdV2(intoRock, frame(), 'task-1');
    expect(hold && 'tail' in hold ? hold.tail : '').toContain('足は (222,56,62)');
  });

  it('prefers the earlier hand of two guards, and the act-preflight when both hold the same one', () => {
    const wither = { name: 'wither_skeleton', id: 7, distance: 6, position: { x: 224, y: 57, z: 60 }, canSee: true };
    expect(heldOfFrame(intoRock, frame([wither]), 'task-1')?.code).toBe('feet_solid');
  });
});

describe('the result: the body\'s own first, the tail after', () => {
  const tail = '手 3 から先 2 手（全 4 手のうち）は体へ送っていない（送る前に止めた。手は 1 つも動いていない）: 手 3 walk 一歩ではない: x。';
  it('a body that stopped on its own keeps its result and its failure; the tail is only added', () => {
    const stopped = { ...toolFailure('failed', 'act 1/2 済みで止まった（failure）', { retryable: true }), progressed: true as const };
    const result = withHeldTail(stopped, tail);
    expect(result.ok).toBe(false);
    expect(result.text).toBe(`act 1/2 済みで止まった（failure）\n${tail}`);
    expect(result).toMatchObject({ failure: 'failed', progressed: true });
  });

  it('a body that did every hand it was sent is not a success for the whole act: refused, retryable, and progressed', () => {
    const result = withHeldTail(toolOk('act 全部済み（2/2、1.0秒）'), tail) as ReturnType<typeof toolFailure> & { progressed?: boolean };
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failure: 'refused', retryable: true, progressed: true });
    expect(result.text).toBe(`act 全部済み（2/2、1.0秒）\n${tail}`);
  });

  it('a reflex cut stays a reflex cut', () => {
    const reflex = { ...toolFailure('failed', 'act 0/2 済みで止まった（reflex）', { retryable: true }), bodyReflex: true as const };
    expect(withHeldTail(reflex, tail)).toMatchObject({ bodyReflex: true, ok: false });
  });
});

describe('heldBeforeSend: what the tools do before they send', () => {
  it('the hands before the held one are sent, with a tail and a log line that says so', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
    const part = heldBeforeSend(false, intoRock, frame(), 'task-1')!;
    expect(part.result).toBeUndefined();
    expect(part.input).toEqual({ ...intoRock, hands: [walk(221), walk(222)] });
    expect(part.tail).toContain('手 3 から先 2 手');
    expect(lines).toEqual(['Shannon Minecraft act held partway task=task-1 hand=3 sent=2 code=feet_solid']);
  });

  it('with the first hand held the whole act is turned back', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const whole = heldBeforeSend(false, { hands: [walk(224)] }, frame(), 'task-1')!;
    expect(whole.result?.text.startsWith('送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: 手 1 walk 一歩ではない')).toBe(true);
    expect(whole.result).toMatchObject({ ok: false, failure: 'refused', retryable: true });
  });
});
