import type { BodyObservation, BodyValue } from '../../contracts/bodyControlContract.js';
import { villageDistance } from './minecraftAdoptionTags.js';
import { BED_ITEM, carriedItemCounts, COOKED_FOOD, countMatching, EDIBLE_FOOD } from './minecraftItems.js';
import type { createPaceLedger } from './minecraftPaceLedger.js';
import { minecraftStage } from './minecraftStage.js';
import { minecraftTransientObservation } from './minecraftTransientObservation.js';

/**
 * The body part of a transient decision's live state (observation redesign P3, `SHANNON_FCA_OBS_MODE=transient`): what changes from
 * decision to decision and is worth reading again each time, in a turn-scoped system message that is never stored
 * (`anthropicFcaTransient.ts`): the observation, the pace (with the minutes since her last achievement and the last 15 minutes by kind
 * of call), the phase facts, the body's external jobs when its frame reports any, the skill pointers and gists, and a notice when the
 * same call failed the same way again. Closed facts only; the model reads it as data, never as an instruction.
 */
type Ledger = ReturnType<typeof createPaceLedger>;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const FOODS = 8, JOBS = 800, SURFACE_Y = 55;

/** The external jobs the world frame reports (a furnace and when it finishes): absent unless the body gives them. */
function jobsOf(world: Record<string, unknown>): BodyValue | undefined {
  const present = (item: unknown) => Array.isArray(item) ? item.length > 0 : !!record(item) && Object.keys(item as object).length > 0;
  const value = [world.jobs, world.activeFurnaces, world.backgroundJobs].find(present);
  return value !== undefined && JSON.stringify(value).length <= JOBS ? value as BodyValue : undefined;
}

/** What phase she is in, from what she carries and where she is: the shared `minecraftStage` and `carriedItemCounts`. */
export function minecraftPhaseFacts(observation: BodyObservation, elapsedMinutes: number | null): Record<string, unknown> {
  const world = record(observation.state.world) ?? {}, counts = carriedItemCounts(world, observation.facts);
  const food = [...counts].filter(([name]) => EDIBLE_FOOD.test(name)).slice(0, FOODS).map(([name, count]) => `${name}×${count}`);
  const biome = typeof world.biome === 'string' && world.biome.trim() ? world.biome : null;
  const fact = observation.facts.dimension;
  const dimension = typeof world.dimension === 'string' ? world.dimension : typeof fact === 'string' ? fact : null;
  const y = finite(record(world.position)?.y), places = record(world.rememberedPlaces);
  const villagePlace = places ? Object.keys(places).some(key => /村|village/iu.test(key)) : false;
  return { tier: minecraftStage(counts), hasBed: countMatching(counts, BED_ITEM) > 0, cookedFood: countMatching(counts, COOKED_FOOD),
    ...(food.length ? { foodItems: food } : { noFood: true }), villageKnown: villageDistance(world.landmarks) !== null || villagePlace, biome,
    onSurface: dimension === 'overworld' && y !== null ? y >= SURFACE_Y : null, elapsedMinutes };
}

export function minecraftTransientBody(parts: { observation: BodyObservation | null; pace: { elapsedMinutes: number | null } & Record<string, unknown>;
  fields: Record<string, unknown>; ledger: Ledger }): Record<string, unknown> {
  const { observation, pace, fields, ledger } = parts;
  ledger.use();
  const world = record(observation?.state.world) ?? {};
  if (observation) ledger.observe(carriedItemCounts(world, observation.facts));
  const { sameFailure, ...snapshot } = ledger.snapshot();
  const jobs = observation ? jobsOf(world) : undefined;
  return { ...(observation ? { observation: minecraftTransientObservation(observation) } : {}),
    pace: { ...pace, ...snapshot },
    ...(observation ? { phaseFacts: minecraftPhaseFacts(observation, pace.elapsedMinutes) } : {}),
    ...(jobs !== undefined ? { jobs } : {}), ...fields,
    ...(sameFailure ? { sameFailure: { ...sameFailure, note: `同じ失敗が${sameFailure.times}回続いています。場所・対象・周りを変えてから試す。` } } : {}) };
}
