import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { EyeLedger } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { eyeThrowHold, registerEyeLedger } from '../src/surfaces/minecraft/minecraftEyeThrowHold.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/** The eyes kept for the frames (S5's rig of 11/5: 27 throws after the point, none left for the frames). */
const frame = (items: Array<[string, number]>, at = { x: 0, y: 70, z: 0 }): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: at, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })) } as never } });
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
    expect(eyeThrowHold(throwEye, frame([['ender_eye', 12], ['ender_pearl', 2], ['blaze_powder', 2]], at), 'n')!.line).toContain('枠に要る数（12）以下');
    registerEyeLedger('n2', ledger({ x: -1072, z: 928, errorBlocks: 90 }, [...far, { x: -1000, z: 900, bearingDeg: 291 }]));
    const again = eyeThrowHold(throwEye, frame(KIT, { x: -1060, y: 70, z: 920 }), 'n2')!.line;
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
    expect(eyeThrowHold(throwEye, frame([['ender_eye', 12], ['ender_pearl', 2], ['blaze_powder', 2]]), 'c')!.line).toContain('枠に要る数（12）以下');
    expect(eyeThrowHold(throwEye, frame([['ender_eye', 12]]), 'c')).toBeNull();
    // A placed eye (`at`) into a frame is no throw.
    expect(eyeThrowHold({ hands: [{ do: 'use', item: 'ender_eye', at: [{ x: 1, y: 30, z: 1 }] }] }, frame(KIT), 'a')).toBeNull();
  });
  it('says in the stronghold stage not to throw once the point is out', () => {
    expect(V2_STAGES.stronghold).toContain('交点が出たら、もう投げない');
    expect(V2_STAGES.stronghold).toContain('交点の 128m 内まで来ても枠が見えない時の 1 回だけ');
  });
});
