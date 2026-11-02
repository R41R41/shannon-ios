import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { factsContext, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { llmcTransient } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { createLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { stagesFor } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/** A frame; the End fight, when given, sits directly in the world as the body sends it. */
const frame = (world: object, fight?: object): BodyObservation => ({ connected: true, state: { world: { ...world, ...fight } }, facts: {}, bodyId: 'b', sequence: 1,
  stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
const dragon = seedPlan('エンドラを討伐して')!;
const parts = (tree = dragon): LlmcBodyParts => ({ plan: () => undefined, planView: () => null, planTree: () => tree, endgame: createEndgame(null) });

const fight = frame({ dimension: 'the_end', position: { x: 90, y: 49, z: 0 }, health: 20, food: 20, inventory: [{ name: 'bow', count: 1 }, { name: 'arrow', count: 40 }],
  lastDeath: '2分前 the_end (10,60,10) 「void」 落とした物: iron_sword×1。消えるまで最長約5分→拾いに戻れる', deaths: [{ dimension: 'the_end' }],
  rememberedPlaces: { nether_portal: '3000m 北 (1,2,3)' } },
{ dragon: { id: 7, health: 188, phase: 0, phaseName: 'holding_pattern', phaseFor: 4, perched: false, position: { x: 10, y: 80, z: 20 }, yaw: 0, distance: 52, headReach: null,
  strike: false }, perch: { x: 0.5, y: 68, z: 0.5 }, crystals: { remaining: 9, gone: 1, caged: 2, unseen: [], list: [] }, dragonBreath: [], dragonFireballs: 0 });

describe('the way to the dragon in the live state', () => {
  it('puts the dragon, the crystals and the last death in the facts of the normal and the urgent version, and the places only in the normal one', () => {
    const body = parts();
    const normal = inputFacts(fight, factsContext(body, fight, {}, undefined, {}), false).lines.join('\n');
    expect(normal).toContain('竜: 体力 188/200・島の上を周回（phase 0）');
    expect(normal).toContain('エンドクリスタル: 残り 9/10（壊れた 1・檻つき 2）');
    expect(normal).toContain('最後の死: 2分前 the_end');
    expect(normal).toContain('控え（体の記憶、今いる次元）: ポータル 3000m 北 (1,2,3)');
    const urgent = inputFacts(fight, factsContext(body, fight, {}, undefined, {}), true);
    expect(urgent.lines.join('\n')).toContain('竜: 体力 188/200');
    expect(urgent.lines.join('\n')).toContain('最後の死:');
    expect(urgent.lines.join('\n')).not.toContain('控え（');
    expect(urgent.compressed.join('\n')).toContain('エンドクリスタル: 残り 9');
  });

  it('says nothing of it for a request that is not after the dragon', () => {
    const nether = seedPlan('ネザーに行って')!;
    const lines = inputFacts(fight, factsContext(parts(nether), fight, {}, undefined, {}), false).lines.join('\n');
    expect(lines).not.toContain('竜:');
    expect(lines).not.toContain('最後の死');
  });

  it('reaches the live state a decision reads, beside the road and the meter', () => {
    const live = llmcTransient(parts(), createLlmcEvents('endgame-live'), fight, 80, [], {}, 'endgame-live');
    const facts = (live.facts as string[]).join('\n');
    expect(facts).toContain('竜: 体力 188/200');
    expect(JSON.stringify(live)).toContain('目安:');
  });

  it('picks the stages of the dimension she is in: the End, and the stronghold when eyes are carried in the overworld', () => {
    expect(stagesFor({ body: { state: { dimension: 'the_end' } } })).toEqual(['end']);
    expect(stagesFor({ body: { state: { dimension: 'overworld' }, inventory: ['ender_eye×12'] } })).toEqual(['prep', 'stronghold']);
    expect(stagesFor({ body: { state: { dimension: 'overworld', inside: 'ストロングホールドの中' } } })).toEqual(['prep', 'stronghold']);
  });
});
