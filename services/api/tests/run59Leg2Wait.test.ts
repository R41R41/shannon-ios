import { describe, expect, it } from 'vitest';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { lookTravelEvidence, travelEvidence } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { forgetStalls, noteProgress } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

/** Run 59 leg 2, hold 1: the stairs down to the iron (y=41 to 16) were no progress (part (a) of 62338d06 only). */
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
