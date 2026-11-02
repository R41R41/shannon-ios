import { describe, expect, it } from 'vitest';
import {
  bearingBetween,
  bearingVector,
  compassWord,
  MAX_ERROR_BLOCKS,
  nearThrowPlace,
  nextThrowPlaces,
  stronghold,
  type EyeThrow,
} from '../src/surfaces/minecraft/minecraftEyeTriangulation.js';

const throwFrom = (x: number, z: number, target: { x: number; z: number }, extra: Partial<EyeThrow> = {}): EyeThrow => ({
  x,
  z,
  bearingDeg: bearingBetween({ x, z }, target),
  flew: 12,
  broke: false,
  ...extra,
});
const near = (value: number, wanted: number, within: number) => expect(Math.abs(value - wanted)).toBeLessThanOrEqual(within);

describe('stronghold from thrown eyes', () => {
  it('reads a bearing as 0 north (-z) and 90 east (+x)', () => {
    const north = bearingVector(0);
    const east = bearingVector(90);
    const south = bearingVector(180);
    expect([north.dx, north.dz].map(Math.round)).toEqual([0, -1]);
    expect([east.dx, east.dz].map(Math.round)).toEqual([1, -0]);
    expect([south.dx, south.dz].map(Math.round)).toEqual([0, 1]);
    expect(bearingBetween({ x: 0, z: 0 }, { x: 100, z: -100 })).toBe(45);
    expect(bearingBetween({ x: 0, z: 0 }, { x: -50, z: 0 })).toBe(270);
    expect(compassWord(45)).toBe('北東');
    expect(compassWord(350)).toBe('北');
  });

  it('finds the point two forward lines meet at, with an error that covers the truth', () => {
    const truth = { x: 1000, z: -2000 };
    const fix = stronghold([throwFrom(0, 0, truth), throwFrom(800, 0, truth)]);
    expect(fix).not.toBeNull();
    near(fix!.x, truth.x, fix!.errorBlocks);
    near(fix!.z, truth.z, fix!.errorBlocks);
    expect(fix!.throws).toBe(2);
    expect(fix!.errorBlocks).toBeLessThanOrEqual(MAX_ERROR_BLOCKS);
    expect(fix!.ahead[0]).toBeGreaterThan(2000);
  });

  it('gives no point when the lines meet behind a throw, are parallel, or cross at too narrow an angle', () => {
    // rays that diverge: the meeting point is behind both throws
    expect(stronghold([{ x: 0, z: 0, bearingDeg: 90, flew: 12, broke: false }, { x: 100, z: 0, bearingDeg: 270 - 20, flew: 12, broke: false }])).toBeNull();
    expect(stronghold([{ x: 0, z: 0, bearingDeg: 45, flew: 12, broke: false }, { x: 300, z: 0, bearingDeg: 45, flew: 12, broke: false }])).toBeNull();
    const far = { x: 3000, z: -3000 };
    expect(stronghold([throwFrom(0, 0, far), throwFrom(60, 0, far)])).toBeNull();
  });

  it('gives no point when the error is too big to walk to', () => {
    const far = { x: 2800, z: -2800 };
    const short = { flew: 2 };
    expect(stronghold([throwFrom(0, 0, far, short), throwFrom(300, 0, far, short)])).toBeNull();
  });

  it('uses the throws that agree and sets aside one that points elsewhere; a third throw narrows the error', () => {
    const truth = { x: -800, z: 1500 };
    const other = { x: 2500, z: 2500 };
    const two = stronghold([throwFrom(0, 0, truth), throwFrom(-600, 200, truth)]);
    const three = stronghold([throwFrom(0, 0, truth), throwFrom(-600, 200, truth), throwFrom(300, 500, truth)]);
    const odd = stronghold([throwFrom(0, 0, truth), throwFrom(-600, 200, truth), throwFrom(-150, 400, other)]);
    expect(two && three && odd).toBeTruthy();
    expect(three!.throws).toBe(3);
    expect(three!.errorBlocks).toBeLessThanOrEqual(two!.errorBlocks);
    expect(odd!.throws).toBe(2);
    near(odd!.x, truth.x, odd!.errorBlocks);
    near(odd!.z, truth.z, odd!.errorBlocks);
  });

  it('ignores a throw that cannot be read', () => {
    const truth = { x: 600, z: 900 };
    expect(stronghold([{ x: Number.NaN, z: 0, bearingDeg: 10, flew: 12, broke: true }, throwFrom(0, 0, truth)])).toBeNull();
    expect(stronghold([])).toBeNull();
  });

  it('suggests places to throw from next, sideways of the last line and farther after a pair gave nothing', () => {
    const first = nextThrowPlaces({ x: 10, z: 20, bearingDeg: 0, flew: 12, broke: false }, 0);
    expect(first.map(place => [place.x, place.z, place.from])).toEqual([[110, 20, 100], [-90, 20, 100]]);
    const wider = nextThrowPlaces({ x: 10, z: 20, bearingDeg: 0, flew: 12, broke: false }, 1);
    expect(wider.map(place => place.from)).toEqual([200, 200]);
    expect(nextThrowPlaces({ x: 0, z: 0, bearingDeg: Number.NaN, flew: 12, broke: false }, 0)).toEqual([]);
  });

  it('suggests a place on the line toward the point, short of it', () => {
    const fix = { x: 0, z: -1000, errorBlocks: 80, throws: 2, ahead: [1000, 1000] };
    expect(nearThrowPlace({ x: 0, z: 0 }, fix, 120)).toEqual({ x: 0, z: -880, from: 880 });
    expect(nearThrowPlace({ x: 0, z: -950 }, fix, 120)).toBeNull();
  });
});
