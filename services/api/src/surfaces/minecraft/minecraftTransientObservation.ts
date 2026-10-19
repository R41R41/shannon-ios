import type { BodyFact, BodyObservation, BodyValue } from '../../contracts/bodyControlContract.js';
import { reflexesLine } from './minecraftObservationReflexes.js';

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
 * world supplies (entity and item names, facts, notes, the biome, the jobs) is therefore treated as untrusted data here: every string is
 * stripped of control and hidden characters (`clean`: format characters, tag characters, variation selectors of the supplement; the zero-width
 * joiner and non-joiner stay so that emoji sequences and Persian words are whole), cut at `TEXT`, and travels as a JSON string value of a
 * JSON object, never as bare text;
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

/** Control characters and the line and paragraph separators (they break a line) become one space. */
const BREAKS = /[\p{Cc}\u2028\u2029]+/gu;
/**
 * Characters that show nothing and can hide or reorder text (review 5, L-2): every format character (`\p{Cf}`: zero-width, bidirectional,
 * word joiner and invisible operators, Arabic letter mark, soft hyphen, the tag characters) and the combining grapheme joiner, the
 * Mongolian free variation selectors and the supplementary variation selectors. They are removed, not replaced by a space.
 * Kept on purpose: the zero-width joiner and non-joiner (they hold emoji sequences and Persian words together) and the variation
 * selectors of the BMP (U+FE00 to U+FE0F: an emoji presentation, a CJK variant).
 */
const HIDDEN = /(?![\u200C\u200D])[\p{Cf}\u034F\u180B-\u180F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** More than one joiner in a row is never part of a word or an emoji sequence: it is a carrier of hidden bits. */
const JOINER_RUN = /[\u200C\u200D]{2,}/gu;
/** A text the world supplied, safe to put in the live state: line breaks become one space, hidden characters go, the ends are trimmed. */
export const clean = (value: string): string =>
  value.replace(BREAKS, ' ').replace(HIDDEN, '').replace(JOINER_RUN, '').replace(/ {2,}/gu, ' ').trim();
/** A string cut at `TEXT` after cleaning (`clean` then the bound); for the parts of the live state that sit beside the observation. */
export const cleanText = (value: string): string => text(value) as string;
/** A value with every string and every key cleaned (no bound, no rounding): the world's own structure, as it was otherwise. */
export function cleanDeep(value: BodyValue): BodyValue {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return (value as readonly BodyValue[]).map(cleanDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Rec).map(([key, item]) => [clean(key), cleanDeep(item)]));
  return value;
}

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

/**
 * The item id and count a stack text or entry names (`name×count`), for matching an inventory entry to its `slot:*` fact. `exact`: the
 * text is nothing but that (a fact with more in it, a durability or a custom name, is not fully stated by a slot number).
 */
const STACK_TEXT = /^(?:minecraft:)?([a-z][a-z0-9_]{0,63})(?:×(\d{1,4}))?(.*)$/su;
const pairOf = (value: string): { name: string; count: number; exact: boolean } | null => {
  const match = STACK_TEXT.exec(value.trim());
  return match ? { name: match[1]!, count: match[2] ? Number(match[2]) : 1, exact: match[3]!.trim() === '' } : null;
};
const slotNumber = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1_000 ? value : null;

/** One inventory stack as `name×count`, with durability when the frame gives it. */
function stack(entry: Rec): string {
  const count = typeof entry.count === 'number' ? entry.count : '?';
  const durability = record(entry.durability) ? `(耐久${String(entry.durability.left)}/${String(entry.durability.max)})` : '';
  return `${clean(String(entry.name))}×${count}${durability}`;
}

interface SlotFact { key: string; slot: number; name: string; count: number; exact: boolean; text: string; used: boolean }
interface Stacked { display: string; name: string | null; count: number; slot: number | null; fact: SlotFact | null }

/**
 * The inventory as compact stacks, and the keys of the `slot:*` facts it states (review 4, L5; review 5, M-1 and L-1). The slot number of
 * a stack is appended as `@N`: a tool that takes a `slot` needs it, and the frame gives it either on the entry or as a `slot:N` fact.
 * A fact is taken into the inventory (and left out of the facts) only when what it says is wholly stated there:
 *   - it is exactly `name×count` (nothing else in it) and the list has a stack of that item and count that has no slot yet;
 *   - when several such stacks differ (two pickaxes of different durability) the fact cannot tell which it is, so it stays a fact;
 *     stacks that read alike take the slots in order, since either reading is the same text;
 *   - a fact naming an item the list does not have at all is added as a stack of its own (as `carriedItemCounts` counts it).
 * Every other `slot:*` fact (an aggregated list against per-slot facts, another count, a renamed item, the offhand `slot:-106`,
 * `slot:hotbar`, a number) is not represented here and reaches the model as a fact, as it did in a legacy decision.
 */
function inventoryOf(value: BodyValue | undefined, facts: Readonly<Record<string, BodyFact>>): { inventory: BodyValue; represented: Set<string> } {
  const slots: SlotFact[] = Object.entries(facts).flatMap(([key, fact]) => {
    const number = /^slot:(\d{1,3})$/u.exec(key), pair = number && typeof fact === 'string' ? pairOf(fact) : null;
    return number && pair ? [{ key, slot: Number(number[1]), ...pair, text: cleanText(fact as string), used: false }] : [];
  });
  const items: Stacked[] = (Array.isArray(value) ? value as readonly BodyValue[] : []).flatMap((entry): Stacked[] => {
    if (record(entry) && typeof entry.name === 'string') {
      return [{ display: stack(entry), name: entry.name.replace(/^minecraft:/u, ''), count: typeof entry.count === 'number' ? entry.count : 1,
        slot: slotNumber(entry.slot), fact: null }];
    }
    if (typeof entry !== 'string') return [];
    const pair = pairOf(entry);
    return [{ display: clean(entry), name: pair?.name ?? null, count: pair?.count ?? 0, slot: null, fact: null }];
  });
  const same = (fact: SlotFact, item: Stacked) => !fact.used && fact.exact && fact.name === item.name && fact.count === item.count;
  // A stack that carries its own slot number: the fact of that slot and the same stack says nothing more, so it is represented by it.
  for (const item of items) {
    const twin = item.slot === null ? undefined : slots.find(fact => same(fact, item) && fact.slot === item.slot);
    if (twin) {
      twin.used = true;
      item.fact = twin;
    }
  }
  // The rest, by item and count: a slot is given only when the stacks of that kind read alike (L-1: otherwise it would be a guess).
  const groups = new Map<string, Stacked[]>();
  for (const item of items) {
    if (item.name === null || item.slot !== null) continue;
    const kind = `${item.name}\n${item.count}`;
    groups.set(kind, [...groups.get(kind) ?? [], item]);
  }
  for (const group of groups.values()) {
    if (group.some(item => item.display !== group[0]!.display)) continue;
    const candidates = slots.filter(fact => same(fact, group[0]!));
    group.slice(0, candidates.length).forEach((item, index) => {
      item.fact = candidates[index]!;
      candidates[index]!.used = true;
    });
  }
  const listed = new Set(items.flatMap(item => item.name === null ? [] : [item.name]));
  const slotOf = (item: Stacked) => item.slot ?? item.fact?.slot ?? null;
  const lines = [...items.map(item => ({ text: `${item.display}${slotOf(item) !== null ? `@${slotOf(item)}` : ''}`, keys: item.fact ? [item.fact.key] : [] })),
    ...slots.filter(fact => !fact.used && !listed.has(fact.name)).map(fact => ({ text: `${fact.text}@${fact.slot}`, keys: [fact.key] }))];
  // Past the bound the lines are counted, not shown; a fact whose line is not shown stays a fact.
  const shown = lines.slice(0, INVENTORY);
  const inventory = lines.length > INVENTORY ? [...shown.map(line => line.text), `ほか${lines.length - INVENTORY}種`] : shown.map(line => line.text);
  return { inventory, represented: new Set(shown.flatMap(line => line.keys)) };
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

/**
 * The adapter-normalized facts in their order, up to a bound. Only the `slot:*` facts the inventory states as `@N` (`inventoryOf`) are left
 * out; every other fact, a slot fact the inventory could not match included, is passed as the adapter gave it (review 5, M-1).
 */
function factsOf(facts: Readonly<Record<string, BodyFact>>, represented: ReadonlySet<string>, omitted: string[]): Record<string, BodyFact> {
  const out: Record<string, BodyFact> = {};
  let used = 2, dropped = 0;
  for (const [key, value] of Object.entries(facts)) {
    if (represented.has(key)) continue;
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

/** One part of the world frame that the observation copies: as it is when small; the body's reflexes, when too long, as their one line (L-3). */
function copyWorldPart(out: Record<string, BodyValue>, omitted: string[], raw: string, item: BodyValue): void {
  const key = clean(raw);
  if (scalar(item)) out[key] = text(item);
  else if (size(item) <= SMALL) out[key] = rounded(item);
  else {
    // The line the legacy summary says (`reflexesLine`), never only a name.
    const line = raw === 'reflexes' ? reflexesLine(item) : null;
    if (line) out[key] = clean(line);
    else omitted.push(`world.${key}`);
  }
}

/**
 * `options.leave`: world parts that are said elsewhere in the live state (the jobs, `minecraftTransientBody.ts`): they are not copied here
 * a second time (review 6, L-3).
 */
export function minecraftTransientObservation(observation: BodyObservation, options: { leave?: readonly string[] } = {}): Record<string, BodyValue> {
  const omitted: string[] = [];
  const world = record(observation.state.world) ? observation.state.world as Rec : {};
  const out: Record<string, BodyValue> = { connected: observation.connected };
  for (const [raw, item] of Object.entries(world)) {
    if (!OWN.has(raw) && !options.leave?.includes(raw)) copyWorldPart(out, omitted, raw, item);
  }
  const { inventory, represented } = inventoryOf(world.inventory, observation.facts);
  out.inventory = inventory;
  const threats = seenOf(world.nearbyThreats, true), entities = seenOf(world.nearbyEntities, false);
  // A hostile is in both lists of the body's frame: it is shown once, among the threats.
  const shownThreat = new Set(threats.map(item => `${item.name}|${item.distance}`));
  const others = entities.filter(item => !shownThreat.has(`${item.name}|${item.distance}`));
  out.nearbyThreats = threats.slice(0, THREATS).map(item => item.fields);
  out.nearbyEntities = others.slice(0, ENTITIES).map(item => item.fields);
  out.entityKinds = kinds([...threats, ...others]);
  if (others.length > ENTITIES) omitted.push(`nearbyEntities(${others.length - ENTITIES})`);
  const rest = Object.entries(observation.state).filter(([key]) => key !== 'world' && key !== 'primitives');
  for (const [raw, item] of rest) {
    const key = clean(raw);
    if (scalar(item) || size(item) <= SMALL) out[key] = rounded(item); else omitted.push(key);
  }
  const facts = factsOf(observation.facts, represented, omitted);
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
