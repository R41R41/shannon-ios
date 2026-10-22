import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAllRuns } from './decisionReplay/allRuns.js';
import { answerOfSent, observationOf, productionTransform } from './decisionReplay/headTransform.js';
import { decisionOf, loadScenes } from './decisionReplay/score.js';
import { VARIANTS } from './decisionReplay/request.js';

/**
 * 頭の変換（tests/decisionReplay/headTransform.ts）の、API を呼ばない試験。本番の stopIf の点検（minecraftLlmcStopIf.ts）と同じ結果になること、
 * 場面のファイルが 60 以上で番号が重ならないこと、版の表に候補の口があること。本番の DB の控えが無い所では、控えを使う試験は飛ばす。
 */
const dataFile = (name: string) => new URL(`./decisionReplay/data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const haveData = existsSync(dataFile('export1.txt')) && existsSync(dataFile('export2.txt')) && existsSync(dataFile('journal.txt'));

describe('decision replay: scenes and variants', () => {
  it('has at least 60 scenes with unique ids and a spread of kinds', () => {
    const scenes = loadScenes();
    expect(scenes.length).toBeGreaterThanOrEqual(60);
    expect(new Set(scenes.map(scene => scene.id)).size).toBe(scenes.length);
    expect(new Set(scenes.map(scene => scene.id.slice(0, 3))).size).toBe(scenes.length);
    for (const category of ['stopped', 'urgent', 'progress']) expect(scenes.filter(scene => scene.category.includes(category)).length).toBeGreaterThan(5);
  });
  it('has the candidate slot in the variant table', () => {
    expect(VARIANTS.find(variant => variant.id === 'cand')?.cand).toBe(true);
    expect(VARIANTS.find(variant => variant.id === 'v1')?.ownPrompt).toBe(false);
  });
});

describe.skipIf(!haveData)('production head transform on recorded scenes', () => {
  const runs = haveData ? loadAllRuns() : new Map();
  const decisionFor = (prefix: string) => decisionOf(runs, loadScenes().find(scene => scene.id.startsWith(prefix))!);
  const act = (hands: unknown[], extra: Record<string, unknown> = {}) => ({ why: '[p1.1] テスト', hands, ...extra });

  it('adds hostileWithin 4 to a waiting act when no reaching hostile is that near (s22: a piglin at 13 m)', () => {
    const decision = decisionFor('s22');
    const sent = productionTransform('mc.act', act([{ do: 'attack', target: 'enderman', hold: true, seconds: 25 }], { stopIf: { hpBelow: 12 } }), decision);
    expect(sent.problem).toBeNull();
    expect(sent.changed).toBe(true);
    expect((sent.input as { stopIf: Record<string, number> }).stopIf.hostileWithin).toBe(4);
    expect(sent.fixes.join(' ')).toContain('hostileWithin');
    expect(answerOfSent(sent).stopIf?.hostileWithin).toBe(4);
  });
  it('takes off an hpBelow at or above her health', () => {
    const decision = decisionFor('s18');
    const hp = (observationOf(decision).state.world as { health: number }).health;
    const sent = productionTransform('mc.act', act([{ do: 'walk', to: { x: 1, y: 2, z: 3 } }], { stopIf: { hpBelow: hp + 3 } }), decision);
    expect(sent.changed).toBe(true);
    expect((sent.input as { stopIf?: Record<string, number> }).stopIf?.hpBelow).toBeUndefined();
    expect(sent.fixes.join(' ')).toContain('外した');
  });
  it('leaves other tools and well-formed acts as they are', () => {
    const decision = decisionFor('s22');
    expect(productionTransform('plan.update', { current: 'p1.1' }, decision).changed).toBe(false);
    const plain = productionTransform('mc.act', act([{ do: 'walk', to: { x: 1, y: 2, z: 3 } }], { stopIf: { hpBelow: 3 } }), decision);
    expect(plain.changed).toBe(false);
    expect(plain.fixes).toEqual([]);
  });
  it('turns an input that does not fit the body into a failure with its one line', () => {
    const sent = productionTransform('mc.act', { hands: [{ do: 'dance' }] }, decisionFor('s22'));
    expect(sent.problem).toBeTruthy();
    expect(answerOfSent(sent).shapeProblem).toBeTruthy();
  });
  it('builds the frame the stopIf check reads from the live: health and the hostiles with whether they can reach her', () => {
    const decision = decisionFor('s01');
    const world = observationOf(decision).state.world as { health: number; nearbyThreats: Array<{ name: string; distance: number; canReachMe: boolean | null }> };
    expect(world.health).toBeGreaterThan(0);
    expect(world.nearbyThreats.length).toBeGreaterThan(0);
    expect(world.nearbyThreats.some(threat => threat.canReachMe === false)).toBe(true);
  });
});
