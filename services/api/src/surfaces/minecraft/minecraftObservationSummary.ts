import type { BodyFact, BodyObservation, BodyValue } from '../../contracts/bodyControlContract.js';
import { jobsLine, reflexesLine } from './minecraftObservationReflexes.js';

/**
 * What a decision of a Minecraft task carries about the body: a bounded summary of the latest observation, never the whole
 * world frame. Each decision's message is kept in the task's history, and the whole frame (entities with positions, landmarks,
 * remembered places, containers) made a first round about 43,000 characters on its own (Minebot lane 2026-10-14, task
 * ecf64b3e). The whole observation stays one call away: `minecraft.observe` returns it as a tool result.
 */
export const MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS = 6_000;
export const MINECRAFT_OBSERVATION_DETAIL = '要約した観測。周囲の存在・目印・記憶した場所・容器などの全体は minecraft.observe で読む。';

const SMALL_VALUE = 600, LIST = 8, INVENTORY = 36, FACTS = 2_500, TEXT = 200;
const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
const scalar = (value: BodyValue | undefined): value is BodyFact => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const record = (value: BodyValue | undefined): value is { readonly [key: string]: BodyValue } => !!value && typeof value === 'object' && !Array.isArray(value);
/** A long text cut at `TEXT`, never between the halves of a surrogate pair: a lone half is refused by the provider (review P2-1). */
const text = (value: BodyFact): BodyFact => {
  if (typeof value !== 'string' || value.length <= TEXT) return value;
  const keep = /[\uD800-\uDBFF]/u.test(value[TEXT - 1] ?? '') ? TEXT - 1 : TEXT;
  return `${value.slice(0, keep)}…`;
};

/** A list's first few entries, each reduced to the named scalar fields, with how many were left out. */
function listed(value: BodyValue | undefined, fields: readonly string[], limit: number): BodyValue | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = (value as readonly BodyValue[]).slice(0, limit).map(item => record(item)
    ? Object.fromEntries(fields.flatMap(field => scalar(item[field]) ? [[field, text(item[field] as BodyFact)]] : []))
    : scalar(item) ? text(item) : null);
  return value.length > limit ? [...items, { omitted: value.length - limit }] : items;
}

/** One inventory stack as `name×count`, with durability when the frame gives it. */
function stack(entry: { readonly [key: string]: BodyValue }): string {
  const count = typeof entry.count === 'number' ? entry.count : '?';
  const durability = record(entry.durability) ? `(耐久${String(entry.durability.left)}/${String(entry.durability.max)})` : '';
  return `${String(entry.name)}×${count}${durability}`;
}

/** The world frame's scalar vitals, position and short lists; every other part is named under `omitted`. */
function world(value: { readonly [key: string]: BodyValue }, omitted: string[]): Record<string, BodyValue> {
  const out: Record<string, BodyValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'facts' || key === 'observedAt') continue;
    if (scalar(item)) out[key] = text(item);
    else if (key === 'inventory' && Array.isArray(item)) {
      const entries = (item as readonly BodyValue[]).flatMap(entry => record(entry) && typeof entry.name === 'string' ? [stack(entry)] : []);
      out.inventory = entries.length > INVENTORY ? [...entries.slice(0, INVENTORY), `ほか${entries.length - INVENTORY}種`] : entries;
    } else if (key === 'nearbyThreats') out[key] = listed(item, ['name', 'distance', 'secondsToContact', 'canReachMe'], 5)!;
    else if (key === 'nearbyEntities') out[key] = listed(item, ['name', 'kind', 'distance'], LIST)!;
    else if (key === 'reflexes' && reflexesLine(item)) out[key] = reflexesLine(item)!;
    else if (key === 'jobs' && jobsLine(item)) out[key] = jobsLine(item)!;
    else if (size(item) <= SMALL_VALUE) out[key] = item!;
    else omitted.push(`world.${key}`);
  }
  return out;
}

/** The adapter-normalized facts in their order, up to a bound; they are what candidates and preconditions are checked on. */
function boundedFacts(facts: Readonly<Record<string, BodyFact>>, omitted: string[]): Record<string, BodyFact> {
  const out: Record<string, BodyFact> = {};
  let used = 2, dropped = 0;
  for (const [key, value] of Object.entries(facts)) {
    const cost = size(key) + size(text(value)) + 2;
    if (used + cost > FACTS) {
      dropped++;
      continue;
    }
    out[key] = text(value);
    used += cost;
  }
  if (dropped) omitted.push(`facts(${dropped})`);
  return out;
}

export function minecraftObservationSummary(observation: BodyObservation): BodyObservation {
  const omitted: string[] = [];
  const facts = boundedFacts(observation.facts, omitted);
  const state: Record<string, BodyValue> = {};
  for (const [key, value] of Object.entries(observation.state)) {
    if (key === 'world' && record(value)) state.world = world(value, omitted);
    else if (scalar(value) || size(value) <= SMALL_VALUE) state[key] = scalar(value) ? text(value) : value;
    else omitted.push(key);
  }
  const summary = (): BodyObservation => ({ schemaVersion: observation.schemaVersion, bodyId: observation.bodyId, sequence: observation.sequence,
    stateAt: observation.stateAt, receivedAt: observation.receivedAt, connected: observation.connected,
    state: { ...state, detail: MINECRAFT_OBSERVATION_DETAIL, ...(omitted.length ? { omitted: [...omitted] } : {}) },
    facts });
  // Still too long (an unusual frame): drop the largest summarized parts, naming each, until it fits.
  let result = summary();
  while (size(result) > MINECRAFT_OBSERVATION_SUMMARY_CHARACTERS) {
    const worldPart = record(state.world) ? state.world as Record<string, BodyValue> : {};
    const paths = [...Object.keys(worldPart).filter(key => !scalar(worldPart[key])).map(key => `world.${key}`),
      ...Object.keys(state).filter(key => key !== 'world' && !scalar(state[key]))];
    if (!paths.length) break;
    const largest = paths.reduce((best, path) => size(lookup(state, path)) > size(lookup(state, best)) ? path : best);
    if (largest.startsWith('world.')) delete worldPart[largest.slice('world.'.length)];
    else delete state[largest];
    omitted.push(largest);
    result = summary();
  }
  return result;
}

function lookup(state: Record<string, BodyValue>, path: string): BodyValue | undefined {
  if (!path.startsWith('world.')) return state[path];
  const value = state.world;
  return record(value) ? value[path.slice('world.'.length)] : undefined;
}
