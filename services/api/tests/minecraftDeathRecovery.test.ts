import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { deathDrops, deathDimensions } from '../src/surfaces/minecraft/minecraftDeathRecovery.js';
import { deathLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { dropsAdvice } from '../src/surfaces/minecraft/minecraftDropsAdvice.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { factsContext } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { llmcTransient } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { createLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';

const world = (extra: Record<string, unknown> = {}) => ({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 },
  inventory: [], health: 20, food: 20,
  lastDeath: '2分前 the_nether (140,77,75) 「Shannon was slain by Wither Skeleton」 落とした物: iron_sword×1→拾いに戻れる',
  deaths: [{ dimension: 'minecraft:the_nether', lostItems: ['iron_sword×1', 'diamond_pickaxe×1'] }], ...extra });
const frame = (value: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  connected: true, stateAt: 't', receivedAt: 't', facts: {}, state: { world: value as never } });

describe('run62 #7: recovery in the decision input', () => {
  it('keeps cross-dimensional drops as recovery facts without adding them to carried inventory', () => {
    const value = world();
    expect(deathDrops(value)?.get('diamond_pickaxe')).toBe(1);
    const advice = dropsAdvice(value, deathDrops(value))!;
    expect(advice).toContain('別の次元 the_nether');
    expect(advice).toContain('自分がその次元にいない間は消える時計が進まない');
    expect(advice).toContain('木→石の道具・ブロック 64・食料をそろえてから、1 幅 2 高のトンネルで寄る');
    expect(advice).not.toContain('歩いて');
    expect(value.inventory).toEqual([]);
  });

  it('normalizes dimension ids and falls back to the actual last-death line', () => {
    expect(deathDimensions(world({ dimension: 'minecraft:the_nether' })).apart).toBe(false);
    expect(deathDimensions(world({ deaths: [] }))).toMatchObject({ there: 'the_nether', apart: true });
    expect(deathDimensions({ dimension: 'overworld', lastDeath: '2分前 (1,2,3)' }).apart).toBe(false);
  });

  it('uses local distance only in the same dimension and does not promise a death-time countdown', () => {
    const value = world({ dimension: 'the_nether', rememberedPlaces: { death: '178m 南 (140,77,75)' } });
    const advice = dropsAdvice(value, deathDrops(value))!;
    expect(advice).toContain('死んだ所まで178m（歩いて約71秒');
    expect(advice).toContain('近くにいる間だけ約5分');
    expect(advice).not.toContain('死んで5分');
    expect(advice).toContain('iron_sword・diamond_pickaxe');
  });

  it('leaves gone, missing or empty drops out even across dimensions', () => {
    expect(deathDrops(world({ lastDeath: '2分前 the_nether 落とし物は消えた' }))).toBeNull();
    expect(deathDrops(world({ deaths: [{ dimension: 'the_nether', lostItems: [] }] }))).toBeNull();
    expect(deathDrops(world({ deaths: [] }))).toBeNull();
    expect(dropsAdvice(world(), null)).toBeNull();
  });

  it('counts the killer kind in the actual frame once per id and uses only matching body hitsLeft', () => {
    const value = world({ dimension: 'the_nether', nearbyThreats: [
      { id: 1, name: 'wither_skeleton' }, { id: 2, name: 'wither_skeleton' },
      { id: 1, name: 'wither_skeleton' }, { id: 3, name: 'skeleton' }],
      margin: { hitsLeft: { from: 'wither_skeleton', hits: 3 } } });
    expect(deathLine(value)).toContain('wither_skeleton は今の frame に 2 体');
    expect(deathLine(value)).toContain('今の装備・体力では wither_skeleton のあと 3 打で倒れる（体の見積もり）');
    expect(deathLine({ ...value, margin: { hitsLeft: { from: 'skeleton', hits: 1 } } })).not.toContain('打で倒れる');
    expect(deathLine({ ...value, margin: undefined })).not.toContain('打で倒れる');
    expect(deathLine({ ...value, nearbyThreats: undefined })).not.toContain('frame に');
  });

  it('never describes current-dimension threats as survivors at a death in another dimension', () => {
    expect(deathLine(world({ nearbyThreats: [] }))).toContain('今いる次元の frame に 0 体（死亡地点に残る数は未確認）');
  });

  it('reaches the normal, urgent and compressed facts and the live input read by v2', () => {
    const observation = frame(world());
    const tree = seedPlan('エンドラを討伐して')!;
    const parts = { plan: () => undefined, planView: () => null, planTree: () => tree, endgame: createEndgame(null) };
    const context = factsContext(parts, observation, {}, undefined);
    for (const urgent of [false, true]) {
      const facts = inputFacts(observation, context, urgent);
      for (const lines of [facts.lines, facts.compressed]) {
        expect(lines.join('\n')).toContain('最後の死:');
        expect(lines.join('\n')).toContain('自分がその次元にいない間は消える時計が進まない');
      }
    }
    const live = llmcTransient(parts, createLlmcEvents('death-recovery'), observation, 80, [], {}, 'death-recovery');
    expect((live.facts as string[]).join('\n')).toContain('木→石の道具・ブロック 64');
    expect(live.inventory).not.toContain('diamond_pickaxe×1');
  });
});
