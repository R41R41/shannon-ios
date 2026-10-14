import type { BodyObservation } from '../../contracts/bodyControlContract.js';

/**
 * Situational pointers to her Minecraft skills (the old Minebot TAUGHT_SLOTS, Minecraft run 9 of 2026-10-14: none of the six legacy
 * trial skills was read in 57 steps, though `skill.read` and the index were offered every step, and she waited idle through the
 * night 390 s in nine calls). When the body's state matches a skill's own trigger (its index line), the decision's body context names
 * that skill and the trigger in a line, so that she opens it with `skill_read`. Closed facts only; only skills she can read now
 * (`skillNames`); in the volatile decision message, never in the cached prefix.
 */
export interface MinecraftSituation {
  night: boolean; darkSoon: boolean; threatNear: boolean; lowHealth: boolean; hungry: boolean; stalled: boolean; idleWaiting: boolean;
  readyForNether: boolean; inNether: boolean; blazeNear: boolean;
}
type Pointer = { skill: string; when: string; applies(situation: MinecraftSituation): boolean };
const POINTERS: readonly Pointer[] = Object.freeze([
  { skill: 'mc-night-retreat', when: '夜・暗くなる直前・敵が近い', applies: s => s.night || s.darkSoon || s.threatNear },
  { skill: 'mc-low-health', when: '体力が半分以下', applies: s => s.lowHealth },
  { skill: 'mc-food-and-pace', when: '空腹・進展が止まった・待ちが続いた', applies: s => s.hungry || s.stalled || s.idleWaiting },
  { skill: 'mc-nether-portal', when: '鉄のツルハシがありネザーへ向かう前', applies: s => s.readyForNether },
  { skill: 'mc-nether-travel', when: 'ネザーにいる', applies: s => s.inNether },
  { skill: 'mc-blaze-rods', when: 'ネザーでブレイズが近い', applies: s => s.blazeNear },
]);
/** The note beside the pointers: fixed words. */
export const MINECRAFT_SKILL_POINTER_NOTE = 'いまの状況に合うスキル。動く前に skill_read で開いて手順を確かめる。';
const NIGHT_START = 13_000, NIGHT_END = 23_000, DARK_SOON_SECONDS = 60, THREAT_NEAR = 16, HALF_HEALTH = 10, HUNGRY = 6;
const STALLED_STEPS = 3, IDLE_WAIT_SECONDS = 60;

/** The pace facts the situation reads (`minecraftPace`). */
export interface MinecraftPaceFacts { failedStepsInARow: number; idleWaitSeconds?: number; milestones?: { netherReached: boolean | null } }

export function minecraftSituation(observation: BodyObservation | null, pace: MinecraftPaceFacts): MinecraftSituation {
  const world = record(observation?.state.world) ?? {};
  const facts = observation?.facts ?? {};
  const dimension = typeof world.dimension === 'string' ? world.dimension : typeof facts.dimension === 'string' ? facts.dimension : '';
  const overworld = dimension === 'overworld', nether = dimension === 'the_nether';
  return {
    ...darkness(world, overworld), threatNear: entityNear(list(world.nearbyThreats), name => name !== 'enderman', THREAT_NEAR),
    lowHealth: atMost(world.health, HALF_HEALTH), hungry: atMost(world.food, HUNGRY),
    stalled: pace.failedStepsInARow >= STALLED_STEPS, idleWaiting: (pace.idleWaitSeconds ?? 0) >= IDLE_WAIT_SECONDS,
    readyForNether: overworld && pace.milestones?.netherReached !== true
      && carriedItems(world, facts).some(item => /^(iron|diamond|netherite)_pickaxe/u.test(item)),
    inNether: nether,
    blazeNear: nether && entityNear([...list(world.nearbyThreats), ...list(world.nearbyEntities)], name => name === 'blaze', 48),
  };
}

/** Night (time of day 13,000–23,000 ticks) and dark within a minute, in the overworld only. */
function darkness(world: Record<string, unknown>, overworld: boolean): Pick<MinecraftSituation, 'night' | 'darkSoon'> {
  const ticks = Number(world.time), darkIn = Number(record(world.margin)?.darkInSeconds);
  const timeOfDay = Number.isFinite(ticks) ? ((ticks % 24_000) + 24_000) % 24_000 : null;
  return { night: overworld && timeOfDay !== null && timeOfDay >= NIGHT_START && timeOfDay < NIGHT_END,
    darkSoon: overworld && Number.isFinite(darkIn) && darkIn >= 0 && darkIn <= DARK_SOON_SECONDS };
}
function entityNear(entities: readonly unknown[], named: (name: string) => boolean, distance: number): boolean {
  return entities.some(entity => {
    const value = record(entity);
    return typeof value?.name === 'string' && named(value.name) && Number(value.distance) <= distance;
  });
}
function atMost(value: unknown, limit: number): boolean {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) && number <= limit;
}
function carriedItems(world: Record<string, unknown>, facts: Readonly<Record<string, unknown>>): string[] {
  return [...list(world.inventory).filter((item): item is string => typeof item === 'string'),
    ...Object.entries(facts).filter(([key, value]) => key.startsWith('slot:') && typeof value === 'string').map(([, value]) => String(value))];
}

/** The pointers of a situation, only to skills in `skillNames`, at most three, in a fixed order. */
export function minecraftSkillPointers(situation: MinecraftSituation, skillNames: ReadonlySet<string>): string[] {
  return POINTERS.filter(pointer => skillNames.has(pointer.skill) && pointer.applies(situation))
    .slice(0, 3).map(pointer => `${pointer.skill}（${pointer.when}）`);
}

/** Skill names from her skill index (`- name（…`), as `skillIndex` writes it. */
export function skillNamesOfIndex(index: string): Set<string> {
  return new Set([...index.matchAll(/^- ([a-z0-9][a-z0-9-]{0,63})（/gmu)].map(match => match[1]!));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
