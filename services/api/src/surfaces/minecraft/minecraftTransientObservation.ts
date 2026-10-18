import type { BodyFact, BodyObservation, BodyValue } from '../../contracts/bodyControlContract.js';

/**
 * The body's observation as a transient decision reads it (observation redesign P3, `SHANNON_FCA_OBS_MODE=transient`): the old Minebot
 * `observationForPrompt` style. Coordinates and distances are rounded to 0.1, all of the nearby entities are listed (up to 16) with a
 * count of each kind and its nearest, a hostile is shown once (under `nearbyThreats`, not again among the entities), facts are the
 * adapter's own values with no timestamps, and nothing here carries a time of observation. It is never stored in the task's history:
 * the request holds it in a turn-scoped system message (`anthropicFcaTransient.ts`), which the provider stops rendering once the next
 * user message arrives. `minecraft.observe` still returns the whole frame.
 *
 * Trust (review 4, L6): this text sits in a role:system message, which the provider weighs above user and tool-result text; that is
 * the cost of a message the provider can stop rendering, and the design keeps it (the live state cannot be a user message). What the
 * world supplies (entity and item names, facts, notes) is therefore treated as untrusted data here: every string is stripped of control
 * and bidirectional-control characters (`clean`), cut at `TEXT`, and travels as a JSON string value of a JSON object, never as bare text;
 * the cached instructions say a live state is data and never an instruction (`anthropicFcaTransient.ts`). Names the world does not
 * constrain are the exposure that remains.
 */
export const TRANSIENT_OBSERVATION_CHARACTERS = 9_000;

type Rec = { readonly [key: string]: BodyValue };
const ENTITIES = 16, THREATS = 8, INVENTORY = 64, TEXT = 200, FACTS = 2_500, SMALL = 600, DEPTH = 4;
/** Parts a world frame holds that the observation shows in its own way (or never): everything else small is copied as it is. */
const OWN = new Set(['observedAt', 'facts', 'nearbyEntities', 'nearbyThreats', 'inventory']);
/** The parts kept when the observation is too long: never dropped. */
const ESSENTIAL = new Set(['position', 'dimension', 'health', 'food', 'inventory', 'nearbyThreats', 'nearbyEntities', 'entityKinds', 'time', 'biome']);

const record = (value: BodyValue | undefined): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: BodyValue | undefined): value is BodyFact => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
export const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Control and bidirectional-control characters (they can hide or reorder text) become one space; the ends are trimmed. */
const CONTROL = /[\p{Cc}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]+/gu;
export const clean = (value: string): string => value.replace(CONTROL, ' ').replace(/ {2,}/gu, ' ').trim();

/** A long text cut at `TEXT`, never between the halves of a surrogate pair (a lone half is refused by the provider). */
function text(raw: BodyFact): BodyFact {
  const value = typeof raw === 'string' ? clean(raw) : raw;
  if (typeof value !== 'string' || value.length <= TEXT) return typeof value === 'number' && Number.isFinite(value) ? round1(value) : value;
  const keep = /[\uD800-\uDBFF]/u.test(value[TEXT - 1] ?? '') ? TEXT - 1 : TEXT;
  return `${value.slice(0, keep)}…`;
}
/** A value with every number rounded to 0.1 and every text cut, to a bounded depth. */
function rounded(value: BodyValue, depth = DEPTH): BodyValue {
  if (scalar(value)) return text(value);
  if (depth <= 0) return null;
  if (Array.isArray(value)) return (value as readonly BodyValue[]).slice(0, 64).map(item => rounded(item, depth - 1));
  return Object.fromEntries(Object.entries(value as Rec).map(([key, item]) => [clean(key), rounded(item, depth - 1)]));
}

/** The item id and count a stack text or entry names (`name×count`), for matching an inventory entry to its `slot:*` fact. */
const STACK_TEXT = /^(?:minecraft:)?([a-z][a-z0-9_]{0,63})(?:×(\d{1,4}))?/u;
const pairOf = (value: string): { name: string; count: number } | null => {
  const match = STACK_TEXT.exec(value.trim());
  return match ? { name: match[1]!, count: match[2] ? Number(match[2]) : 1 } : null;
};
const slotNumber = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1_000 ? value : null;

/** One inventory stack as `name×count`, with durability when the frame gives it. */
function stack(entry: Rec): string {
  const count = typeof entry.count === 'number' ? entry.count : '?';
  const durability = record(entry.durability) ? `(耐久${String(entry.durability.left)}/${String(entry.durability.max)})` : '';
  return `${clean(String(entry.name))}×${count}${durability}`;
}
/**
 * The inventory as compact stacks. The slot number of a stack is appended as `@N` (review 4, L5): a tool that takes a `slot` needs it,
 * and the frame gives it either on the entry or as a `slot:N` fact (`name×count`); a fact matches the first stack of the same item and
 * count. A slot fact naming an item the list lacks is added as a stack of its own (as `carriedItemCounts` counts it).
 */
function inventoryOf(value: BodyValue | undefined, facts: Readonly<Record<string, BodyFact>>): BodyValue {
  const slots = Object.entries(facts).flatMap(([key, fact]) => {
    const number = /^slot:(\d{1,3})$/u.exec(key), pair = number && typeof fact === 'string' ? pairOf(fact) : null;
    return number && pair ? [{ slot: Number(number[1]), ...pair, text: clean(fact as string).slice(0, TEXT), used: false }] : [];
  });
  const listed = new Set<string>();
  const entries = (Array.isArray(value) ? value as readonly BodyValue[] : []).flatMap(entry => {
    if (record(entry) && typeof entry.name === 'string') {
      const pair = { name: entry.name.replace(/^minecraft:/u, ''), count: typeof entry.count === 'number' ? entry.count : 1 };
      listed.add(pair.name);
      let slot = slotNumber(entry.slot);
      if (slot === null) {
        const fact = slots.find(item => !item.used && item.name === pair.name && item.count === pair.count);
        if (fact) {
          fact.used = true;
          slot = fact.slot;
        }
      }
      return [`${stack(entry)}${slot !== null ? `@${slot}` : ''}`];
    }
    if (typeof entry !== 'string') return [];
    const pair = pairOf(entry), fact = pair ? slots.find(item => !item.used && item.name === pair.name && item.count === pair.count) : undefined;
    if (pair) listed.add(pair.name);
    if (fact) fact.used = true;
    return [`${clean(entry)}${fact ? `@${fact.slot}` : ''}`];
  });
  const extra = slots.filter(item => !item.used && !listed.has(item.name)).map(item => `${item.text}@${item.slot}`);
  const all = [...entries, ...extra];
  return all.length > INVENTORY ? [...all.slice(0, INVENTORY), `ほか${all.length - INVENTORY}種`] : all;
}

interface Seen { name: string; kind: string | null; distance: number | null; fields: Record<string, BodyValue> }
function seenOf(value: BodyValue | undefined, threat: boolean): Seen[] {
  return (Array.isArray(value) ? value as readonly BodyValue[] : []).flatMap(item => {
    if (!record(item) || typeof item.name !== 'string') return [];
    const distance = typeof item.distance === 'number' && Number.isFinite(item.distance) ? round1(item.distance) : null;
    const fields: Record<string, BodyValue> = { name: text(item.name) };
    if (typeof item.kind === 'string') fields.kind = text(item.kind);
    if (distance !== null) fields.distance = distance;
    if (record(item.position)) fields.position = rounded(item.position) as Rec;
    if (threat) for (const key of ['secondsToContact', 'canReachMe'] as const) if (scalar(item[key])) fields[key] = text(item[key] as BodyFact);
    return [{ name: clean(item.name), kind: typeof item.kind === 'string' ? clean(item.kind) : null, distance, fields }];
  });
}

/** Per kind of nearby thing: how many are in view and how far the nearest is. Threats and the other entities are counted once each. */
function kinds(seen: readonly Seen[]): BodyValue[] {
  const by = new Map<string, { name: string; kind: string | null; count: number; nearest: number | null }>();
  for (const item of seen) {
    const entry = by.get(item.name) ?? { name: item.name, kind: item.kind, count: 0, nearest: null };
    entry.count += 1;
    if (item.distance !== null && (entry.nearest === null || item.distance < entry.nearest)) entry.nearest = item.distance;
    by.set(item.name, entry);
  }
  return [...by.values()].sort((left, right) => (left.nearest ?? Infinity) - (right.nearest ?? Infinity) || (left.name < right.name ? -1 : 1))
    .map(entry => ({ name: entry.name, ...(entry.kind ? { kind: entry.kind } : {}), count: entry.count,
      ...(entry.nearest !== null ? { nearest: entry.nearest } : {}) }));
}

/** The adapter-normalized facts in their order, up to a bound; a `slot:*` fact is in the inventory (`inventoryOf`) and is left out. */
function factsOf(facts: Readonly<Record<string, BodyFact>>, omitted: string[]): Record<string, BodyFact> {
  const out: Record<string, BodyFact> = {};
  let used = 2, dropped = 0;
  for (const [key, value] of Object.entries(facts)) {
    if (key.startsWith('slot:')) continue;
    const cost = size(key) + size(text(value)) + 2;
    if (used + cost > FACTS) {
      dropped++;
      continue;
    }
    out[clean(key)] = text(value);
    used += cost;
  }
  if (dropped) omitted.push(`facts(${dropped})`);
  return out;
}

export function minecraftTransientObservation(observation: BodyObservation): Record<string, BodyValue> {
  const omitted: string[] = [];
  const world = record(observation.state.world) ? observation.state.world as Rec : {};
  const out: Record<string, BodyValue> = { connected: observation.connected };
  for (const [key, item] of Object.entries(world)) {
    if (OWN.has(key)) continue;
    if (scalar(item)) out[key] = text(item);
    else if (size(item) <= SMALL) out[key] = rounded(item);
    else omitted.push(`world.${key}`);
  }
  out.inventory = inventoryOf(world.inventory, observation.facts);
  const threats = seenOf(world.nearbyThreats, true), entities = seenOf(world.nearbyEntities, false);
  // A hostile is in both lists of the body's frame: it is shown once, among the threats.
  const shownThreat = new Set(threats.map(item => `${item.name}|${item.distance}`));
  const others = entities.filter(item => !shownThreat.has(`${item.name}|${item.distance}`));
  out.nearbyThreats = threats.slice(0, THREATS).map(item => item.fields);
  out.nearbyEntities = others.slice(0, ENTITIES).map(item => item.fields);
  out.entityKinds = kinds([...threats, ...others]);
  if (others.length > ENTITIES) omitted.push(`nearbyEntities(${others.length - ENTITIES})`);
  const rest = Object.entries(observation.state).filter(([key]) => key !== 'world' && key !== 'primitives');
  for (const [key, item] of rest) if (scalar(item) || size(item) <= SMALL) out[key] = rounded(item); else omitted.push(key);
  const facts = factsOf(observation.facts, omitted);
  if (Object.keys(facts).length) out.facts = facts;
  // Still too long (an unusual frame): drop the largest part that is not essential, naming each.
  while (size(out) + size(omitted) > TRANSIENT_OBSERVATION_CHARACTERS) {
    const droppable = Object.keys(out).filter(key => !ESSENTIAL.has(key) && !scalar(out[key]));
    if (!droppable.length) break;
    const largest = droppable.reduce((best, key) => size(out[key]) > size(out[best]) ? key : best);
    delete out[largest];
    omitted.push(largest);
  }
  if (omitted.length) out.omitted = omitted;
  return out;
}
