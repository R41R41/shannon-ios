import type { ProcedureMemory } from '@shannon/mind';
import { BUCKET_ITEM } from './minecraftStage.js';
import { FURNACE_WALK_FROM, nextFiller, type MinecraftWorkItem } from './minecraftFillers.js';
import { block, carried, cellKey, cellsInText, inPack, largest, nearestNeed, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { cobbleFor, COBBLE, craft, digLogs, doing, LOGS, PLANKS, planksFor, sticksFor, stuck, type McMove } from './minecraftProcedureMoves.js';
import { caveDescent, smithChest, towardRoute } from './minecraftProcedureMap.js';
import type { RouteLeg } from './minecraftRoutePlanner.js';
import { dropJunk, guardOutward, healFirst, noteSurface, pickaxeReserve } from './minecraftProcedureCare.js';
import { waterOnTheSurface } from './minecraftProcedureWater.js';

/**
 * The iron age as one procedure (session mb-arch; 「鉄」「バケツ」「鉄の全身の防具」): the iron still needed dug at once (run 19 dug about
 * 55 for 33 used), smelted in two furnaces with coal, the furnace's time used to dig on, and each piece made the moment its ingots are
 * there, in the order the route wants them: the pickaxe, the bucket, the chestplate, the leggings, the helmet, the boots, a spare pickaxe.
 * The armour is put on by the executor's upkeep (`minecraftProcedureUpkeep.ts`).
 */
export interface ProcedureTaskStore {
  /** The furnaces the executor set down or saw at work, by cell. */
  furnaces: Cell[];
  /** Where the executor built the gate's frame (`minecraftProceduresDeep.ts`). */
  portal?: Cell;
  /** The map's places gone to in this task (`minecraftProcedureMap.ts`): a cave's bottom, a chest, a portal, a village. */
  visited: Set<string>;
  /** Where the task began (the first place a frame gave): the sheep search keeps within reach of it (`minecraftProceduresEarly.ts`). */
  origin?: Cell;
  /** The surface a descent began at (mb-r20): the stair she dug is the way back up for water or a portal. */
  surface?: Cell;
  /** Stops for low health with an enemy near that the task has made (`minecraftProcedureCare.ts`). */
  careStops?: number;
}

const IRON_PICKAXE = /^(?:iron|diamond|netherite)_pickaxe$/u;
const piece = (name: string) => new RegExp(`^(?:chainmail|iron|diamond|netherite)_${name}$`, 'u');
interface Planned { item: string; iron: number; have(facts: MinecraftProcedureFacts): boolean; sticks?: boolean }
export const IRON_PLAN: readonly Planned[] = Object.freeze([
  { item: 'iron_pickaxe', iron: 3, sticks: true, have: facts => carried(facts, IRON_PICKAXE) >= 1 },
  // mb-r20: run 20's first half hour ended with a stone axe against two zombies; the sword (two ingots) comes before the bucket.
  { item: 'iron_sword', iron: 2, sticks: true, have: facts => carried(facts, /^(?:iron|diamond|netherite)_sword$/u) >= 1 },
  { item: 'bucket', iron: 3, have: facts => carried(facts, BUCKET_ITEM) >= 1 },
  { item: 'iron_chestplate', iron: 8, have: facts => carried(facts, piece('chestplate')) >= 1 },
  { item: 'iron_leggings', iron: 7, have: facts => carried(facts, piece('leggings')) >= 1 },
  { item: 'iron_helmet', iron: 5, have: facts => carried(facts, piece('helmet')) >= 1 },
  { item: 'iron_boots', iron: 4, have: facts => carried(facts, piece('boots')) >= 1 },
  { item: 'iron_pickaxe', iron: 3, sticks: true, have: facts => carried(facts, IRON_PICKAXE) >= 2 },
]);
const RAW_IRON = /^raw_iron$/u;
const INGOT = /^iron_ingot$/u;
const IRON_HELD = /^(?:raw_iron|iron_ingot|(?:deepslate_)?iron_ore)$/u;
const COAL = /^(?:coal|charcoal)$/u;

/** The iron the plan still takes: the pieces not made, and one for the flint and steel of the gate. */
export function ironWanted(facts: MinecraftProcedureFacts): number {
  const pieces = IRON_PLAN.filter(planned => !planned.have(facts)).reduce((sum, planned) => sum + planned.iron, 0);
  return pieces + (carried(facts, /^flint_and_steel$/u) ? 0 : 1);
}
/**
 * The first seven pieces of the plan: the pickaxe, the sword, the bucket and the four pieces of armour, 32 iron in all (run 21: the
 * count the first two digs are made for, 16 and 16). The spare pickaxe and the gate's flint and steel come after them.
 */
const CORE_PIECES = 7;
/** The iron the pieces not yet made still take, without the spare pickaxe and the flint and steel. */
export const coreIronWanted = (facts: MinecraftProcedureFacts) =>
  IRON_PLAN.slice(0, CORE_PIECES).filter(planned => !planned.have(facts)).reduce((sum, planned) => sum + planned.iron, 0);
/** The iron she has: carried in any form, and the raw iron in the furnaces. */
export const ironHeld = (facts: MinecraftProcedureFacts) => carried(facts, IRON_HELD) + (facts.smelting.get('raw_iron') ?? 0);

/** Raw iron dug in the first call (run 21: 12 a call made three digs of 36; the first of 16 and the second of what is left, 20, do). */
export const IRON_DIG_AT_ONCE = 16;
/** A furnace smelts an item in ten seconds. */
const SMELT_ITEM_MS = 10_000;
/** A furnace this far from her is not walked back to for a piece (the body's `withdraw-from-furnace` walks, and a long walk costs more than the dig). */
const FURNACE_REACH = 48;
/**
 * The ingots of a furnace this soon from being ready for the next piece keep her from a dig that would leave them waiting
 * (run 21: 100 s from the batch to the pickaxe).
 */
const HOLD_FOR_FURNACE_MS = 40_000;
/** The furnaces at most that hold iron at once (a third when the first two are full of the food the body queues behind a batch). */
const FURNACES = 3;
/** The most raw iron put in one furnace when another already runs (more waits in the pack for the next free one). */
const MOST_IN_A_FURNACE = 10;

const distance = (facts: MinecraftProcedureFacts, cell: Cell) =>
  facts.at ? Math.hypot(cell.x - facts.at.x, cell.y - facts.at.y, cell.z - facts.at.z) : Infinity;

/**
 * The next piece made when its ingots are there (sticks first for a pickaxe; planks for a table after the body had none). Exported for
 * the steps before the iron: the pieces whose ingots are in hand are made before more wood is dug or a sheep is hunted (run 20: seven
 * ingots in hand at 516 s, the pickaxe at 665 s, after a step of wood, a bed's night and a hunt for beef).
 */
export function makePiece(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  const next = IRON_PLAN.find(planned => !planned.have(facts));
  if (!next || carried(facts, INGOT) < next.iron) return null;
  const key = `craft:${next.item}:${carried(facts, IRON_PICKAXE)}`;
  const table = memory.lastFailure(key) === 'crafting_table_missing' ? planksFor(facts, 6) : null;
  // Four sticks for a pickaxe: two left over for the diamond pickaxe, made deep down where there is no wood.
  return table ?? (next.sticks ? sticksFor(facts, 4) : null) ?? craft(next.item, `${next.item}を作る`, 1, key);
}

/** A furnace done (or nearly) within reach: what it made taken out, without waiting. */
function takeOut(facts: MinecraftProcedureFacts): McMove | null {
  const job = facts.jobs.find(item => item.remainingEstimateMs <= 500 && distance(facts, item.position) <= 48);
  if (!job) return null;
  return doing({ tool: 'mc.withdraw-from-furnace', input: { ...job.position, waitForCompletion: false }, why: 'かまどの鉄を取り出す', expectMs: 6_000,
    key: `withdraw:${cellKey(job.position)}:${carried(facts, INGOT)}` });
}

type Job = MinecraftProcedureFacts['jobs'][number];
const IRON_JOB = /raw_iron|iron_ore/u;
/** The furnaces within reach that smelt iron. */
const ironJobs = (facts: MinecraftProcedureFacts): Job[] =>
  facts.jobs.filter(job => IRON_JOB.test(job.input) && distance(facts, job.position) <= FURNACE_REACH);
/** Whether a furnace within reach holds iron she smelted (what it made is still to be taken out). */
export const ironInFurnaces = (facts: MinecraftProcedureFacts) => ironJobs(facts).length > 0;
/** The ingots a batch has made `ms` from now: its size less what is left to smelt by then (none when the body names no size). */
function ingotsBy(job: Job, ms: number): number {
  if (job.count === null) return 0;
  const left = Math.max(0, job.remainingEstimateMs - ms);
  return Math.max(0, Math.min(job.count, job.count - Math.ceil(left / SMELT_ITEM_MS)));
}
/** The ingots the next piece of the plan still lacks (it takes them all at once). */
function ingotsLacking(facts: MinecraftProcedureFacts): number {
  const next = IRON_PLAN.find(planned => !planned.have(facts));
  return next ? Math.max(0, next.iron - carried(facts, INGOT)) : 0;
}
/** The time until the furnaces within reach have made `need` ingots between them, or null when they will not. */
function msUntilIngots(facts: MinecraftProcedureFacts, need: number): number | null {
  const jobs = ironJobs(facts), last = Math.max(0, ...jobs.map(job => job.remainingEstimateMs));
  for (let ms = 0; ms <= last; ms += 2_500) if (jobs.reduce((sum, job) => sum + ingotsBy(job, ms), 0) >= need) return ms;
  return null;
}

/**
 * The ingots a furnace has made already, taken before its batch is done when they are enough for the next piece (run 21: the batch
 * was done at 305 s and the pickaxe came at 404 s; the pickaxe needs three, and three are smelted in 30 s). The body answers a part
 * taken with `waiting_external` and "完成済みの…を回収しました": that is a part taken, not a failure (`accepts`).
 */
function takeOutPart(facts: MinecraftProcedureFacts): McMove | null {
  const need = ingotsLacking(facts);
  if (need <= 0) return null;
  const ready = ironJobs(facts).map(job => ({ job, made: ingotsBy(job, 0) })).filter(item => item.made > 0 && item.job.remainingEstimateMs > 500)
    .sort((a, b) => b.made - a.made);
  if (ready.reduce((sum, item) => sum + item.made, 0) < need || ready[0]!.made < 2) return null;
  const { job, made } = ready[0]!;
  return doing({ tool: 'mc.withdraw-from-furnace', input: { ...job.position, waitForCompletion: false }, why: 'かまどの焼けた分の鉄を先に取り出す', expectMs: 6_000,
    key: `withdraw:part:${cellKey(job.position)}:${carried(facts, INGOT)}:${made}`,
    accepts: (failure, text) => failure === 'waiting_external' && /回収しました/u.test(text) });
}

/** What to burn: coal first; planks or logs when there is none (the body itself prefers coal). */
function fuelOf(facts: MinecraftProcedureFacts): string | null {
  return largest(facts, COAL) ?? largest(facts, PLANKS) ?? largest(facts, LOGS);
}

/**
 * Coal to dig first when it is short for the iron and some is near (run 19 burned logs twice with coal 12 m away). `count` is all the
 * raw iron carried: the coal for every furnace it goes into is dug at once, not before each one (the second furnace waited for a
 * second trip).
 */
function coalFirst(facts: MinecraftProcedureFacts, count: number): McMove | null {
  const short = Math.ceil(count / 8) - carried(facts, COAL);
  const coal = short > 0 ? nearestNeed(facts, 'fuel', 24) : null;
  if (!coal) return null;
  return doing({ tool: 'mc.mine-block', input: { blockName: 'coal_ore', count: Math.min(8, short + 1), searchRadius: 24 }, why: '焼く石炭を掘る',
    expectMs: 15_000, key: `coal:${carried(facts, COAL)}` });
}

function smeltAt(cell: Cell, count: number, fuel: string, key: string): MinecraftWorkItem {
  return { tool: 'mc.start-smelting', input: { ...cell, inputItem: 'raw_iron', fuelItem: fuel, count }, why: '鉄を焼く', expectMs: 4_000, key };
}

/** A furnace set down (made first when none is carried), then filled where the body says it stands; remembered for the task. */
function newFurnace(facts: MinecraftProcedureFacts, store: ProcedureTaskStore, count: number, fuel: string): McMove | null {
  const fill = (text: string): MinecraftWorkItem | null => {
    const cell = cellsInText(text)[0];
    if (!cell) return null;
    store.furnaces.push(cell);
    return smeltAt(cell, count, fuel, `smelt:new:${cellKey(cell)}`);
  };
  const place: MinecraftWorkItem = { tool: 'mc.place-block-at', input: { blockName: 'furnace' }, why: 'かまどを置く', expectMs: 3_000,
    key: `furnace:place:${store.furnaces.length}`, then: fill, chain: 2 };
  // rel23: a second furnace is set within 8 m of the first. The body picks the spot within ~4.5 m of where it stands, so when she stands
  // further than FURNACE_WALK_FROM from the first (and it is not left far behind) she walks to it first.
  const first = store.furnaces[0];
  const walk: MinecraftWorkItem | null = first && distance(facts, first) > FURNACE_WALK_FROM && distance(facts, first) <= 48
    ? { tool: 'mc.move-to', input: { ...first, range: 3 }, why: '先のかまどの近くへ寄る', expectMs: 15_000, key: `furnace:walk:${store.furnaces.length}`,
      then: () => place, chain: 3 }
    : null;
  if (inPack(facts, /^furnace$/u)) return doing(walk ?? place);
  if (carried(facts, COBBLE) >= 8) {
    return doing({ tool: 'mc.craft-one', input: { itemName: 'furnace', count: 1 }, why: 'かまどを作る', expectMs: 4_000,
      key: `furnace:craft:${store.furnaces.length}`, then: () => walk ?? place, chain: walk ? 4 : 3 });
  }
  return store.furnaces.length ? null : cobbleFor(facts, 8, 8);
}

/** The raw iron carried put in the furnaces: two of them, half each; coal dug first when it is near and short. */
function smelt(facts: MinecraftProcedureFacts, store: ProcedureTaskStore, memory: ProcedureMemory): McMove | null {
  const raw = inPack(facts, RAW_IRON);
  if (!raw) return null;
  // A furnace that refused raw iron (picked up, gone) is forgotten.
  store.furnaces = store.furnaces.filter(cell => memory.lastFailure(`smelt:${cellKey(cell)}:${raw}`) === null);
  const busy = new Set(facts.jobs.map(job => cellKey(block(job.position))));
  const free = store.furnaces.filter(cell => !busy.has(cellKey(cell)) && distance(facts, cell) <= 64);
  // Half to a furnace while another can take the rest (one free, or a furnace still to set down); the raw iron goes in before any food:
  // the body queues the raw meat she carries behind a batch and puts it in when the batch is taken out (run 21: the second 12 raw iron
  // sat in the pack from 366 s to 614 s behind sheep and pork). A third furnace takes the iron when the two are full of the food.
  const partner = ironJobs(facts).length > 0;
  const capacity = free.length + Math.min(2, FURNACES - store.furnaces.length);
  const count = raw < 4 ? raw : !partner && capacity >= 2 ? Math.ceil(raw / 2) : Math.min(raw, MOST_IN_A_FURNACE);
  const coal = coalFirst(facts, raw);
  if (coal) return coal;
  const fuel = fuelOf(facts);
  if (!fuel) return digLogs(facts, 2, '燃料の原木を掘る');
  if (free[0]) return doing(smeltAt(free[0], count, fuel, `smelt:${cellKey(free[0])}:${raw}`));
  return store.furnaces.length < FURNACES ? newFurnace(facts, store, count, fuel) : null;
}

/** The iron still to be dug: the pieces of the plan not made, the spare pickaxe and the gate's flint and steel (36 at the start), less what is held. */
export function ironShort(facts: MinecraftProcedureFacts): number {
  return ironWanted(facts) - ironHeld(facts);
}
/** The second dig takes what is left at once, the spare's 3 and the flint's 1 with it (a third dig, far from the furnaces, is a trip of its own). */
const IRON_DIG_FINISH = 20;

/** The iron still needed dug at once (16 the first time, then what is left up to 20); deeper when none is in reach. */
function digIron(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore, leg?: RouteLeg): McMove | null {
  const short = ironShort(facts);
  if (short <= 0) return null;
  const y = facts.at ? Math.floor(facts.at.y) : 64;
  const band = Math.floor(y / 16);
  const key = `iron:${ironHeld(facts)}:${band}`;
  // Before the dig: the pack cleared of rock, a pickaxe that is about to break replaced, health made up (`minecraftProcedureCare.ts`).
  const ready = dropJunk(facts, memory) ?? pickaxeReserve(facts) ?? healFirst(facts, memory);
  if (ready) return ready;
  noteSurface(facts, store);
  if (memory.lastFailure(key) !== 'target_not_found') {
    const count = Math.min(short, ironHeld(facts) === 0 ? IRON_DIG_AT_ONCE : IRON_DIG_FINISH);
    return doing({ tool: 'mc.mine-block', input: { blockName: 'iron_ore', count, searchRadius: 48 }, why: 'まだ要る鉄を掘る',
      expectMs: Math.max(30_000, 5_000 * count), key });
  }
  // None within 48 m: the place the route named for the iron, before a stair dug down where she happens to stand.
  const named = towardRoute(facts, store, memory, leg, 'ルートが示した鉄の場所へ行く');
  if (named) return named;
  if (y <= 16) return stuck('48m 以内に鉄鉱石が見えない（Y16 まで降りた）');
  return doing({ tool: 'mc.stair-mine', input: { targetY: Math.max(16, y - 24) }, why: '鉄のある深さへ降りる', expectMs: 60_000, key: `iron:down:${band}` });
}

/**
 * Iron from the map before more digging (mb-map), with no iron in reach: a smith's chest in a village near, then, still on the
 * surface, a cave entrance walked down to the iron's depth (its bottom often shows two or three veins).
 */
function fromTheMap(facts: MinecraftProcedureFacts, store: ProcedureTaskStore, memory: ProcedureMemory): McMove | null {
  if (ironShort(facts) <= 0 || nearestNeed(facts, 'iron', 24)) return null;
  const chest = smithChest(facts, store, memory);
  if (chest) return chest;
  return !facts.at || facts.at.y < 40 ? null : caveDescent(facts, store, memory, { within: 64, depth: [-10, 48], why: '鉄のある深さへ下りる' });
}

/** The body takes a wait for a batch only when what is left is this short (`withdraw-from-furnace`, `wait-time`): longer, it refuses. */
const BODY_WAITS_MS = 20_000;

/**
 * A wait for a furnace that fills the time, and does not spin the planner (run 21: 45 s, eight decisions, three refusals of a wait that
 * was asked for 60, 45 and 50 s while the furnace had 63 and 50 left): what is left is read, and a wait the body takes (20 s or less)
 * is asked for as it is; a longer one is filled with the small work that fits (coal, iron or food near, a second furnace for the meat),
 * else a short wait for the part the body does not refuse. `cell` is the furnace waited for.
 */
function waiting(facts: MinecraftProcedureFacts, memory: ProcedureMemory, remainingMs: number, cell: Cell, untilMs = remainingMs): McMove | null {
  if (remainingMs <= BODY_WAITS_MS) {
    return doing({ tool: 'mc.withdraw-from-furnace', input: { ...cell, waitForCompletion: true }, why: 'かまどを待って取り出す',
      expectMs: remainingMs + 6_000, key: `wait:${cellKey(cell)}:${carried(facts, INGOT)}` });
  }
  const recent = new Set<string>();
  for (let tries = 0; tries < 4; tries += 1) {
    const item = nextFiller(facts.observation, { remainingMs: untilMs, recent, waitingCell: cellKey(cell) });
    if (!item) break;
    if (memory.succeeded(item.key) + memory.failed(item.key) === 0) return doing(item);
    recent.add(item.key);
  }
  const milliseconds = Math.max(2_500, Math.min(untilMs, remainingMs - BODY_WAITS_MS, 30_000));
  return doing({ tool: 'mc.wait-time', input: { milliseconds: Math.round(milliseconds) }, why: 'かまどの焼ける間を待つ', expectMs: milliseconds + 2_000,
    key: `furnace:idle:${Math.round(remainingMs / 5_000)}:${carried(facts, INGOT)}`,
    // The body refuses a wait when it has something definite to do meanwhile: the hold is off, and the dig goes on.
    onFail: () => { memory.notes.set('hold:off', true); } });
}

/** The furnace that finishes first waited on. */
function waitFurnace(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  const job = [...facts.jobs].filter(item => IRON_JOB.test(item.input) && distance(facts, item.position) <= 64)
    .sort((a, b) => a.remainingEstimateMs - b.remainingEstimateMs)[0];
  return job ? waiting(facts, memory, job.remainingEstimateMs, job.position) : null;
}

/**
 * The ingots for the next piece are this near in the furnaces (`HOLD_FOR_FURNACE_MS`): she stays by them, with small work, instead of
 * going to dig what would leave them waiting (run 21: a second dig of 120 s came between the batch and the pickaxe, and the furnace's
 * ingots sat from 305 s to 366 s; its trip back for them, 40 to 80 s, came three times).
 */
function holdForFurnace(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  if (memory.notes.get('hold:off') === true) return null;
  const need = ingotsLacking(facts);
  if (need <= 0) return null;
  const until = msUntilIngots(facts, need);
  if (until === null || until > HOLD_FOR_FURNACE_MS) return null;
  const soonest = [...ironJobs(facts)].sort((a, b) => a.remainingEstimateMs - b.remainingEstimateMs)[0];
  if (!soonest) return null;
  // Enough is made already for the part to be taken (`takeOutPart`, before this) or it is `until` away: the wait is for that time.
  return waiting(facts, memory, soonest.remainingEstimateMs, soonest.position, Math.max(until, 2_500));
}

/** 「鉄」「バケツ」「鉄の全身の防具」: make, take out, smelt, dig, and only then wait. */
export function ironMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory, store: ProcedureTaskStore, leg?: RouteLeg): McMove {
  for (const job of facts.jobs) if (!store.furnaces.some(cell => cellKey(cell) === cellKey(block(job.position)))) store.furnaces.push(block(job.position));
  const guard = (move: McMove | null) => move ? guardOutward(facts, store, move) : null;
  // The bucket filled the moment it is made, while she is still on the surface (mb-r20): water down below cost run 20 325 s and the Nether.
  // mb-r21: what the furnaces have made comes out (whole, then the part the next piece needs) before the next dig, the raw iron goes in
  // before food, and the dig is not begun while the next ingots are this near.
  return makePiece(facts, memory) ?? guard(takeOut(facts)) ?? guard(takeOutPart(facts)) ?? smelt(facts, store, memory) ?? waterOnTheSurface(facts, memory)
    ?? guard(holdForFurnace(facts, memory)) ?? guard(fromTheMap(facts, store, memory)) ?? guard(digIron(facts, memory, store, leg))
    ?? waitFurnace(facts, memory) ?? stuck('鉄の手順で次にできる手が無い');
}
