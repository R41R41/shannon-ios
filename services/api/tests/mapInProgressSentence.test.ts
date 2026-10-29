import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { lookAtFooting } from '../src/surfaces/minecraft/minecraftLlmcFooting.js';
import { goStop } from '../src/surfaces/minecraft/minecraftLlmcGoGuard.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { heldBeforeSend } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { preflightOfFrame, standAfterHands } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import { readLayers, BODY_RULES } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { rangeStop } from '../src/surfaces/minecraft/minecraftLlmcRangeGuard.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { ruleGuardOfFrame } from '../src/surfaces/minecraft/minecraftLlmcRuleGuard.js';
import { readTopGrid } from '../src/surfaces/minecraft/minecraftLlmcSurfaceLook.js';
import { useReachStop } from '../src/surfaces/minecraft/minecraftLlmcLiquid.js';

/**
 * Run 47, hold 8 (the body's b58c701): until the chunks round her feet are loaded after a restart, \`localMap\` is not a drawing but a sentence, 「地図はまだ作り中（周りのチャンクを読み込み中）。
 * view で周りを見るか、少し待ってから」 (the map after an act too). A sentence is a map that cannot be read: no guard refuses by it, the live state shows it as the map, and nothing breaks.
 */
const SENTENCE = '地図はまだ作り中（周りのチャンクを読み込み中）。view で周りを見るか、少し待ってから';
const POSITION = { x: 171.5, y: -4, z: 180.5 };
const frame = (localMap: unknown): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', facts: {}, state: { world: { position: POSITION, localMap, health: 20, food: 20, dimension: 'overworld',
  inventory: [{ name: 'bucket', count: 1 }, { name: 'obsidian', count: 1 }], nearbyThreats: [], nearbyEntities: [] } } } as unknown as BodyObservation);
const acts = [
  { hands: [{ do: 'obsidian', at: [{ x: 171, y: -5, z: 179 }] }] },
  { hands: [{ do: 'go', to: { x: 175, y: -4, z: 180 }, canDig: ['stone'], maxDig: 20 }] },
  { hands: [{ do: 'walk', to: { x: 172, y: -4, z: 180 } }, { do: 'place', block: 'cobblestone', at: [{ x: 173, y: -5, z: 180 }] }] },
  { hands: [{ do: 'dig', at: [{ x: 172, y: -4, z: 181 }] }] },
  { hands: [{ do: 'use', item: 'water_bucket', at: [{ x: 171, y: -5, z: 179 }] }] },
  { hands: [{ do: 'vertical', dir: 'down', shape: 'stairs', toward: 'north', toY: -20, canDig: ['stone'], liquid: 'stop' }] },
];

describe('the map is a sentence (still being made): nothing refuses by it', () => {
  it('is no map to read', () => {
    expect(readLayers(SENTENCE, BODY_RULES)).toBeNull();
    expect(readTopGrid(SENTENCE).size).toBe(0);
  });
  it('the guards before sending let every act go', () => {
    const f = frame(SENTENCE);
    for (const act of acts) {
      expect(rangeStop(act, f), JSON.stringify(act)).toBeNull();
      expect(goStop(act, f), JSON.stringify(act)).toBeNull();
      expect(preflightOfFrame(act, f, 'task-sentence'), JSON.stringify(act)).toBeNull();
      expect(ruleGuardOfFrame(act, f, 'task-sentence'), JSON.stringify(act)).toBeNull();
      expect(useReachStop(act, f), JSON.stringify(act)).toBeNull();
      // the checks together answer a sentence as they answer no map at all (a note of the readiness for a descent is the same for both: it does not read the map)
      for (const urgent of [false, true]) expect(heldBeforeSend(urgent, act, f, 'task-sentence'), JSON.stringify(act)).toEqual(heldBeforeSend(urgent, act, frame(undefined), 'task-sentence'));
      expect(heldBeforeSend(false, act, f, 'task-sentence') === null || 'note' in heldBeforeSend(false, act, f, 'task-sentence')!, JSON.stringify(act)).toBe(true);
    }
    expect(standAfterHands(acts[2], f, 'task-sentence', 2)).toBeDefined();
  });
  it('the look at the footing finds nothing to ask about', async () => {
    const found = await lookAtFooting({ taskId: 'task-sentence', map: SENTENCE, feet: { x: 171, y: -4, z: 180 }, run: null, budgetMs: 100, index: 1 });
    expect(found.line).toBeNull();
  });
  it('the live state carries the sentence as the map and the rewrite does not break on it', () => {
    const live = minecraftLlmcLive({ observation: frame(SENTENCE), elapsedMinutes: 1, trend: createFoodTrend(), events: [] }) as { map?: unknown };
    expect(live.map).toBe(SENTENCE);
    const { live: rewritten } = rewriteLlmcLive({ plan: {}, body: live });
    const body = rewritten.body as { map?: unknown };
    expect(String(body.map ?? '')).toContain('地図はまだ作り中');
  });
});
