import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts, countMatching } from './minecraftItems.js';
import { dayTick, dimensionOfWorld } from './minecraftMoments.js';
import { mobWords, timeWords } from './minecraftLiveWords.js';

/**
 * The scene a voice is said in (`SHANNON_MINECRAFT_LIVE_SPEECH`): what is around her this second, in closed facts, for the model that writes
 * the one word of a hit, a get-away, a fall. It is made from the body's newest frame and nothing else: what stands at her and how far, her
 * health and how fast it fell, whether she holds a sword and a shield, whether a person is near, the time of day, and the few words of what she
 * was doing. It holds no part of her plan, her aim or what she said before: a word about a hit is about the hit, not about the bed she made
 * a while ago. Pure; the live view keeps the health trail and hands the frame.
 */
export interface LiveScene {
  health: number | null;
  food: number | null;
  /** How much health she lost in the last three seconds. */
  lost: number;
  /** The hostiles within 16 m, nearest first, in her words, with how many of each stand within that. */
  threats: ReadonlyArray<{ name: string; distance: number; reach: boolean }>;
  weapon: 'sword' | 'axe' | 'none';
  shield: boolean;
  bow: boolean;
  /** The nearest other person within 48 m, in metres, or null. */
  person: number | null;
  time: string;
  /** Where she is, in a word or two, or ''. */
  place: string;
  /** What she was doing, in a few words (the work's own words only), or ''. */
  doing: string;
  /** A rough reading of how a fight stands: only from the threats, her health and what she holds. Null when no hostile is near. */
  odds: 'good' | 'even' | 'bad' | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value : []).flatMap(item => {
  const row = record(item);
  return row ? [row] : [];
});

/** How hard one hostile is to fight (a creeper and a skeleton at range are the hard ones). */
const WEIGHT: Readonly<Record<string, number>> = Object.freeze({ creeper: 1.6, skeleton: 1.3, spider: 1.1, witch: 1.5, enderman: 2.5, blaze: 2, ghast: 2.5,
  piglin_brute: 2.5, vindicator: 2.2, pillager: 1.6, wither_skeleton: 2.2, hoglin: 2 });

/** The health she had at each frame of the last few seconds (the live view keeps it), newest last. */
export type HealthTrail = ReadonlyArray<{ at: number; health: number }>;

export function sceneOf(observation: BodyObservation, options: { now: number; trail: HealthTrail; doing: string }): LiveScene {
  const world = record(observation.state.world) ?? {}, counts = carriedItemCounts(world, observation.facts);
  const health = finite(world.health), food = finite(world.food);
  const threats = list(world.nearbyThreats).flatMap(threat => {
    const distance = finite(threat.distance);
    return distance !== null && distance <= 16 && typeof threat.name === 'string' && /^[a-z][a-z0-9_]{0,40}$/u.test(threat.name)
      ? [{ id: threat.name, name: mobWords(threat.name), distance: Math.round(distance), reach: threat.canReachMe !== false }] : [];
  }).sort((a, b) => a.distance - b.distance).slice(0, 4);
  const person = list(world.nearbyEntities).flatMap(entity => (entity.kind === 'player' && finite(entity.distance) !== null ? [finite(entity.distance)!] : []))
    .sort((a, b) => a - b)[0];
  const weapon = countMatching(counts, /_sword$/u) > 0 ? 'sword' : countMatching(counts, /_axe$/u) > 0 ? 'axe' : 'none';
  const shield = countMatching(counts, /^shield$/u) > 0, bow = countMatching(counts, /^bow$/u) > 0;
  const recent = options.trail.filter(item => options.now - item.at <= 3_000);
  const lost = health !== null && recent.length ? Math.max(0, Math.round(Math.max(...recent.map(item => item.health)) - health)) : 0;
  const near = threats.filter(threat => threat.reach && threat.distance <= 8);
  let odds: LiveScene['odds'] = null;
  if (near.length) {
    const load = near.reduce((sum, threat) => sum + (WEIGHT[threat.id] ?? 1), 0), armed = weapon !== 'none';
    odds = (health ?? 20) <= 6 || load >= 3.5 || (!armed && load >= 2) ? 'bad' : armed && (health ?? 20) >= 14 && load <= 2.2 ? 'good' : 'even';
  }
  const dimension = dimensionOfWorld(world, observation.facts);
  return { health: health === null ? null : Math.round(health), food, lost, threats: threats.map(({ name, distance, reach }) => ({ name, distance, reach })),
    weapon, shield, bow, person: person === undefined ? null : Math.round(person), time: timeWords(dimension === 'overworld' ? dayTick(world) : null),
    place: dimension === 'the_nether' ? 'ネザー' : dimension === 'the_end' ? 'ジ・エンド' : '', doing: options.doing, odds };
}

const ODDS: Readonly<Record<NonNullable<LiveScene['odds']>, string>> = { good: '勝てそう', even: '五分五分', bad: 'きびしそう' };

/**
 * Her health in her words (not the number: a model given 13 reads 13 aloud, and a cry that reads a number is a report). The number stays in
 * the scene for the code (the odds); the writer is told how it stands and how fast it is going.
 */
export function healthWords(health: number | null, lost: number): string {
  if (health === null) return '';
  const level = health >= 17 ? 'まだ元気' : health >= 11 ? '半分より多く残っている' : health >= 7 ? '半分くらい' : health >= 4 ? 'かなり少ない' : 'ほとんど残っていない';
  const fall = lost >= 4 ? '（この3秒で一気に減った）' : lost >= 1 ? '（この3秒で少し減った）' : '';
  return `${level}${fall}`;
}

/** The scene as lines for the writer: closed facts, in her words, with no instruction. */
export function sceneLines(scene: LiveScene): string[] {
  const counted = new Map<string, { count: number; nearest: number; reach: boolean }>();
  for (const threat of scene.threats) {
    const row = counted.get(threat.name);
    if (row) row.count += 1; else counted.set(threat.name, { count: 1, nearest: threat.distance, reach: threat.reach });
  }
  const threats = [...counted].map(([name, row]) => `${name}${row.count > 1 ? `${row.count}体` : ''}（いちばん近くて${row.nearest}m${row.reach ? '' : '、壁の向こう'}）`);
  const holds = [scene.weapon === 'sword' ? '剣' : scene.weapon === 'axe' ? '斧' : '', scene.shield ? '盾' : '', scene.bow ? '弓' : ''].filter(Boolean);
  return [
    scene.health !== null ? `- 体力: ${healthWords(scene.health, scene.lost)}` : '',
    scene.food !== null && scene.food <= 8 ? '- お腹がすいている' : '',
    threats.length ? `- 近くの敵: ${threats.join('、')}` : '- 近くに敵はいない',
    threats.length ? `- 持っている武器: ${holds.length ? holds.join('と') : '何も持っていない（素手）'}` : '',
    scene.odds ? `- 勝ち目の目安: ${ODDS[scene.odds]}` : '',
    scene.person !== null ? `- 近くに人がいる（${scene.person}mほど）` : '- 近くに人はいない',
    scene.time ? `- 時間: ${scene.time}` : '',
    scene.place ? `- いる所: ${scene.place}` : '',
    scene.doing ? `- さっきまでしていたこと: ${scene.doing}` : '',
  ].filter(Boolean);
}
