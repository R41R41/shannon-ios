import { BED_ITEM, countMatching, type ItemCounts } from './minecraftItems.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { doneFacts, parseDoneWhen, predicateHolds } from './minecraftPlanDone.js';
import { DRAGON_MILESTONES } from './minecraftLlmcRoad.js';

/**
 * Observation redesign P1 (measurement only, no change to what the body or the model sees): the first time a task's body carries
 * each early-game item (or enters the Nether), the late road's milestones, and the closed `stage` from what she carries. Content-free: names
 * from a closed list, seconds and a game tick.
 */
// Run 48: the diamond pickaxe was made at +1,000 s and no line was written, because the closed list below did not name it (the
// meter's milestones are the plan's; this list is the journal's): every item
// the meter points at is here, in the order of the road (the water bucket as well).
const EARLY_MILESTONE_NAMES = ['wooden_pickaxe', 'stone_pickaxe', 'stone_axe', 'bed', 'iron_pickaxe', 'bucket', 'iron_armor',
  'diamond_pickaxe', 'water_bucket', 'obsidian', 'nether_portal', 'blaze_rod'] as const;
const LATE_MILESTONES = DRAGON_MILESTONES.filter(item => item.late && item.journal);
export const MILESTONE_NAMES = Object.freeze([...EARLY_MILESTONE_NAMES, ...LATE_MILESTONES.map(item => item.journal!)]);
export type MilestoneName = typeof MILESTONE_NAMES[number];

const REACHED: Readonly<Record<Exclude<typeof EARLY_MILESTONE_NAMES[number], 'nether_portal'>, (counts: ItemCounts) => boolean>> = {
  wooden_pickaxe: counts => (counts.get('wooden_pickaxe') ?? 0) > 0,
  stone_pickaxe: counts => (counts.get('stone_pickaxe') ?? 0) > 0,
  stone_axe: counts => (counts.get('stone_axe') ?? 0) > 0,
  bed: counts => countMatching(counts, BED_ITEM) > 0,
  iron_pickaxe: counts => (counts.get('iron_pickaxe') ?? 0) > 0,
  bucket: counts => countMatching(counts, /^(?:water_|lava_|milk_|powder_snow_)?bucket$/u) > 0,
  iron_armor: counts => countMatching(counts, /^iron_(?:helmet|chestplate|leggings|boots)$/u) > 0,
  diamond_pickaxe: counts => (counts.get('diamond_pickaxe') ?? 0) > 0,
  water_bucket: counts => (counts.get('water_bucket') ?? 0) > 0,
  obsidian: counts => (counts.get('obsidian') ?? 0) > 0,
  blaze_rod: counts => (counts.get('blaze_rod') ?? 0) > 0,
};

/** The milestones this observation shows (from what is carried, and the dimension), whether reached before or not. */
export function milestonesShown(counts: ItemCounts, dimension: string | null): MilestoneName[] {
  const shown = (Object.keys(REACHED) as Array<keyof typeof REACHED>).filter(name => REACHED[name](counts));
  return [...shown, ...(dimension === 'the_nether' ? ['nether_portal' as const] : [])];
}

/** The late road's very predicates, with its overrides: crystals gone never claims a dragon kill. */
export function lateMilestonesShown(observation: BodyObservation | null): MilestoneName[] {
  const facts = doneFacts(observation);
  if (!facts) return [];
  return LATE_MILESTONES.filter(item => {
    const predicate = parseDoneWhen(item.doneWhen);
    return item.holds ? item.holds(facts) : !!predicate && predicateHolds(predicate, facts);
  }).map(item => item.journal!);
}

/** First-reach lines already written in this process, including steps whose commit did not finish. */
const logged = new Set<string>();
export function logMilestoneOnce(task: string, name: MilestoneName): boolean {
  const key = `${task}:${name}`;
  if (logged.has(key)) return false;
  if (logged.size >= 4_096) logged.clear();
  logged.add(key);
  return true;
}

/** Those of `shown` not in `already`, in the closed list's order: each is first-reached now. A re-acquired item is never new. */
export function newlyReached(shown: readonly MilestoneName[], already: ReadonlySet<string>): MilestoneName[] {
  return MILESTONE_NAMES.filter(name => shown.includes(name) && !already.has(name));
}

/** Her stage from what she carries: the one definition (minecraftStage.ts), shared with the skill pointers. */
export { minecraftStage, type MinecraftStage } from './minecraftStage.js';

const seconds = (milliseconds: number) => Math.max(0, Math.round(milliseconds / 1000));
const tickText = (tick: number | null) => tick === null ? '-' : String(Math.trunc(tick));
const idList = (names: readonly string[]) => {
  const safe = names.filter(name => /^[a-z0-9_-]{1,64}$/u.test(name));
  return safe.length ? safe.join(',') : '-';
};

/** `Shannon Minecraft milestone task=<id> name=<name> t=<s since the task began> tick=<game tick|-> d=<decision>` */
export function milestoneLine(task: string, name: MilestoneName, elapsedMilliseconds: number, tick: number | null, decision: number): string {
  return `Shannon Minecraft milestone task=${task} name=${name} t=${seconds(elapsedMilliseconds)} tick=${tickText(tick)} d=${decision}`;
}

/** `Shannon Minecraft stage task=<id> d=<decision> t=<s> stage=<1-4> pointed=<skills|-> offered=<skills with a gist|->` */
export function stageLine(task: string, decision: number, elapsedMilliseconds: number, stage: number, pointed: readonly string[],
  offered: readonly string[]): string {
  return `Shannon Minecraft stage task=${task} d=${decision} t=${seconds(elapsedMilliseconds)} stage=${stage} `
    + `pointed=${idList(pointed)} offered=${idList(offered)}`;
}
