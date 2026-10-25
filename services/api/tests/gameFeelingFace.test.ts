import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createInitialCompanionState, faceForEmotionKind, faceForMood, reduceCompanionState } from '@shannon/cognition';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { feelingBody } from '../src/mind/emotion/feelingPorts.js';
import { gameMomentOf } from '../src/mind/emotion/gameFeeling.js';
import { fakeFeelingJev } from './support/feelingHarness.js';

/**
 * Phase 2 of her Minecraft body (owner 2026-10-26): a feeling a game moment brought shows on the body's face under the one face
 * (`SHANNON_SINGLE_FACE`), so her Minecraft skin (ExpressionMod, through presence) shows it; any other feeling keeps the face it had.
 */
const AT = '2026-10-26T04:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

function port() {
  const jev = fakeFeelingJev(() => ({ stance: 'neutral', intensity: 'moderate', drawer: 'none' }));
  return composedFeeling({ database: new DatabaseSync(':memory:'), now: () => AT, timeZone: 'Asia/Tokyo', chooser: jev.chooser, turn: true, singleFace: true }).port;
}
const mood = (snapshot: ReturnType<typeof createInitialCompanionState>, at = AT) =>
  feelingBody.mood(port(), 'owner', undefined, at, snapshot, { expression: 'neutral' }, null);

describe('a game feeling on the one face', () => {
  it('shows while it lasts, on presence for every body', () => {
    const start = createInitialCompanionState('owner', AT);
    const found = reduceCompanionState(start, { type: 'game-felt', moment: { kind: 'milestone', milestone: 'first_diamond' } }, AT);
    expect(mood(found).expression).toBe(faceForEmotionKind('excited').expression);
    const died = reduceCompanionState(start, { type: 'game-felt', moment: gameMomentOf({ type: 'game.died', cause: 'minecraft:lava' })! }, AT);
    expect(mood(died).expression).toBe(faceForEmotionKind('frustrated').expression);
    // Long after, the feeling has faded and the quiet mood's face is back.
    expect(mood(found, later(24 * 60)).expression).toBe(faceForMood(found.emotion).expression);
  });

  it('leaves any other feeling to the face it had', () => {
    const start = createInitialCompanionState('owner', AT);
    const patted = reduceCompanionState(start, { type: 'body-touched', touch: { kind: 'pet', countInWindow: 1 } }, AT);
    expect(patted.expressiveEmotion?.primary).toBe('happy');
    expect(mood(patted).expression).toBe(faceForMood(patted.emotion).expression);
  });
});
