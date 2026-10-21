import type { WorkingNeed } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts, countMatching } from './minecraftItems.js';
import type { MilestoneFacts } from './minecraftStage.js';
import { minecraftFrameNeeds } from './minecraftWorkingArbiter.js';
import { jobsOf } from './minecraftFillers.js';
import { bedMayWait } from './minecraftBedDefer.js';

/**
 * What the executor's procedures read from one frame (session mb-arch, `minecraftProcedures.ts`): what she carries (worn armour too,
 * `carriedItemCounts`) and what is in her pack alone (to put armour on), the furnaces at work, the needs in reach, where she is, her
 * health and food, the night, the threats near. Closed facts and registry-shaped names only; nothing of the world's text.
 */
export interface Cell { x: number; y: number; z: number }
export interface MinecraftThreat { name: string; distance: number; canReachMe: boolean }
export interface MinecraftProcedureFacts {
  counts: Map<string, number>;
  /** The pack alone (`world.inventory`), without what she wears. */
  pack: Map<string, number>;
  jobs: ReturnType<typeof jobsOf>;
  /** What the furnaces at work hold, by input item (`world.jobs[].count`). */
  smelting: Map<string, number>;
  needs: WorkingNeed[];
  at: Cell | null;
  dimension: string;
  health: number | null;
  food: number | null;
  night: boolean;
  /** Seconds to dark by day (null at night or out of the overworld). */
  darkIn: number | null;
  threats: MinecraftThreat[];
  milestone: MilestoneFacts;
  /** The body's map of the world it has seen (`world.mapSummary`, mb-body): a line a kind, each place `<m>m <方角> (x,y,z)`. */
  map: string;
  /** The biomes she has passed (`world.biomesSeen`, `desert（ここ）・river 東 64m`): where trees may grow, for the wood search (mb-r24). */
  biomes: string;
  /** The tools of the pack that say how much they have left (`{name, count, durability: {left, max}}`, mb-r20: a stone pickaxe broke in the iron dig). */
  tools: Array<{ name: string; left: number; max: number }>;
  /** How many of the four armour slots hold something (`world.worn`: `頭: iron_helmet(残り…)、胴: なし、…`). */
  armorPieces: number;
  /** The slots of the pack in use (one a stack), or null when the body lists the pack as counts only. */
  stacks: number | null;
  observation: BodyObservation | null;
}

const NAME = /^[a-z][a-z0-9_]{0,40}$/u;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const BLAZE_OR_EYE = /^(?:blaze_(?:rod|powder)|ender_eye)$/u;

function cellOf(value: unknown): Cell | null {
  const at = record(value);
  if (!at || number(at.x) === null || number(at.y) === null || number(at.z) === null) return null;
  return { x: at.x as number, y: at.y as number, z: at.z as number };
}

function threatsOf(world: Record<string, unknown>): MinecraftThreat[] {
  const list = Array.isArray(world.nearbyThreats) ? world.nearbyThreats.slice(0, 16) : [];
  return list.flatMap(item => {
    const threat = record(item);
    const distance = number(threat?.distance);
    if (!threat || distance === null) return [];
    return [{ name: typeof threat.name === 'string' && NAME.test(threat.name) ? threat.name : 'hostile', distance, canReachMe: threat.canReachMe !== false }];
  });
}

function packOf(world: Record<string, unknown>): Map<string, number> {
  return carriedItemCounts({ inventory: world.inventory }, null);
}

function smeltingOf(world: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of Array.isArray(world.jobs) ? world.jobs.slice(0, 16) : []) {
    const job = record(item);
    const count = number(job?.count);
    if (job && typeof job.input === 'string' && NAME.test(job.input) && count !== null) out.set(job.input, (out.get(job.input) ?? 0) + count);
  }
  return out;
}

/** The pack's tools that report their wear: the most that is left of each name is not summed, each stack is one entry. */
function toolsOf(world: Record<string, unknown>): MinecraftProcedureFacts['tools'] {
  return (Array.isArray(world.inventory) ? world.inventory.slice(0, 64) : []).flatMap(item => {
    const stack = record(item), durability = record(stack?.durability);
    const left = number(durability?.left), max = number(durability?.max);
    const name = typeof stack?.name === 'string' ? stack.name.replace(/^minecraft:/u, '') : '';
    return stack && NAME.test(name) && left !== null && max !== null && max > 0 ? [{ name, left, max }] : [];
  });
}

/** The armour slots filled, from the body's one line of what she wears (`頭`, `胴`, `脚`, `足`). */
function armorPiecesOf(worn: unknown): number {
  if (typeof worn !== 'string') return 0;
  return [...worn.slice(0, 400).matchAll(/(?:頭|胴|脚|足):\s*([a-z][a-z0-9_]*)/gu)].length;
}

/** The facts of a frame; `netherReached` from the pace when known (a way back to the overworld leaves no item of it). */
export function minecraftProcedureFacts(observation: BodyObservation | null, netherReached = false, bedWaits = false): MinecraftProcedureFacts {
  const world = record(observation ? (observation.state as { world?: unknown }).world : null) ?? {};
  const counts = carriedItemCounts(world, record(observation?.facts) ?? null);
  const margin = record(world.margin);
  const dimension = typeof world.dimension === 'string' && NAME.test(world.dimension.replace(/^minecraft:/u, ''))
    ? world.dimension.replace(/^minecraft:/u, '') : 'overworld';
  const light = number(margin?.lightInSeconds);
  const reached = netherReached || dimension !== 'overworld' || countMatching(counts, BLAZE_OR_EYE) > 0;
  return {
    counts, pack: packOf(world), jobs: jobsOf(observation), smelting: smeltingOf(world), needs: minecraftFrameNeeds(observation), at: cellOf(world.position),
    dimension,
    health: number(world.health), food: number(world.food), night: light !== null && light > 0, darkIn: number(margin?.darkInSeconds),
    threats: threatsOf(world),
    milestone: { counts, dimension, netherReached: reached, bedPlaced: typeof record(world.rememberedPlaces)?.respawn === 'string',
      bedDeferred: bedMayWait(bedWaits, world) },
    map: typeof world.mapSummary === 'string' ? world.mapSummary.slice(0, 3_000) : '',
    biomes: typeof world.biomesSeen === 'string' ? world.biomesSeen.slice(0, 600) : '',
    tools: toolsOf(world), armorPieces: armorPiecesOf(world.worn), stacks: Array.isArray(world.inventory) ? world.inventory.length : null,
    observation,
  };
}

/** How many of the items whose id passes `pattern` she carries (worn included). */
export const carried = (facts: MinecraftProcedureFacts, pattern: RegExp) => countMatching(facts.counts, pattern);
/** How many of the items whose id passes `pattern` are in her pack (not worn). */
export const inPack = (facts: MinecraftProcedureFacts, pattern: RegExp) => countMatching(facts.pack, pattern);
/** The carried item (pack) of the largest stack whose id passes `pattern`, or null. */
export function largest(facts: MinecraftProcedureFacts, pattern: RegExp): string | null {
  let best: [string, number] | null = null;
  for (const [name, count] of facts.pack) if (pattern.test(name) && (!best || count > best[1])) best = [name, count];
  return best?.[0] ?? null;
}
/** The nearest need of a kind she can get at, within `within` metres. */
export function nearestNeed(facts: MinecraftProcedureFacts, kind: string, within = Infinity): WorkingNeed | null {
  return facts.needs.find(need => need.need === kind && need.canReach && (need.distance ?? Infinity) <= within) ?? null;
}
/** A cell as the body reads it: whole blocks. */
export const block = (cell: Cell): Cell => ({ x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) });
export const cellKey = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;

const COORD = '(-?\\d+(?:\\.\\d+)?)';
const CELL_IN_TEXT = new RegExp(`\\(${COORD},\\s*${COORD},\\s*${COORD}\\)`, 'gu');
/** The block cells a body result names, as `(x, y, z)` (an entity's may have decimals: whole blocks), in order. */
export function cellsInText(text: string): Cell[] {
  return [...text.matchAll(CELL_IN_TEXT)].slice(0, 16).map(match => block({ x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }));
}
