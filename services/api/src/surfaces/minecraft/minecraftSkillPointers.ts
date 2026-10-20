import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { BED_ITEM, carriedItemCounts, countMatching, type ItemCounts } from './minecraftItems.js';
import { adoptionTags, adoptionTools, fed, milestoneLines, milestoneNow, minecraftStage, type MinecraftStage } from './minecraftStage.js';
export { milestoneFollowMemory } from './minecraftMilestoneFollow.js';
import { bedLead } from './minecraftBedLead.js';

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
 *
 * legacy-minecraft draft-6 (2026-10-19, Minecraft runs 14 and 15: `skill_read` was never called): a skill's numbered steps say how to
 * go on and why, without tool names, and its tools are named apart below them, so that the gist is the knowledge itself. A gist that
 * names no tool is followed by the tools of its skill's adoption calls (`adoptionTools`). Every decision also carries the owner's
 * order to the dragon as two lines, the step now and the next (`milestone`, `milestoneLines`), whether a skill is pointed or not.
 */
export interface MinecraftSituation {
  night: boolean; darkSoon: boolean; threatNear: boolean; lowHealth: boolean; hungry: boolean; stalled: boolean; idleWaiting: boolean;
  readyForNether: boolean; inNether: boolean; blazeNear: boolean;
  /**
   * A bed is worth looking for and she carries none: dusk is coming (dark in more than a minute and at most `BED_LEAD_SECONDS`,
   * overworld), or she is at stage 2 by day (no window: the whole day), and she has not looked for sheep and found none today.
   */
  bedWanted: boolean;
  /** The opening stage from what she carries (`minecraftStage`, recomputed at every decision); null outside the overworld. */
  stage: MinecraftStage | null;
  /** By day in the overworld and no threat near: the moments the stage pointers (not the safety ones) are offered in. */
  calm: boolean;
  /** In the End (`the_end`). */
  inEnd: boolean;
  /** The owner's order to the dragon: the step now and the next, in fixed words (`milestoneLines`); none without an observation. */
  milestone: string[];
  /** Stage 2 with no bed and the day's sheep search already given up (`noSheepDarkIn`): the bed waits, iron may go on. */
  bedGivenUp: boolean;
  /** In the overworld, no village looked for yet in this task (`villageSearched` false); absent where it is not tracked. */
  villageUnsearched?: boolean;
  /** A furnace job of hers whose time is up and that was not taken out (`world.jobs`, `verification_due`): what and where, or null. */
  furnaceDue?: string | null;
  /** What she dropped at her latest death and can still pick up (`recoverableDrops`), the first few as `name×n`, or null. */
  dropsLeft?: string | null;
  /** One more hit of a threat near takes her down (`world.margin.hitsLeft` at most 1): who hits that hard, or null. */
  oneHitFrom?: string | null;
  /** Food enough for iron (`fed`, `minecraftStage.ts`). */
  fed: boolean;
  /** Blaze rods or powder carried and fewer than `EYES_FOR_PORTAL` eyes of ender, outside the End: pearls and eyes to make. */
  eyesWanted: boolean;
  /**
   * In the overworld with eyes of ender: at least `EYES_TO_SEARCH` (throws break some), or any once no rod or powder is left to make
   * more (the frames take them one by one: the pointer must not go away while she fills them).
   */
  strongholdWanted: boolean;
  /** In the overworld at stage 6 or with eyes of ender, and no bow, fewer than `ARROWS` arrows or no carved pumpkin. */
  kitMissing: boolean;
  /** The name of the step now (`milestoneNow`); null without an observation. */
  milestoneName?: string | null;
  /** The step's procedure put first after daytime decisions that went elsewhere (`minecraftMilestoneFollow.ts`); set by the adapter. */
  milestoneSteps?: readonly string[];
  /** Fewer than twelve planks' worth of wood (`WOOD_PLANKS`, a log is four): the first day's pointer stays at stage 2 (run 18). */
  woodShort?: boolean;
  /** No bed of hers yet and a bed or a village she knows of to go to first (`minecraftBedLead.ts`, run 19), as one line, or null. */
  bedLead?: string | null;
}
/**
 * A pointer names its skill and the skills it succeeds (legacy-minecraft draft-6, 2026-10-19): the first of `skills` she can read now
 * is pointed. Before draft-6 is imported the old skill is pointed as before; after it, the new one. A skill pointed by two pointers is
 * named once, at the first.
 */
type Pointer = { skills: readonly string[]; when: string; applies(situation: MinecraftSituation): boolean };
const FOOD_BED = 'mc-food-and-bed';
const POINTERS: readonly Pointer[] = Object.freeze([
  // Safety first, then the Nether path, and food and pace last (review of 0efd5acb: they must not push the Nether ones out).
  // mc-night-shelter (draft-9) is the night retreat's successor: the retreat was used in run 17 and cannot be revised while on trial.
  { skills: ['mc-night-shelter', 'mc-night-retreat'], when: '夜・暗くなる直前・敵が近い', applies: s => s.night || s.darkSoon || s.threatNear },
  { skills: ['mc-low-health'], when: '体力が半分以下', applies: s => s.lowHealth },
  // Bed first (owner 2026-10-17): the window before dark in which a bed can still be found, ahead of the Nether path (it has a deadline).
  // It ends where `mc-night-retreat` begins (`darkSoon`: the last minute), so the two are never offered for the same dusk, and a
  // threat near (retreat's own trigger) closes it at once: the search is given up and the retreat takes over, by the facts alone.
  { skills: [FOOD_BED, 'mc-bed-before-night'], when: '日暮れまでにベッドが要る', applies: s => s.bedWanted && !s.threatNear },
  { skills: ['mc-end-fight'], when: 'エンドにいる', applies: s => s.inEnd },
  { skills: ['mc-nether-travel'], when: 'ネザーにいる', applies: s => s.inNether },
  { skills: ['mc-blaze-rods'], when: 'ネザーでブレイズが近い', applies: s => s.blazeNear },
  { skills: ['mc-stronghold'], when: 'エンダーアイがあり要塞を探す前', applies: s => s.strongholdWanted },
  { skills: ['mc-ender-eyes'], when: 'ブレイズロッドがありエンダーアイが12個に足りない', applies: s => s.eyesWanted },
  // Diamonds, obsidian and the portal (draft-6) from the bucket on; the old Nether skill until then, from the same moment.
  { skills: ['mc-diamond-obsidian', 'mc-nether-portal'], when: '鉄のツルハシ・バケツ・全身の防具がありネザーへ向かう前', applies: s => s.readyForNether },
  { skills: ['mc-food-and-pace'], when: '空腹・進展が止まった・待ちが続いた', applies: s => s.hungry || s.stalled || s.idleWaiting },

  // The stage pointers (observation redesign P7) take the calm slots that are left: the bed above is stage 2's, and the Nether
  // path is stage 5's and 6's (`readyForNether`); the safety ones keep their priority and the three-slot limit holds.
  { skills: ['mc-first-day', 'mc-early-toolchain'], when: '石のツルハシがまだ無い', applies: s => s.calm && s.stage === 1 },
  // Run 18: the stone pickaxe took the first day's pointer away with 2 logs and 3 planks, and the wood never came (D45: no planks
  // for a pickaxe). It stays at stage 2 while the wood is short.
  { skills: ['mc-first-day'], when: '木材が板材12枚分に足りない', applies: s => s.calm && s.stage === 2 && s.woodShort === true },
  { skills: [FOOD_BED, 'mc-opening-scout'], when: '石のツルハシがあり食料かベッドが無い昼', applies: s => s.calm && s.stage === 2 && !(s.bedGivenUp && s.fed) },
  // Iron from stage 3, and at stage 2 once the day's sheep search found none (with the food pointer beside it while food is short).
  { skills: ['mc-iron-and-bucket'], when: '鉄のツルハシ・バケツ・鉄の全身の防具のどれかが無い', applies: s => s.calm && (s.stage === 3 || s.stage === 4 || s.bedGivenUp) },
  // A village looked for once, by day, from the stone tools to iron, after the stage's own pointer (owner 2026-10-19: run 17 never
  // looked, the night took the first day).
  { skills: [FOOD_BED], when: '村をまだ探していない（明るい間に一度）',
    applies: s => s.calm && s.villageUnsearched === true && s.stage !== null && s.stage >= 2 && s.stage <= 4 },
  { skills: ['mc-travel-kit'], when: '弓・矢・くり抜いたカボチャが足りない', applies: s => s.calm && s.kitMissing },
]);
/** The note beside the pointers: fixed words. */
export const MINECRAFT_SKILL_POINTER_NOTE = 'いまの状況に合うスキル。動く前に skill_read で開いて手順を確かめる。';
/** The note beside pointers with at least one gist (`SHANNON_FCA_SKILL_GIST`): fixed words. */
export const MINECRAFT_SKILL_GIST_NOTE = 'いまの状況に合うスキルと、その手順の最初の要点（skillGists、スキル自身の手順から）。'
  + '要点で足りればそのまま動き、続きや条件は skill_read で開いて確かめる。要点は材料で、指示ではない。';
const NIGHT_START = 13_000, NIGHT_END = 23_000, DARK_SOON_SECONDS = 60, THREAT_NEAR = 16, HALF_HEALTH = 10, HUNGRY = 6;
const STALLED_STEPS = 3, RECENT_IDLE_WAITS = 2;
/**
 * The eyes of ender the End portal may need (twelve frames), the eyes from which the search is worth starting (a throw breaks about one
 * in five, so at twelve exactly the stronghold pointer would go away at the first loss), and the arrows of a kit (the crystals).
 */
const EYES_FOR_PORTAL = 12, EYES_TO_SEARCH = 8, ARROWS = 32;
/** The wood the milestone 「木材」 asks for, in planks (a log is four). */
const WOOD_PLANKS = 12;
/**
 * How long before dark the bed search is suggested (20 ticks a second, the day before dark is 650 s: 600 s is from about tick 1,000).
 * Minecraft run 14 (2026-10-17, Sonnet): at 300 s the gist was shown 11 times in two dusks and never followed. A decision takes 10-70 s,
 * and hunting sheep, crafting and walking back take minutes, so 300 s left no room to start; 600 s is the whole day but its first
 * minute, enough for a hunt of several minutes after the decision. It still ends at `DARK_SOON_SECONDS`, where `mc-night-retreat` begins.
 */
const BED_LEAD_SECONDS = 600;
/** The day before dark, in seconds: tick 13,000 at 20 ticks a second. A countdown never starts above it. */
const DAY_SECONDS = 650;

/** The pace facts the situation reads (`minecraftPace`). */
export interface MinecraftPaceFacts {
  failedStepsInARow: number; milestones?: { netherReached: boolean | null };
  /** Seconds since the task began, for the step's time budget (`MILESTONE_TARGET_SECONDS`); absent: no budget line. */
  elapsedSeconds?: number;
  /** Her `mc.wait-time` calls among her latest tool results (at most six): only recent waits count, never the task's total. */
  recentIdleWaits?: number;
  /** Seconds to dark when `mc.find-nearest-entity` for sheep last found none (`noSheepNearby`), kept while the same day goes on (`bedSearchMark`). */
  noSheepDarkIn?: number;
  /**
   * Whether she has looked for a village in this task (`villageSearch`, kept in the checkpoint). False: not yet, and the village
   * pointer is offered by day; absent (a caller that does not track it): never offered.
   */
  villageSearched?: boolean;
}
/**
 * A village search of hers: `explore-for-structure` for a village that answered (found or not); `find-structure` reads the loaded
 * chunks only and is no search. Owner 2026-10-19, Minecraft run 17: the night took the first day, and no village was looked for
 * after dawn either (0 searches in 30 minutes).
 */
export function villageSearch(call: { name: string; input: unknown }, result: { ok: boolean }): boolean {
  const type = record(call.input)?.structureType;
  return result.ok && call.name === 'mc.explore-for-structure' && typeof type === 'string' && type.toLowerCase() === 'village';
}

/**
 * The task's "no sheep near" mark: from the checkpoint, to the pace facts, to a search result, and back to the checkpoint; and
 * whether she has looked for a village in the task (`villageKept`, `villageSearch`), kept the same way.
 */
export function bedSearchMemory(kept: unknown, villageKept?: unknown) {
  const start = Number(kept);
  let mark: number | undefined = Number.isFinite(start) && start > 0 ? start : undefined, village = villageKept === true;
  return {
    /** The pace fact, after the mark has met the observation (a new day clears it). */
    facts(observation: BodyObservation | null): Pick<MinecraftPaceFacts, 'noSheepDarkIn' | 'villageSearched'> {
      mark = bedSearchMark(mark, observation);
      return { ...(mark === undefined ? {} : { noSheepDarkIn: mark }), villageSearched: village };
    },
    note(call: { name: string; input: unknown }, result: { ok: boolean; text: string }, observe: () => BodyObservation | null): void {
      if (noSheepNearby(call, result)) mark = bedSearchGivenUp(observe()) ?? mark;
      if (villageSearch(call, result)) village = true;
    },
    /** Always carries the key: the runner merges a step's checkpoint over the prior one, so a cleared mark must overwrite it with `null` (read as no mark). */
    checkpoint(): { minecraftNoSheepDarkIn: number | null; minecraftVillageSearched: boolean } {
      return { minecraftNoSheepDarkIn: mark ?? null, minecraftVillageSearched: village };
    },
  };
}
/** Seconds to dark in the observation (the body's margin, else the time of day); `Infinity` when unknown, at night or not the overworld. */
export function darkInSeconds(observation: BodyObservation | null): number {
  const world = record(observation?.state.world) ?? {};
  return world.dimension === 'overworld' || observation?.facts?.dimension === 'overworld' ? untilDark(world) : Infinity;
}

/**
 * The fixed phrase the body's `mc.find-nearest-entity` answers with when nothing of the type is within range (Minebot
 * `findNearestEntity.ts`, a success whose text says "…は見つかりませんでした"). If the body words it differently, nothing is marked and
 * the pointer behaves as before.
 */
const NONE_FOUND = /エンティティは見つかりませんでした/u;
/** A search of the default range (64) or at least `MIN_SHEEP_RANGE`: a short look (`maxDistance` 8) that found none says nothing about the day. */
const MIN_SHEEP_RANGE = 32;
const searchedFar = (range: unknown): boolean => range === undefined || range === null || (typeof range === 'number' && range >= MIN_SHEEP_RANGE);
/** Whether a finished call is a search for sheep that found none. A fact of the call and its result, not a judgment of her content. */
export function noSheepNearby(call: { name: string; input: unknown }, result: { ok: boolean; text: string }): boolean {
  const type = record(call.input)?.entityType, range = record(call.input)?.maxDistance;
  return call.name === 'mc.find-nearest-entity' && result.ok && typeof type === 'string' && type.toLowerCase() === 'sheep'
    && searchedFar(range) && NONE_FOUND.test(result.text);
}
/**
 * The mark of "no sheep near" for the rest of the day: kept while the countdown to dark only falls; a rise (a new day, or after
 * dark) clears it. Marked only below the full day's 650 s (`bedSearchGivenUp`), so that the next morning's first reading is above it.
 * Outside the overworld the countdown is `Infinity`, which also clears it (accepted: she is elsewhere, and the next search marks again).
 */
export function bedSearchMark(mark: number | undefined, observation: BodyObservation | null): number | undefined {
  if (!observation) return mark;
  return mark !== undefined && darkInSeconds(observation) <= mark ? mark : undefined;
}
/**
 * The value to mark with at a search that found none: the seconds to dark now, at any time of the day but its very start (the
 * stage-2 bed pointer has no window: before P7 only the last `BED_LEAD_SECONDS` were marked). Always below `DAY_SECONDS`, so that
 * the next morning's first reading is above the mark and clears it.
 */
export function bedSearchGivenUp(observation: BodyObservation | null): number | undefined {
  const now = darkInSeconds(observation);
  return Number.isFinite(now) && now > 0 && now < DAY_SECONDS ? now : undefined;
}

export function minecraftSituation(observation: BodyObservation | null, pace: MinecraftPaceFacts): MinecraftSituation {
  const world = record(observation?.state.world) ?? {};
  const facts = observation?.facts ?? {};
  const dimension = dimensionOf(world, facts);
  const overworld = dimension === 'overworld', nether = dimension === 'the_nether';
  // What she carries: the body's {name, count} stacks (the real frame) and the name×count strings, as the measurement logs read it.
  // The real frame holds objects; only strings were read before P7, so the stage and the bed check saw (almost) nothing.
  const items = withRecoverableDrops(carriedItemCounts(world, facts), world), dark = darkness(world, overworld), darkIn = untilDark(world);
  // The dragon is the End's aim, not a reason to retreat; an enderman is no threat unless looked at.
  const threatNear = entityNear(list(world.nearbyThreats), name => name !== 'enderman' && name !== 'ender_dragon', THREAT_NEAR);
  const stage = overworld ? minecraftStage(items) : null;
  // By day: not night, not the last minute (where `mc-night-retreat` begins), and the clock (if it is known) is not past dusk.
  const day = overworld && !dark.night && !dark.darkSoon && darkIn > DARK_SOON_SECONDS;
  return {
    ...dark,
    threatNear, stage, calm: day && !threatNear, villageUnsearched: overworld && pace.villageSearched === false, furnaceDue: furnaceDue(world.jobs),
    ...stepNow(observation, world, items, dimension, pace.milestones?.netherReached === true, pace.elapsedSeconds),
    oneHitFrom: threatNear ? oneHitFrom(world.margin) : null, dropsLeft: dropsLine(world),
    lowHealth: atMost(world.health, HALF_HEALTH), hungry: atMost(world.food, HUNGRY),
    stalled: pace.failedStepsInARow >= STALLED_STEPS, idleWaiting: (pace.recentIdleWaits ?? 0) >= RECENT_IDLE_WAITS,
    inNether: nether, inEnd: dimension === 'the_end',
    blazeNear: nether && entityNear([...list(world.nearbyThreats), ...list(world.nearbyEntities)], name => name === 'blaze', 48),
    ...openingPath(items, stage, darkIn, day, pace),
    ...laterPath(items, dimension, stage),
  };
}

/** The owner's order now (its lines and its name), and the wood short of the step 「木材」. */
function stepNow(observation: BodyObservation | null, world: Record<string, unknown>, items: ItemCounts, dimension: string, netherReached: boolean,
  elapsedSeconds?: number)
  : Pick<MinecraftSituation, 'milestone' | 'milestoneName' | 'woodShort' | 'bedLead'> {
  const facts = { counts: items, dimension, netherReached, bedPlaced: typeof record(world.rememberedPlaces)?.respawn === 'string' };
  const bedless = dimension === 'overworld' && !facts.bedPlaced && countMatching(items, BED_ITEM) === 0;
  return { milestone: observation ? milestoneLines(facts, elapsedSeconds) : [], milestoneName: observation ? milestoneNow(facts).now.name : null,
    woodShort: dimension === 'overworld' && countMatching(items, /_log$/u) * 4 + countMatching(items, /_planks$/u) < WOOD_PLANKS,
    bedLead: bedless ? bedLead(world) : null };
}

/** The overworld opening up to the Nether: the bed before dark, the day's sheep search given up, food enough, the portal (null stage: elsewhere). */
function openingPath(items: ItemCounts, stage: MinecraftStage | null, darkIn: number, day: boolean, pace: MinecraftPaceFacts)
  : Pick<MinecraftSituation, 'bedWanted' | 'bedGivenUp' | 'fed' | 'readyForNether'> {
  const sheepGivenUp = pace.noSheepDarkIn !== undefined && darkIn <= pace.noSheepDarkIn;
  return {
    bedWanted: stage !== null && bedWanted(items, darkIn, stage === 2 && day, sheepGivenUp),
    bedGivenUp: stage === 2 && countMatching(items, BED_ITEM) === 0 && sheepGivenUp, fed: fed(items),
    readyForNether: stage !== null && stage >= 5 && pace.milestones?.netherReached !== true,
  };
}

/** The path after the Nether, from what she carries: the eyes to make, the stronghold to find, the kit to finish. */
function laterPath(items: ItemCounts, dimension: string, stage: MinecraftStage | null)
  : Pick<MinecraftSituation, 'eyesWanted' | 'strongholdWanted' | 'kitMissing'> {
  const overworld = dimension === 'overworld';
  const eyes = countMatching(items, /^ender_eye$/u), blaze = countMatching(items, /^blaze_(?:rod|powder)$/u);
  const kitShort = countMatching(items, /^bow$/u) === 0 || countMatching(items, /^arrow$/u) < ARROWS || countMatching(items, /^carved_pumpkin$/u) === 0;
  return {
    eyesWanted: dimension !== 'the_end' && blaze > 0 && eyes < EYES_FOR_PORTAL,
    strongholdWanted: overworld && eyes > 0 && (eyes >= EYES_TO_SEARCH || blaze === 0),
    kitMissing: overworld && (stage === 6 || eyes > 0) && kitShort,
  };
}

/**
 * Lines a decision carries beside the milestone, fixed words with closed facts: one more hit takes her down (owner 2026-10-19,
 * Minecraft run 17: "one hit left" was shown for D25-D35 and she waited, ran 2 m, fought and walked to a furnace), and a furnace
 * job left uncollected.
 */
function reminders(situation: MinecraftSituation): { reminders?: string[] } {
  const lines = [...(situation.dropsLeft ? [`死んだ所に落とし物が残っている（${situation.dropsLeft}）。消える前に拾いに戻る（recall-places の死亡地点、pickup-nearest-item）`] : []),
    // By day with no threat near: the bed or the village to go to before the sheep (run 19).
    ...(situation.calm && situation.bedLead ? [situation.bedLead] : []),
    ...(situation.oneHitFrom ? [`あと1撃で倒れる（${situation.oneHitFrom}）。開けた所で待たない: 離れる（flee-from）・3段上る（tower-up）・囲う（build-around-self）のどれか`] : []),
    ...(situation.furnaceDue ? [`かまどの${situation.furnaceDue}は焼き上がりの時刻を過ぎた。離れる前に withdraw-from-furnace で取り出す`] : [])];
  return lines.length ? { reminders: lines } : {};
}
function dropsLine(world: Record<string, unknown>): string | null {
  const drops = recoverableDrops(world);
  return drops ? [...drops].slice(0, 4).map(([name, count]) => `${name}×${count}`).join('・') : null;
}
/** Who takes her down with one more hit (`margin.hitsLeft`: `{from, hits}`), or null. */
export function oneHitFrom(margin: unknown): string | null {
  const hits = record(record(margin)?.hitsLeft);
  const from = typeof hits?.from === 'string' && /^[a-z_]{1,40}$/u.test(hits.from) ? hits.from : null;
  return from && typeof hits?.hits === 'number' && hits.hits <= 1 ? from : null;
}
/**
 * Her first furnace job whose time is up and that is still in the furnace (`world.jobs` with `verification_due`), as `porkchop×7
 * (12,84,119)`. Owner 2026-10-19, Minecraft run 17: seven cooked porkchops were left in a furnace from D41 to the end.
 */
function furnaceDue(jobs: unknown): string | null {
  const due = list(jobs).map(record).find(job => job?.status === 'verification_due' && record(job.position));
  if (!due) return null;
  const at = record(due.position)!, where = [at.x, at.y, at.z].map(value => Math.round(Number(value)));
  const item = typeof due.input === 'string' && /^[a-z0-9_]{1,40}$/u.test(due.input) ? due.input : '中身';
  return where.every(Number.isFinite) ? `${item}×${Math.max(0, Math.round(Number(due.count) || 0))}（${where.join(',')}）` : null;
}
/**
 * What she carries with what she dropped at her latest death while it can still be picked up (owner 2026-10-19, Minecraft run 17:
 * right after each death she carried nothing, and the stage and the milestone went back to the first wood at D16 and D36). The body's
 * `world.lastDeath` is said while the drops last; it says when they are gone or none were dropped. `world.deaths` lists `name×n`.
 */
export function withRecoverableDrops(items: ItemCounts, world: Record<string, unknown>): ItemCounts {
  const dropped = recoverableDrops(world);
  if (!dropped) return items;
  // The larger of what she carries and what she dropped: once she picks it up it is counted once, not twice.
  const merged = new Map(items);
  for (const [name, count] of dropped) merged.set(name, Math.max(merged.get(name) ?? 0, count));
  return merged;
}
/**
 * The drops of her latest death while the body says they can still be picked up (`lastDeath` ends `拾いに戻れる`) in this dimension,
 * or null. Anything else (gone, despawned, none dropped, another dimension, an older wording) is no drop.
 */
function recoverableDrops(world: Record<string, unknown>): ItemCounts | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath : '';
  const death = record((Array.isArray(world.deaths) ? world.deaths : []).at(-1)), lost = death?.lostItems;
  if (!/拾いに戻れる/u.test(said) || !Array.isArray(lost) || !lost.length) return null;
  if (typeof death?.dimension === 'string' && typeof world.dimension === 'string' && death.dimension !== world.dimension) return null;
  return carriedItemCounts({ inventory: lost.filter(item => typeof item === 'string').slice(0, 64) }, {});
}
function dimensionOf(world: Record<string, unknown>, facts: Readonly<Record<string, unknown>>): string {
  return typeof world.dimension === 'string' ? world.dimension : typeof facts.dimension === 'string' ? facts.dimension : '';
}
/**
 * A bed is wanted when she carries none, has not looked for sheep and found none today (`noSheepDarkIn`: the gist's own "give up for today"),
 * and it is dusk (the window, for anyone) or she is at stage 2 by day (no window at all).
 */
function bedWanted(items: ItemCounts, darkIn: number, stageTwoByDay: boolean, sheepGivenUp: boolean): boolean {
  if (countMatching(items, BED_ITEM) > 0 || sheepGivenUp) return false;
  return stageTwoByDay || (darkIn > DARK_SOON_SECONDS && darkIn <= BED_LEAD_SECONDS);
}

/** Night (time of day 13,000–23,000 ticks) and dark within a minute, in the overworld only. */
function darkness(world: Record<string, unknown>, overworld: boolean): Pick<MinecraftSituation, 'night' | 'darkSoon'> {
  const ticks = Number(world.time), darkIn = Number(record(world.margin)?.darkInSeconds);
  const timeOfDay = Number.isFinite(ticks) ? ((ticks % 24_000) + 24_000) % 24_000 : null;
  return { night: overworld && timeOfDay !== null && timeOfDay >= NIGHT_START && timeOfDay < NIGHT_END,
    darkSoon: overworld && Number.isFinite(darkIn) && darkIn >= 0 && darkIn <= DARK_SOON_SECONDS };
}
/** Seconds until dark: the body's own margin, else the time of day (before tick 13,000, 20 ticks a second); `Infinity` when unknown or after dark. */
function untilDark(world: Record<string, unknown>): number {
  const margin = Number(record(world.margin)?.darkInSeconds), ticks = Number(world.time);
  if (record(world.margin)?.darkInSeconds !== undefined && Number.isFinite(margin)) return margin;
  const timeOfDay = Number.isFinite(ticks) ? ((ticks % 24_000) + 24_000) % 24_000 : null;
  return timeOfDay !== null && timeOfDay < NIGHT_START ? (NIGHT_START - timeOfDay) / 20 : Infinity;
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
/** The pointers of a situation, only to skills in `skillNames`, at most three, in a fixed order. */
export function minecraftSkillPointers(situation: MinecraftSituation, skillNames: ReadonlySet<string>): string[] {
  return matching(situation, skillNames).map(pointer => `${pointer.skill}（${pointer.when}）`);
}
/** Each applying pointer's first readable skill, each skill once (at its first pointer), at most three. */
function matching(situation: MinecraftSituation, skillNames: ReadonlySet<string>): Array<{ skill: string; when: string }> {
  const matched: Array<{ skill: string; when: string }> = [];
  for (const pointer of POINTERS) {
    const skill = pointer.skills.find(name => skillNames.has(name));
    if (skill && !matched.some(item => item.skill === skill) && pointer.applies(situation)) matched.push({ skill, when: pointer.when });
  }
  return matched.slice(0, 3);
}

/** One pointed skill's gist as the decision's body carries it. */
export interface MinecraftSkillGist { skill: string; steps: readonly string[] }
/** The gists of the named skills, by name (the wiring's `fcaSkillGists`): only those it could open and pin now. */
export type SkillGistsPort = (names: readonly string[]) => ReadonlyMap<string, readonly string[]>;
export interface MinecraftSkillContext {
  /**
   * The body's pointer fields: none on a calm moment but the milestone; with no gist shown, `skillPointers` and `skillPointerNote` as
   * before. `milestone`: the owner's order (the step now and the next), on every decision with an observation.
   */
  fields: { milestoneSteps?: string[]; skillPointers?: string[]; skillGists?: MinecraftSkillGist[]; skillPointerNote?: string; milestone?: string[];
    reminders?: string[] };
  /** The body tools each shown gist names, by skill (`gistToolNames`); for a gist that names none, its skill's specific adoption tools. */
  gistTools: ReadonlyMap<string, ReadonlySet<string>>;
  /** The names of the skills pointed at this decision (shown or not), for `adoptionTags`. */
  pointed: readonly string[];
}

/** The pointers of a situation and, with `gists`, the gist of each pointed skill that has one. */
export function minecraftSkillContext(situation: MinecraftSituation, skillNames: ReadonlySet<string>, gists?: SkillGistsPort): MinecraftSkillContext {
  const matched = matching(situation, skillNames);
  const skillPointers = matched.map(pointer => `${pointer.skill}（${pointer.when}）`);
  const pointed = matched.map(pointer => pointer.skill);
  const milestone = { ...(situation.milestone.length ? { milestone: [...situation.milestone] } : {}),
    ...reminders(situation) };
  // The step's procedure goes first, ahead of the pointers and their gists (never a gist: a use would hold a skill's revision).
  const head = situation.milestoneSteps?.length ? { milestoneSteps: [...situation.milestoneSteps] } : {};
  if (!matched.length) return { fields: { ...head, ...milestone }, gistTools: new Map(), pointed };
  const shown = gists?.(pointed) ?? new Map<string, readonly string[]>();
  const skillGists = matched.flatMap(pointer => shown.get(pointer.skill)?.length ? [{ skill: pointer.skill, steps: [...shown.get(pointer.skill)!] }] : []);
  if (!skillGists.length) {
    return { fields: { ...head, skillPointers, skillPointerNote: MINECRAFT_SKILL_POINTER_NOTE, ...milestone }, gistTools: new Map(), pointed };
  }
  const gistTools = new Map(skillGists.map(gist => [gist.skill, followedBy(gist)] as const));
  return { fields: { ...head, skillPointers, skillGists, skillPointerNote: MINECRAFT_SKILL_GIST_NOTE, ...milestone }, gistTools, pointed };
}
/** The tools a shown gist is followed by: those it names, else (a gist of how to go on, draft-6) its skill's specific adoption tools. */
function followedBy(gist: MinecraftSkillGist): Set<string> {
  const named = gistToolNames(gist.steps);
  return named.size ? named : new Set([...adoptionTools(gist.skill)].filter(name => !GENERIC_BODY_TOOLS.has(name)));
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

/**
 * `Shannon Minecraft gist follow task=<id> tool=<name> branch=<branch> skills=<skills|->`: which branch applied to a call made while a
 * gist was shown. `adopted`: no tool of the gist, but a call that does what a shown skill is about (tool and argument, `adoptionTags`),
 * counted as followed by the measurement and not recorded as a use (a use would hold the skill's next revision as `on_trial`).
 */
export function gistFollowLine(taskId: string, call: { name: string; input: unknown }, gistTools: ReadonlyMap<string, ReadonlySet<string>>,
  facts: { port: boolean; skill: { readOnly?: boolean } | undefined; followed: readonly string[] }): string {
  const { skill, followed } = facts, { name } = call;
  const adopted = followed.length ? [] : [...new Set(adoptionTags([...gistTools.keys()], call).map(item => item.skill))];
  // `adopted` before `read_only`: the measurement counts a search for sheep or iron as a follow too, and the line says the same.
  const branch = !facts.port ? 'no_port' : !skill ? 'not_legacy_pack' : followed.length ? 'recorded' : adopted.length ? 'adopted'
    : skill.readOnly ? 'read_only' : GENERIC_BODY_TOOLS.has(name) ? 'generic_tool' : 'not_named_by_gist';
  const skills = followed.length ? followed.join(',') : adopted.length ? adopted.join(',') : '-';
  return `Shannon Minecraft gist follow task=${taskId} tool=${name} branch=${branch} skills=${skills}`;
}

/** Skill names from her skill index (`- name（…`), as `skillIndex` writes it. */
export function skillNamesOfIndex(index: string): Set<string> {
  return new Set([...index.matchAll(/^- ([a-z0-9][a-z0-9-]{0,63})（/gmu)].map(match => match[1]!));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
