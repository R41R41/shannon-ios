import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { EyeLedger } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { eyeThrowHold, registerEyeLedger } from '../src/surfaces/minecraft/minecraftEyeThrowHold.js';
import { bearingBetween, stronghold, type EyeThrow } from '../src/surfaces/minecraft/minecraftEyeTriangulation.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/** The eyes kept for the frames (S5's rig of 11/5: 27 throws after the point, none left for the frames). */
const frame = (items: Array<[string, number]>, at = { x: 0, y: 70, z: 0 }, more: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1,
  bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: at, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })), ...more } as never } });
const ledger = (fix: { x: number; z: number; errorBlocks: number } | null, throws: Array<{ x: number; z: number; bearingDeg: number }> = []) =>
  ({ fix: () => fix ? { ...fix, throws: 2, ahead: [] } : null, throws: () => throws }) as unknown as EyeLedger;
const throwEye = { hands: [{ do: 'use', item: 'ender_eye' }] };
const KIT: Array<[string, number]> = [['ender_eye', 14]];

describe('the eyes kept for the frames', () => {
  it('holds a throw once the point is within 128 m of error, and says to walk there and look for the frames', () => {
    registerEyeLedger('a', ledger({ x: -1072, z: 928, errorBlocks: 90 }));
    const held = eyeThrowHold(throwEye, frame(KIT), 'a')!;
    expect(held).toMatchObject({ hand: 1, kind: 'use' });
    expect(held.line).toContain('要塞の交点 (-1072,928)（誤差 90m）がある');
    expect(held.line).toContain('mc_probe kind=frames radius=128');
    registerEyeLedger('a2', ledger({ x: -1072, z: 928, errorBlocks: 300 }));
    expect(eyeThrowHold(throwEye, frame(KIT), 'a2')).toBeNull();
  });
  it('lets one throw go from within 128 m of the point (the frames are not seen there), and holds the next once the ledger has one thrown there', () => {
    const far = [{ x: 135, z: 104, bearingDeg: 304 }, { x: 121, z: 84, bearingDeg: 305 }], at = { x: -1000, y: 70, z: 900 };
    registerEyeLedger('n', ledger({ x: -1072, z: 928, errorBlocks: 90 }, far));
    expect(eyeThrowHold(throwEye, frame(KIT), 'n')!.line).toContain('交点の 128m 内まで来ても枠が見えない時だけ、そこで 1 回投げ直せる');
    expect(eyeThrowHold(throwEye, frame(KIT, at), 'n')).toBeNull();
    // The frames' eyes are still kept while more can be made.
    expect(eyeThrowHold(throwEye, frame([['ender_eye', 12], ['ender_pearl', 2], ['blaze_powder', 2]], at), 'n')!.line).toContain('枠に要る数（13）以下');
    registerEyeLedger('n2', ledger({ x: -1072, z: 928, errorBlocks: 90 }, [...far, { x: -1000, z: 900, bearingDeg: 291 }]));
    const again = eyeThrowHold(throwEye, frame(KIT, { x: -1030, y: 70, z: 910 }), 'n2')!.line;
    expect(again).toContain('もう投げない');
    expect(again).not.toContain('投げ直せる');
  });
  it('holds a throw on the same line as the last one, and lets one 24 m sideways go', () => {
    registerEyeLedger('b', ledger(null, [{ x: 0, z: 0, bearingDeg: 180 }]));
    expect(eyeThrowHold(throwEye, frame(KIT, { x: 1, y: 70, z: 40 }), 'b')!.line).toContain('同じ線になり、交点は出ない');
    expect(eyeThrowHold(throwEye, frame(KIT, { x: 24, y: 70, z: 0 }), 'b')).toBeNull();
  });
  it('holds a throw that would eat into the frames\' eyes while more can be made, and lets it go when none can', () => {
    registerEyeLedger('c', ledger(null));
    expect(eyeThrowHold(throwEye, frame([['ender_eye', 12], ['ender_pearl', 2], ['blaze_powder', 2]]), 'c')!.line).toContain('枠に要る数（13）以下');
    expect(eyeThrowHold(throwEye, frame([['ender_eye', 12]]), 'c')).toBeNull();
    // A placed eye (`at`) into a frame is no throw.
    expect(eyeThrowHold({ hands: [{ do: 'use', item: 'ender_eye', at: [{ x: 1, y: 30, z: 1 }] }] }, frame(KIT), 'a')).toBeNull();
  });
  it('says in the stronghold stage not to throw once the point is out', () => {
    expect(V2_STAGES.stronghold).toContain('交点が出たら、もう投げない');
    expect(V2_STAGES.stronghold).toContain('交点の 128m 内まで来ても枠が見えない時の 1 回');
    expect(V2_STAGES.stronghold).toContain('交点（24m 内）に着いても枠が見えない時も、そこから投げていなければ 1 回');
  });
});

/**
 * The hold is never for good (the review of 11/14): it held every throw once one was thrown in the point's circle, and the ledger keeps a throw 4 hours,
 * so a point the probe missed left no throw at all. A good player throws again from the point itself, or from a new side to close the crossing.
 */
describe('one more throw from the point itself or from a new place', () => {
  const far = [{ x: 135, z: 104, bearingDeg: 304 }, { x: 121, z: 84, bearingDeg: 305 }];
  const NONE: Array<[string, number]> = [['ender_eye', 9]];
  it('lets one go from the point (24 m) with the frames not seen and none thrown there, and holds the next from there', () => {
    registerEyeLedger('p1', ledger({ x: -1072, z: 928, errorBlocks: 90 }, [...far, { x: -1000, z: 900, bearingDeg: 291 }]));
    expect(eyeThrowHold(throwEye, frame(KIT, { x: -1065, y: 70, z: 925 }), 'p1')).toBeNull();
    expect(eyeThrowHold(throwEye, frame(NONE, { x: -1065, y: 70, z: 925 }), 'p1')).toBeNull();
    // The frames seen: walk to them, no throw.
    const seen = { mapLandmarks: ['Q エンドポータルの枠 (-1080,30,940) 南10m・下40 ×12 アイ入り 0'] };
    expect(eyeThrowHold(throwEye, frame(KIT, { x: -1065, y: 70, z: 925 }, seen), 'p1')!.line).toContain('もう投げない');
    registerEyeLedger('p2', ledger({ x: -1072, z: 928, errorBlocks: 90 }, [...far, { x: -1000, z: 900, bearingDeg: 291 }, { x: -1068, z: 930, bearingDeg: 200 }]));
    const held = eyeThrowHold(throwEye, frame(KIT, { x: -1065, y: 70, z: 925 }), 'p2')!.line;
    expect(held).toContain('もう投げない');
    expect(held).not.toContain('24m 内）に着いても');
  });
  it('with nothing to make eyes from and a point wider than 128 m, holds a throw inside its circle but lets one go from the point or from a new place outside it', () => {
    // The point 200 m wide; one throw 150 m before it, on the way in.
    const fix = { x: -1072, z: 928, errorBlocks: 200 }, near = { x: -950, z: 840, bearingDeg: 306 };
    registerEyeLedger('w', ledger(fix, [...far, near]));
    const inside = eyeThrowHold(throwEye, frame(NONE, { x: -1000, y: 70, z: 880 }), 'w')!.line;
    expect(inside).toContain('同じ辺りから投げ直さない');
    expect(inside).toContain('交点（24m 内）、誤差 200m の円の外（交点から 400m 内）で前に投げた所から 64m 以上離れた所から 1 回投げられる');
    expect(eyeThrowHold(throwEye, frame(NONE, { x: -1080, y: 70, z: 935 }), 'w')).toBeNull();
    // Outside the circle: a new place goes, one near the last throw does not.
    expect(eyeThrowHold(throwEye, frame(NONE, { x: -1072, y: 70, z: 1180 }), 'w')).toBeNull();
    expect(eyeThrowHold(throwEye, frame(NONE, { x: -910, y: 70, z: 810 }), 'w')!.line).toContain('同じ辺りから投げ直さない');
    // Far back on the way (beyond twice the radius) a throw adds little: held.
    expect(eyeThrowHold(throwEye, frame(NONE, { x: -700, y: 70, z: 600 }), 'w')!.line).toContain('同じ辺りから投げ直さない');
    // With materials and eyes over the frames' need, a wide point holds nothing (the ledger says where to throw from).
    expect(eyeThrowHold(throwEye, frame([['ender_eye', 14], ['ender_pearl', 2], ['blaze_powder', 2]], { x: -1000, y: 70, z: 880 }), 'w')).toBeNull();
  });
  it('a point drawn by lines that disagree stays over 128 m whatever is thrown from it, and the hold still lets one go from a new place', () => {
    // Two exact lines 60 m apart, each 0.3 degrees off: the point is far from the stronghold and its error stays at about 154 m after a throw from it.
    const truth = { x: -1100, z: 950 };
    const eye = (x: number, z: number, off: number): EyeThrow => {
      const bearingDeg = bearingBetween({ x, z }, truth) + off, r = bearingDeg * Math.PI / 180;
      return { x, z, bearingDeg, flew: 12, broke: false, unit: { x: Math.sin(r), z: -Math.cos(r) } };
    };
    const throws = [eye(0, 0, 0.3), eye(60, 0, -0.3)];
    const first = stronghold(throws)!;
    expect(first.errorBlocks).toBeGreaterThan(128);
    throws.push(eye(first.x, first.z, 0));
    const after = stronghold(throws)!;
    expect(after.errorBlocks).toBeGreaterThan(128);
    const real = { fix: () => stronghold(throws), throws: () => throws } as unknown as EyeLedger;
    registerEyeLedger('d', real);
    // At the point she has thrown already: held there; from a new place outside the circle one goes.
    expect(eyeThrowHold(throwEye, frame(NONE, { x: after.x + 10, y: 70, z: after.z }), 'd')!.line).toContain('同じ辺りから投げ直さない');
    expect(eyeThrowHold(throwEye, frame(NONE, { x: after.x + after.errorBlocks + 20, y: 70, z: after.z }), 'd')).toBeNull();
  });
  it('a narrow point the throw from it leaves where it was: one throw from a new place 128-256 m out, then held again', () => {
    // Two exact lines 200 m apart, each 0.3 degrees off: a point 25 m wide, 253 m from the stronghold. The throw from it does not move it, and every
    // place was held after it (rule (a) outside 128 m, the point's throw inside).
    const truth = { x: -1100, z: 950 };
    const eye = (x: number, z: number, off: number): EyeThrow => {
      const bearingDeg = bearingBetween({ x, z }, truth) + off, r = bearingDeg * Math.PI / 180;
      return { x, z, bearingDeg, flew: 12, broke: false, unit: { x: Math.sin(r), z: -Math.cos(r) } };
    };
    const throws = [eye(0, 0, 0.3), eye(200, 0, -0.3)];
    const first = stronghold(throws)!;
    expect(first.errorBlocks).toBeLessThanOrEqual(128);
    expect(Math.hypot(first.x - truth.x, first.z - truth.z)).toBeGreaterThan(200);
    throws.push(eye(first.x, first.z, 0));
    const after = stronghold(throws)!;
    expect(Math.hypot(after.x - first.x, after.z - first.z)).toBeLessThan(5);
    registerEyeLedger('nw', { fix: () => stronghold(throws), throws: () => throws } as unknown as EyeLedger);
    const there = eyeThrowHold(throwEye, frame(NONE, { x: after.x + 10, y: 70, z: after.z }), 'nw')!.line;
    expect(there).toContain('もう投げない');
    expect(there).toContain('交点で投げても枠が見えない時は、交点から 128〜256m の、前に投げた所から 64m 以上離れた所から 1 回投げられる');
    expect(eyeThrowHold(throwEye, frame(NONE, { x: after.x + 60, y: 70, z: after.z }), 'nw')).not.toBeNull();
    const ring = { x: after.x - 160, z: after.z };
    expect(eyeThrowHold(throwEye, frame(NONE, { ...ring, y: 70 }), 'nw')).toBeNull();
    // The line from the new side closes the crossing on the stronghold; one more from that side is held.
    throws.push(eye(ring.x, ring.z, 0));
    const closed = stronghold(throws)!;
    expect(Math.hypot(closed.x - truth.x, closed.z - truth.z)).toBeLessThan(30);
    const next = eyeThrowHold(throwEye, frame(NONE, { x: closed.x + 200, y: 70, z: closed.z }), 'nw')!.line;
    expect(next).toContain('もう投げない');
    expect(next).not.toContain('128〜256m');
  });
});
