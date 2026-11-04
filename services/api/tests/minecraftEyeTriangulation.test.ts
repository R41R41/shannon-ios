import { describe, expect, it } from 'vitest';
import {
  bearingBetween,
  bearingVector,
  compassWord,
  directPoint,
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
/** A throw whose flight the body read exactly (the unit vector of the eye's own positions). */
const exactFrom = (x: number, z: number, target: { x: number; z: number }, extra: Partial<EyeThrow> = {}): EyeThrow => {
  const length = Math.hypot(target.x - x, target.z - z);
  return { ...throwFrom(x, z, target), unit: { x: (target.x - x) / length, z: (target.z - z) / length }, ...extra };
};
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

  it('gives a point with a big error as a direction (two lines 12° apart at 1.9 km)', () => {
    const truth = { x: 700, z: -1900 };
    const fix = stronghold([throwFrom(120, -80, truth), throwFrom(520, -40, truth)]);
    expect(fix).not.toBeNull();
    expect(fix!.errorBlocks).toBeGreaterThan(150);
    expect(Math.abs(fix!.x - truth.x)).toBeLessThanOrEqual(fix!.errorBlocks);
    expect(Math.abs(fix!.z - truth.z)).toBeLessThanOrEqual(fix!.errorBlocks);
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

  it('places the point from two exactly read lines at a narrower crossing than two bearings may', () => {
    const truth = { x: 1000, z: -2000 };
    expect(stronghold([throwFrom(0, 0, truth), throwFrom(200, 0, truth)])).toBeNull();
    const fix = stronghold([exactFrom(0, 0, truth), exactFrom(200, 0, truth)]);
    expect(fix).not.toBeNull();
    near(fix!.x, truth.x, fix!.errorBlocks);
    near(fix!.z, truth.z, fix!.errorBlocks);
    expect(fix!.errorBlocks).toBeLessThan(300);
    // a unit vector that disagrees with the bearing beside it is not trusted: the bearing's wider error applies
    const odd = { ...exactFrom(0, 0, truth), unit: { x: 0.6, z: 0.8 } };
    expect(stronghold([odd, { ...exactFrom(200, 0, truth), unit: { x: 0.6, z: 0.8 } }])).toBeNull();
  });

  it.each([24, 32])('finds the lab target after %i m sideways, within the 128 m frame search radius', sideways => {
    // Synthetic exact flights with S5's c1 start and /locate target, not a replay of the body's measured flights.
    const start = { x: 135, z: 104 };
    const truth = { x: -1072, z: 928 };
    const first = exactFrom(start.x, start.z, truth);
    const second = exactFrom(start.x - first.unit!.z * sideways, start.z + first.unit!.x * sideways, truth);
    const fix = stronghold([first, second]);
    expect(fix).not.toBeNull();
    near(fix!.x, truth.x, 1);
    near(fix!.z, truth.z, 1);
    expect(fix!.throws).toBe(2);
    expect(fix!.errorBlocks).toBeGreaterThan(60);
    expect(fix!.errorBlocks).toBeLessThan(100);
    expect(fix!.errorBlocks).toBeLessThan(128);
    expect(stronghold([throwFrom(start.x, start.z, truth), second])).toBeNull();
    expect(stronghold([first, { ...second, flew: 3 }])).toBeNull();
  });

  it('grows the error as precise crossings narrow, and still rejects crossings below 0.5 degrees or excessive error', () => {
    const truth = { x: 0, z: -1460 };
    const pair = (degrees: number, distance = 1460) => {
      const target = { x: 0, z: -distance };
      return [exactFrom(0, 0, target), exactFrom(distance * Math.tan(degrees * Math.PI / 180), 0, target)];
    };
    const wide = stronghold(pair(3))!;
    const lab = stronghold(pair(0.9))!;
    const narrow = stronghold(pair(0.51))!;
    expect([wide, lab, narrow]).not.toContain(null);
    near(lab.x, truth.x, 1);
    near(lab.z, truth.z, 1);
    expect(lab.errorBlocks).toBeGreaterThan(85);
    expect(lab.errorBlocks).toBeLessThan(100);
    expect(narrow.errorBlocks).toBeGreaterThan(lab.errorBlocks * 1.7);
    expect(lab.errorBlocks).toBeGreaterThan(wide.errorBlocks * 3);
    expect(stronghold(pair(0.49))).toBeNull();
    expect(stronghold(pair(0.51, 8000))).toBeNull();
  });

  it('does not claim more than its lines agree on (two parallel lines 20 m apart and one across)', () => {
    const lines: EyeThrow[] = [{ x: 0, z: 0, bearingDeg: 90, flew: 12, broke: false }, { x: 30, z: 30, bearingDeg: 0, flew: 12, broke: false },
      { x: 0, z: 20, bearingDeg: 90, flew: 12, broke: false }];
    const fix = stronghold(lines);
    expect(fix).not.toBeNull();
    expect(fix!.errorBlocks).toBeGreaterThanOrEqual(10);
  });

  it('takes a sunk eye as the place itself and never as a line, and suggests no throw from it', () => {
    const sunk: EyeThrow = { x: 100, z: 200, bearingDeg: 0, flew: 0, broke: false, down: true };
    expect(stronghold([sunk])).toEqual({ x: 100, z: 200, errorBlocks: 1, throws: 1, ahead: [0] });
    expect(nextThrowPlaces(sunk, 0)).toEqual([]);
    expect(directPoint([sunk, throwFrom(0, 0, { x: 1000, z: -2000 })])).toMatchObject({ kind: 'down', x: 100, z: 200 });
    expect(directPoint([throwFrom(0, 0, { x: 1000, z: -2000 })])).toBeNull();
  });

  it('takes a stopped eye as the stronghold where it stopped, along its own direction', () => {
    const stopped: EyeThrow = { x: 0, z: 0, bearingDeg: 90, flew: 7, broke: false, arrived: true };
    expect(stronghold([stopped])).toMatchObject({ x: 7, z: 0, errorBlocks: 1, throws: 1 });
    expect(nextThrowPlaces(stopped, 0)).toEqual([]);
  });

  it('starts 24 m sideways after a precise line, then widens when no point is found', () => {
    const places = nextThrowPlaces(exactFrom(0, 0, { x: 0, z: -2000 }), 0);
    expect(places).toEqual([{ x: 24, z: 0, from: 24 }, { x: -24, z: 0, from: 24 }]);
    for (const [failed, distance] of [[1, 200], [2, 400], [3, 800], [9, 800]] as const) {
      expect(nextThrowPlaces(exactFrom(0, 0, { x: 0, z: -2000 }), failed).map(place => place.from)).toEqual([distance, distance]);
    }
  });

  it('suggests a place on the line toward the point, short of it', () => {
    const fix = { x: 0, z: -1000, errorBlocks: 80, throws: 2, ahead: [1000, 1000] };
    expect(nearThrowPlace({ x: 0, z: 0 }, fix, 120)).toEqual({ x: 0, z: -880, from: 880 });
    expect(nearThrowPlace({ x: 0, z: -950 }, fix, 120)).toBeNull();
  });
});
