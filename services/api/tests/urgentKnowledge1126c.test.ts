import { describe, expect, it } from 'vitest';
import { V2_ALWAYS, V2_STAGES, stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { minecraftLlmcUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { URGENT_MODE } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';

// Run of 11/26 (4th): three or four hoglins killed her; the words below are what the urgent decision reads about them.
describe('the urgent decision reads the hoglin, the retreat and the way back', () => {
  const urgentLive = () => minecraftLlmcUrgentLive({
    observation: { state: { world: { health: 11, dimension: 'the_nether' } } } as never, elapsedMinutes: 30, events: [], lastResults: [],
    urgent: ['ホグリン #1 3.0m'] as never, investigation: null, footing: null, bodyAge: null, queue: null, recovery: null, once: null, promises: null,
    planNowTitle: null, mode: URGENT_MODE } as never) as Record<string, unknown>;

  it('puts the nether stage (with the hoglin line) in the knowledge made from the urgent live state', () => {
    const live = { body: urgentLive() };
    const stage = stageKnowledge(live as never) ?? '';
    // eslint-disable-next-line no-console
    if (!stage.includes('ホグリン')) console.log('urgent live body keys:', Object.keys(live.body));
    expect(stage).toContain('ホグリン（体力 40・近接が強い');
    expect(stage).toContain('1 頭に約 12 打撃（約 7 秒）');
    expect(stage).toContain('木か石の剣では何頭も相手にできない');
    expect(stage).toContain('ホグリンのいる側に置かない');
  });
  it('says the time of a fight, the route that ignores enemies, the way back and the place limit', () => {
    expect(V2_ALWAYS).toContain('hits = enemy health / your sword');
    expect(V2_ALWAYS).toContain('is no retreat');
    expect(V2_STAGES.nether).toContain('着地点を時刻順に並べた列');
    expect(V2_STAGES.nether).toContain('ゲートまでの距離が縮む向きの点だけ');
    expect(V2_STAGES.nether).not.toContain('250m の直の go を出さず');
    expect(V2_STAGES.nether).toContain('持ち数の合計（live の「置ける足場」の行）まで上げてよい');
  });
});
