import { BED_ITEM } from './minecraftItems.js';

/**
 * Observation redesign P1 (design v1 D-3): the early-game adoption tags, derived by code from a body tool's name and its
 * arguments, never from the model's words. The arguments are read only as closed words (an entity, structure, item or block id):
 * a string that is not one is ignored, and no argument is ever logged.
 */
export const ADOPTION_TAGS = Object.freeze(['first_look', 'animal_search', 'village_search', 'village_going', 'tool_order_ok', 'food_hunt',
  'bed_made', 'bed_used', 'food_before_iron', 'bed_before_iron'] as const);
export type AdoptionTag = typeof ADOPTION_TAGS[number];

const WORD = /^[a-z][a-z0-9_:]{0,63}$/u;
/** The registry-shaped words among a call's argument values (one level into arrays and objects), namespace removed. */
export function argumentWords(input: unknown): string[] {
  const words: string[] = [];
  const take = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      // hunt's kinds come as one word with commas ("cow,pig"): each is a word.
      for (const part of value.split(',').slice(0, 8)) {
        const word = part.trim().toLowerCase().replace(/^minecraft:/u, '');
        if (WORD.test(word)) words.push(word);
      }
    } else if (depth < 2 && Array.isArray(value)) value.slice(0, 16).forEach(item => take(item, depth + 1));
    else if (depth < 2 && value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).slice(0, 16).forEach(item => take(item, depth + 1));
    }
  };
  take(input, 0);
  return words;
}

const ANIMALS = new Set(['sheep', 'cow', 'pig', 'chicken']);
const PASSIVE_MOBS = new Set(['sheep', 'cow', 'pig', 'chicken', 'rabbit']);
const FIRST_LOOK_TOOLS = new Set(['minecraft.observe', 'mc.observe', 'mc.list-nearby-entities']);
/** The first-made tools whose order is judged: wooden pickaxe, then stone pickaxe, then stone axe. */
export const TOOL_ORDER = Object.freeze(['wooden_pickaxe', 'stone_pickaxe', 'stone_axe'] as const);

/** The tags one call earns by itself (the state-free ones; `first_look` needs the decision's place, the rest need what came before). */
export function callTags(name: string, input: unknown): AdoptionTag[] {
  const words = argumentWords(input), tags: AdoptionTag[] = [];
  if ((name === 'mc.find-nearest-entity' && words.some(word => ANIMALS.has(word))) || name === 'mc.list-nearby-entities') tags.push('animal_search');
  const structure = name === 'mc.find-structure' || name === 'mc.explore-for-structure';
  if ((structure && words.includes('village')) || name === 'mc.recall-places') tags.push('village_search');
  const hunts = name.startsWith('mc.attack') && words.some(word => PASSIVE_MOBS.has(word));
  if (hunts || name === 'mc.start-smelting' || name === 'mc.eat-food') tags.push('food_hunt');
  if (name === 'mc.craft-one' && words.some(word => BED_ITEM.test(word))) tags.push('bed_made');
  if (name === 'mc.sleep-in-bed') tags.push('bed_used');
  return tags;
}

/** A look in one of her first two decisions (design v1: the first look, here by tool, as the model's words are not read). */
export function isFirstLook(name: string, decision: number): boolean { return decision <= 2 && FIRST_LOOK_TOOLS.has(name); }
/** Which of the three ordered tools a `mc.craft-one` call makes, or null. */
export function craftedOrderedTool(name: string, input: unknown): typeof TOOL_ORDER[number] | null {
  return name === 'mc.craft-one' ? TOOL_ORDER.find(tool => argumentWords(input).includes(tool)) ?? null : null;
}
/** A mining, digging or collecting call that names iron ore. */
export function minesIronOre(name: string, input: unknown): boolean {
  return /^mc\.(?:mine|dig|collect)/u.test(name) && argumentWords(input).some(word => word === 'iron_ore' || word === 'deepslate_iron_ore');
}
export const eatsFood = (name: string): boolean => name === 'mc.eat-food';
export const movesTo = (name: string): boolean => name === 'mc.move-to';

/**
 * Whether the first-made order so far is the order wooden pickaxe, stone pickaxe, stone axe with all three made (design v1: judged
 * on each tool's first making); `made` lists each tool once, in the order it was first made.
 */
export function toolOrderOk(made: readonly string[]): boolean {
  return made.length === TOOL_ORDER.length && TOOL_ORDER.every((tool, index) => made[index] === tool);
}

/** The distance to the nearest village a frame's `landmarks` shows, or null (the entries are read for a village kind and a distance only). */
export function villageDistance(landmarks: unknown): number | null {
  if (!Array.isArray(landmarks)) return null;
  let nearest: number | null = null;
  for (const item of landmarks.slice(0, 64)) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const kind = [entry?.kind, entry?.type, entry?.name].find((value): value is string => typeof value === 'string') ?? '';
    const distance = Number(entry?.distance);
    if (/village/iu.test(kind) && Number.isFinite(distance) && distance >= 0 && (nearest === null || distance < nearest)) nearest = distance;
  }
  return nearest;
}

const seconds = (milliseconds: number) => Math.max(0, Math.round(milliseconds / 1000));
/**
 * `Shannon Minecraft early-game task=<id> d=<decision> t=<s> stage=<1-4> tags=<csv|-> new=<csv|-> food=<cooked food carried>
 * bed=<bool>` plus, at the decision of her first iron ore mining, ` foodBeforeIron=<bool> bedBeforeIron=<bool>`.
 */
export function earlyGameLine(task: string, decision: number, elapsedMilliseconds: number, stage: number, tags: readonly AdoptionTag[],
  fresh: readonly AdoptionTag[], food: number, bed: boolean, iron: { food: boolean; bed: boolean } | null): string {
  const csv = (list: readonly string[]) => list.length ? list.join(',') : '-';
  return `Shannon Minecraft early-game task=${task} d=${decision} t=${seconds(elapsedMilliseconds)} stage=${stage} tags=${csv(tags)} new=${csv(fresh)} `
    + `food=${Math.max(0, Math.min(food, 9_999))} bed=${bed}${iron ? ` foodBeforeIron=${iron.food} bedBeforeIron=${iron.bed}` : ''}`;
}

/** The legacy tool each `mc_act` verb counts as for these tags (task 85663847, 11/10: the v2 route sends only `mc_act`, so every line said tags=-). */
const ACT_VERB_TOOL: Readonly<Record<string, string>> = Object.freeze({
  eat: 'mc.eat-food', craft: 'mc.craft-one', make: 'mc.craft-one', mine: 'mc.mine-block', dig: 'mc.dig-block', sleep: 'mc.sleep-in-bed',
  go: 'mc.move-to', walk: 'mc.move-to', furnace: 'mc.start-smelting', smelt: 'mc.start-smelting', fight: 'mc.attack-entity', attack: 'mc.attack-entity', hunt: 'mc.attack-entity',
});
/**
 * The hands of an `mc_act` call as the legacy calls the tags read (`{name, input}` each): a short hand 「eat bread」 is its verb and its words; an
 * expanded hand `{do, ...}` is its `do` and its other fields. Hands of other verbs are left out. Any other call is itself.
 */
export function actCalls(name: string, input: unknown): Array<{ name: string; input: unknown }> {
  if (name !== 'mc_act') return [{ name, input }];
  const hands = input && typeof input === 'object' ? (input as { hands?: unknown }).hands : null;
  return (Array.isArray(hands) ? hands.slice(0, 32) : []).flatMap(hand => {
    if (typeof hand === 'string') {
      const [verb = '', ...words] = hand.trim().split(/\s+/u);
      const tool = ACT_VERB_TOOL[verb];
      return tool ? [{ name: tool, input: { words: words.slice(0, 16) } }] : [];
    }
    if (!hand || typeof hand !== 'object') return [];
    const { do: verb, ...rest } = hand as Record<string, unknown>;
    const tool = typeof verb === 'string' ? ACT_VERB_TOOL[verb] : undefined;
    return tool ? [{ name: tool, input: rest }] : [];
  });
}
