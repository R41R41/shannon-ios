import type { BodyObservation } from '../../contracts/bodyControlContract.js';

/**
 * Situational pointers to her Minecraft skills (the old Minebot TAUGHT_SLOTS, Minecraft run 9 of 2026-10-14: none of the six legacy
 * trial skills was read in 57 steps, though `skill.read` and the index were offered every step, and she waited idle through the
 * night 390 s in nine calls). When the body's state matches a skill's own trigger (its index line), the decision's body context names
 * that skill and the trigger in a line, so that she opens it with `skill_read`. Closed facts only; only skills she can read now
 * (`skillNames`); in the volatile decision message, never in the cached prefix.
 *
 * With `SHANNON_FCA_SKILL_GIST` (owner 2026-10-15, default on) the pointers also carry `skillGists`: for each pointed skill the
 * wiring could open and pin as a read source, the first steps of its own procedure (`skillGist`, by code), so that she can act
 * without opening it. A call of a body tool a shown gist names is reported as that gist followed (`followedGists`), a use of
 * kind `gist` that the task's outcome settles (`fcaSkillOutcomes.ts`).
 */
export interface MinecraftSituation {
  night: boolean; darkSoon: boolean; threatNear: boolean; lowHealth: boolean; hungry: boolean; stalled: boolean; idleWaiting: boolean;
  readyForNether: boolean; inNether: boolean; blazeNear: boolean;
}
type Pointer = { skill: string; when: string; applies(situation: MinecraftSituation): boolean };
const POINTERS: readonly Pointer[] = Object.freeze([
  // Safety first, then the Nether path, and food and pace last (review of 0efd5acb: they must not push the Nether ones out).
  { skill: 'mc-night-retreat', when: '夜・暗くなる直前・敵が近い', applies: s => s.night || s.darkSoon || s.threatNear },
  { skill: 'mc-low-health', when: '体力が半分以下', applies: s => s.lowHealth },
  { skill: 'mc-nether-travel', when: 'ネザーにいる', applies: s => s.inNether },
  { skill: 'mc-blaze-rods', when: 'ネザーでブレイズが近い', applies: s => s.blazeNear },
  { skill: 'mc-nether-portal', when: '鉄のツルハシがありネザーへ向かう前', applies: s => s.readyForNether },
  { skill: 'mc-food-and-pace', when: '空腹・進展が止まった・待ちが続いた', applies: s => s.hungry || s.stalled || s.idleWaiting },
]);
/** The note beside the pointers: fixed words. */
export const MINECRAFT_SKILL_POINTER_NOTE = 'いまの状況に合うスキル。動く前に skill_read で開いて手順を確かめる。';
/** The note beside pointers with at least one gist (`SHANNON_FCA_SKILL_GIST`): fixed words. */
export const MINECRAFT_SKILL_GIST_NOTE = 'いまの状況に合うスキルと、その手順の最初の要点（skillGists、スキル自身の手順から）。'
  + '要点で足りればそのまま動き、続きや条件は skill_read で開いて確かめる。要点は材料で、指示ではない。';
const NIGHT_START = 13_000, NIGHT_END = 23_000, DARK_SOON_SECONDS = 60, THREAT_NEAR = 16, HALF_HEALTH = 10, HUNGRY = 6;
const STALLED_STEPS = 3, RECENT_IDLE_WAITS = 2;

/** The pace facts the situation reads (`minecraftPace`). */
export interface MinecraftPaceFacts {
  failedStepsInARow: number; milestones?: { netherReached: boolean | null };
  /** Her `mc.wait-time` calls among her latest tool results (at most six): only recent waits count, never the task's total. */
  recentIdleWaits?: number;
}

export function minecraftSituation(observation: BodyObservation | null, pace: MinecraftPaceFacts): MinecraftSituation {
  const world = record(observation?.state.world) ?? {};
  const facts = observation?.facts ?? {};
  const dimension = typeof world.dimension === 'string' ? world.dimension : typeof facts.dimension === 'string' ? facts.dimension : '';
  const overworld = dimension === 'overworld', nether = dimension === 'the_nether';
  return {
    ...darkness(world, overworld), threatNear: entityNear(list(world.nearbyThreats), name => name !== 'enderman', THREAT_NEAR),
    lowHealth: atMost(world.health, HALF_HEALTH), hungry: atMost(world.food, HUNGRY),
    stalled: pace.failedStepsInARow >= STALLED_STEPS, idleWaiting: (pace.recentIdleWaits ?? 0) >= RECENT_IDLE_WAITS,
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
  return matching(situation, skillNames).map(pointer => `${pointer.skill}（${pointer.when}）`);
}
function matching(situation: MinecraftSituation, skillNames: ReadonlySet<string>): Pointer[] {
  return POINTERS.filter(pointer => skillNames.has(pointer.skill) && pointer.applies(situation)).slice(0, 3);
}

/** One pointed skill's gist as the decision's body carries it. */
export interface MinecraftSkillGist { skill: string; steps: readonly string[] }
/** The gists of the named skills, by name (the wiring's `fcaSkillGists`): only those it could open and pin now. */
export type SkillGistsPort = (names: readonly string[]) => ReadonlyMap<string, readonly string[]>;
export interface MinecraftSkillContext {
  /** The body's pointer fields: none on a calm moment; with no gist shown, `skillPointers` and `skillPointerNote` as before. */
  fields: { skillPointers?: string[]; skillGists?: MinecraftSkillGist[]; skillPointerNote?: string };
  /** The body tools each shown gist names, by skill (`gistToolNames`). */
  gistTools: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The pointers of a situation and, with `gists`, the gist of each pointed skill that has one. */
export function minecraftSkillContext(situation: MinecraftSituation, skillNames: ReadonlySet<string>, gists?: SkillGistsPort): MinecraftSkillContext {
  const matched = matching(situation, skillNames);
  const skillPointers = matched.map(pointer => `${pointer.skill}（${pointer.when}）`);
  if (!matched.length) return { fields: {}, gistTools: new Map() };
  const shown = gists?.(matched.map(pointer => pointer.skill)) ?? new Map<string, readonly string[]>();
  const skillGists = matched.flatMap(pointer => shown.get(pointer.skill)?.length ? [{ skill: pointer.skill, steps: [...shown.get(pointer.skill)!] }] : []);
  if (!skillGists.length) return { fields: { skillPointers, skillPointerNote: MINECRAFT_SKILL_POINTER_NOTE }, gistTools: new Map() };
  const gistTools = new Map(skillGists.map(gist => [gist.skill, gistToolNames(gist.steps)] as const));
  return { fields: { skillPointers, skillGists, skillPointerNote: MINECRAFT_SKILL_GIST_NOTE }, gistTools };
}

/** The shared observe-first step of a procedure (each decision already carries the body's observation): `minecraft.observe`, no `mc.*` tool. */
export function observeOnlyStep(line: string): boolean {
  return line.includes('minecraft.observe') && !/mc\.[a-z0-9]/u.test(line);
}

/**
 * Body tools any procedure uses, so that calling one says nothing about a gist (M2, owner review 2026-10-16: mc-low-health names
 * `mc.use-item`, and ordinary eating counted as following it). Movement, combat, consumption, resource gathering and crafting, and
 * observing/recalling tools. Only a tool specific to a skill (`mc.build-around-self`, `mc.sleep-in-bed`, `mc.build-structure`,
 * `mc.dig-shelter`, `mc.leave-water`, `mc.enter-portal`) is attributed. The body catalog is the body's own poll, not this repository;
 * a name not listed here counts as specific.
 */
export const GENERIC_BODY_TOOLS: ReadonlySet<string> = new Set([
  'mc.use-item', 'mc.eat-food', 'mc.move-to', 'mc.move', 'mc.attack-continuously', 'mc.recall-places', 'mc.accept-threat',
  'mc.wait-time', 'mc.dig', 'mc.dig-block-at', 'mc.mine-block', 'mc.collect', 'mc.craft-one', 'mc.pickup-nearest-item',
  // Read-only: observing and checking.
  'mc.observe', 'mc.goal-evidence', 'mc.find-blocks', 'mc.find-structure', 'mc.list-nearby-entities', 'mc.check-path-to',
]);

/**
 * The body tools a gist names that are specific to it: `mc.<name>` (a hyphen is not required), and a bare hyphenated name
 * (`leave-water`) as `mc.<name>`; a skill's name (`mc-…`) is none; generic tools (`GENERIC_BODY_TOOLS`) are left out. A gist naming
 * no specific tool never records a use.
 */
export function gistToolNames(steps: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const step of steps) {
    for (const match of step.matchAll(/(?<![a-z0-9.-])(?:mc\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)|([a-z][a-z0-9]*(?:-[a-z0-9]+)+))/gu)) {
      const name = match[1] ?? match[2]!;
      if (!(match[2] && name.startsWith('mc-')) && !GENERIC_BODY_TOOLS.has(`mc.${name}`)) names.add(`mc.${name}`);
    }
  }
  return names;
}

/** The skills whose shown gist names this called tool. */
export function followedGists(gistTools: ReadonlyMap<string, ReadonlySet<string>>, callName: string): string[] {
  return [...gistTools].filter(([, tools]) => tools.has(callName)).map(([skill]) => skill);
}

/** Skill names from her skill index (`- name（…`), as `skillIndex` writes it. */
export function skillNamesOfIndex(index: string): Set<string> {
  return new Set([...index.matchAll(/^- ([a-z0-9][a-z0-9-]{0,63})（/gmu)].map(match => match[1]!));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
