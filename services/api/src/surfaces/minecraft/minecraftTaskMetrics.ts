import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { callTags, craftedOrderedTool, earlyGameLine, eatsFood, isFirstLook, minesIronOre, movesTo, toolOrderOk, villageDistance,
  type AdoptionTag } from './minecraftAdoptionTags.js';
import { closeGistDecision, gistAdoptionLine, noteGistCall, observeGistOutcomes, predicateSkills, showGists,
  type GistAdoptionEvent } from './minecraftGistAdoption.js';
import { BED_ITEM, carriedItemCounts, COOKED_FOOD, countMatching, EDIBLE_FOOD, type ItemCounts } from './minecraftItems.js';
import { milestoneLine, milestonesShown, minecraftStage, newlyReached, stageLine } from './minecraftMilestoneLog.js';
import { count, finite, readMetricsState, record, type MetricsState } from './minecraftMetricsState.js';
import { followedGists } from './minecraftSkillPointers.js';
import { adoptionTags } from './minecraftStage.js';

/**
 * Observation redesign P1: content-free measurement of one Minecraft task across its decisions (milestone first-reach, stage,
 * adoption tags, gist follow-through, observation gaps, survival). It only reads what the body and the decision already hold and
 * writes journal lines; nothing it computes reaches the model, the body or any decision. Its state is a closed, bounded object kept
 * in the task's checkpoint (`minecraftMetrics`), because each decision is a new step with a new adapter. A failure here is swallowed
 * by the caller: measuring never fails a step.
 */
const HUNGRY = 6;
/** A death a frame showed and the body's list entry for it, by the two clocks (the body's may differ from the API's by 30 s). */
const SAME_DEATH_MS = 60_000;

export interface MinecraftTaskMetricsParts { taskId: string; createdAt: string; kept: unknown; now(): number; log(line: string): void }
export interface MinecraftDecisionFields { skillPointers?: readonly string[]; skillGists?: ReadonlyArray<{ skill: string }> }
type Gap = { biome: 'set' | 'empty' | 'absent'; omitted: number; landmarks: boolean };

/** What a frame shows that the measurement reads (the world part of the observation, and the summary the model reads). */
function frameFacts(observation: BodyObservation, summary: BodyObservation | null) {
  const world = record(observation.state.world) ?? {}, counts: ItemCounts = carriedItemCounts(world, observation.facts);
  const factDimension = observation.facts.dimension;
  const dimension = typeof world.dimension === 'string' ? world.dimension : typeof factDimension === 'string' ? factDimension : null;
  // The summary the model reads ends a cut list with `{omitted: n}` (`minecraftObservationSummary`): the entities it left out.
  const shown = record(summary?.state.world)?.nearbyEntities, last = Array.isArray(shown) ? record(shown.at(-1)) : null;
  const biome = world.biome, landmarks = world.landmarks;
  const gap: Gap = { biome: typeof biome === 'string' && biome.trim() ? 'set' : biome === undefined ? 'absent' : 'empty',
    omitted: count(last?.omitted, 9_999), landmarks: Array.isArray(landmarks) ? landmarks.length > 0 : record(landmarks) !== null };
  return { counts, dimension, tick: finite(world.time), gap, village: villageDistance(landmarks), hungry: (finite(world.food) ?? 99) <= HUNGRY,
    edible: countMatching(counts, EDIBLE_FOOD) > 0 };
}

/** The first-reach lines already written by this process, so that a step that never committed and runs again does not repeat one. */
const logged = new Set<string>();
const logOnce = (key: string): boolean => {
  if (logged.has(key)) return false;
  if (logged.size >= 4_096) logged.clear();
  logged.add(key);
  return true;
};

export function createMinecraftTaskMetrics(parts: MinecraftTaskMetricsParts) {
  const state: MetricsState = readMetricsState(parts.kept), { taskId } = parts, began = Date.parse(parts.createdAt);
  const elapsed = () => Number.isFinite(began) ? Math.max(0, parts.now() - began) : 0;
  const emit = (line: string) => { try { parts.log(line); } catch { /* measuring never fails a step */ } };
  let decision = 0, flushed = false, ate = false, moved = false, hungry = false, edible = false, stage: number = 1;
  const tags: AdoptionTag[] = [], events: GistAdoptionEvent[] = [];
  let gap: Gap | null = null, village: number | null = null, iron: { food: boolean; bed: boolean } | null = null;
  const begin = () => {
    if (!decision) decision = state.d + 1;
    return decision;
  };
  const tag = (value: AdoptionTag) => {
    if (!tags.includes(value)) tags.push(value);
  };

  /** Called when the decision's body context is built (once per decision): milestones, stage, gaps, gist windows. */
  function context(observation: BodyObservation | null, summary: BodyObservation | null, fields: MinecraftDecisionFields): void {
    if (decision) return;
    const d = begin();
    if (!observation) return;
    const facts = frameFacts(observation, summary), { counts } = facts;
    for (const name of newlyReached(milestonesShown(counts, facts.dimension), new Set(state.reached))) {
      state.reached.push(name);
      if (logOnce(`${taskId}:${name}`)) emit(milestoneLine(taskId, name, elapsed(), facts.tick, d));
    }
    stage = minecraftStage(counts);
    const pointed = (fields.skillPointers ?? []).map(pointer => pointer.split('（')[0]!);
    const offered = (fields.skillGists ?? []).map(gist => gist.skill);
    emit(stageLine(taskId, d, elapsed(), stage, pointed, offered));
    events.push(...observeGistOutcomes(state.gist, d, counts), ...showGists(state.gist, d, offered, counts));
    ({ gap, village, hungry, edible } = facts);
    if (state.moved && state.village !== null && village !== null && village < state.village - 0.5) tag('village_going');
    state.food = Math.min(countMatching(counts, COOKED_FOOD), 9_999);
    state.bed = countMatching(counts, BED_ITEM) > 0;
  }

  /**
   * The cheap, frequent part (the monitor's poll): her lowest health, and deaths. A death is a frame that shows her dead, or a new
   * entry of the body's own list (`world.deaths`, `{at}` newest last): run 16's body came back at once, no polled frame ever showed
   * her dead, and the count stayed 0 after she died. A frame's death and the list's entry for it (within `SAME_DEATH_MS`, the two
   * clocks may differ) are one death; entries from before the task are none.
   */
  function sample(observation: BodyObservation): void {
    const world = record(observation.state.world);
    countListedDeaths(world?.deaths);
    if (observation.facts.alive === false) {
      if (state.alive !== false) {
        state.deaths = Math.min(state.deaths + 1, 999);
        state.deathAt = parts.now();
        state.deathByFrame = true;
      }
      state.alive = false;
      return;
    }
    if (observation.facts.alive === true) state.alive = true;
    const health = finite(world?.health);
    if (health !== null && health > 0 && (state.hpMin === null || health < state.hpMin)) state.hpMin = health;
  }
  function countListedDeaths(list: unknown): void {
    if (!Array.isArray(list)) return;
    const times = list.slice(-8).map(entry => Date.parse(String(record(entry)?.at ?? ''))).filter(Number.isFinite).sort((a, b) => a - b);
    for (const at of times) {
      const last = state.deathAt ?? (Number.isFinite(began) ? began : -Infinity);
      if (state.deathByFrame && state.deathAt !== null && Math.abs(at - state.deathAt) <= SAME_DEATH_MS) {
        state.deathByFrame = false;
        state.deathAt = Math.max(state.deathAt, at);
      } else if (at > last && (!state.deathByFrame || at > state.deathAt! + SAME_DEATH_MS)) {
        state.deaths = Math.min(state.deaths + 1, 999);
        state.deathAt = at;
        state.deathByFrame = false;
      }
    }
  }

  /** One body call of the decision, by name and arguments only. `shown` is the gists' tool names by skill (`minecraftSkillContext`). */
  function noteCall(name: string, input: unknown, shown: ReadonlyMap<string, ReadonlySet<string>>): void {
    const d = begin();
    if (isFirstLook(name, d)) tag('first_look');
    callTags(name, input).forEach(tag);
    ate = ate || eatsFood(name);
    moved = moved || movesTo(name);
    const crafted = craftedOrderedTool(name, input);
    if (crafted && !state.made.includes(crafted)) {
      state.made.push(crafted);
      if (toolOrderOk(state.made)) tag('tool_order_ok');
    }
    if (!state.ironDone && minesIronOre(name, input)) {
      state.ironDone = true;
      iron = { food: state.food >= 10, bed: state.bed };
      if (iron.food) tag('food_before_iron');
      if (iron.bed) tag('bed_before_iron');
    }
    // And a call that does what a shown skill is about, by tool and argument (`adoptionTags`): run 16 counted 1 follow in 27, for
    // 10 by this measure, because the draft-6 gists name no tool and their first moves are generic tools (mine-block, craft-one).
    // Measuring only: the skill's use (`gistFollowed`, which would hold its next revision as `on_trial`) is recorded as before.
    const attributed = new Set([...followedGists(shown, name), ...predicateSkills(name, input).filter(skill => shown.has(skill)),
      ...adoptionTags([...shown.keys()], { name, input }).map(adoption => adoption.skill)]);
    noteGistCall(state.gist, d, [...attributed]);
  }

  /**
   * The end of the decision (once): its tag, adoption and gap lines, and the survival counters up to it. Called from the body's
   * close, before the step commits: when the commit is fenced or the step is retried, the same `d` is measured again and its lines
   * repeat (the first-reach lines are deduplicated in process only). Readers dedupe by task, d and line kind.
   */
  function flush(): void {
    if (flushed || !decision) return;
    flushed = true;
    const d = decision, fresh = tags.filter(value => !state.tags.includes(value));
    if (hungry && edible && !ate) state.hungryNoEat = Math.min(state.hungryNoEat + 1, 999);
    if (stage < 4 || tags.length) emit(earlyGameLine(taskId, d, elapsed(), stage, tags, fresh, state.food, state.bed, iron));
    state.tags.push(...fresh);
    for (const event of [...events, ...closeGistDecision(state.gist, d)]) emit(gistAdoptionLine(taskId, d, event));
    if (gap) emit(gapLine(d, gap));
    state.moved = moved;
    if (gap) state.village = village;
    state.d = d;
  }

  function gapLine(d: number, shown: Gap): string {
    const hp = state.hpMin === null ? '-' : String(Math.round(state.hpMin * 10) / 10);
    return `Shannon Minecraft observation-gap task=${taskId} d=${d} biome=${shown.biome} entitiesOmitted=${shown.omitted} landmarks=${shown.landmarks} `
      + `died=${state.deaths > 0} deaths=${state.deaths} hpMin=${hp} hungryNoEat=${state.hungryNoEat}`;
  }

  return { context, sample, noteCall, flush,
    /** The state to keep in the task's checkpoint; nothing from a step that made no decision (the earlier state stays as it was). */
    checkpoint: (): Record<string, unknown> => decision ? { minecraftMetrics: { ...state, d: Math.max(state.d, decision) } } : {} };
}
export type MinecraftTaskMetrics = ReturnType<typeof createMinecraftTaskMetrics>;

/** The measurement of one step of a task, from the step's own checkpoint; its lines go to `log` (the journal when absent). */
export function stepMetrics(step: { taskId: string; snapshot: { task: { createdAt: unknown }; checkpoint: unknown } }, now: () => number,
  log: (line: string) => void = line => console.info(line)): MinecraftTaskMetrics {
  const kept = (step.snapshot.checkpoint as { minecraftMetrics?: unknown } | null)?.minecraftMetrics;
  return createMinecraftTaskMetrics({ taskId: step.taskId, createdAt: String(step.snapshot.task.createdAt), kept, now, log });
}
