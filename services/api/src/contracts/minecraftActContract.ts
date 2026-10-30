/**
 * The LLM-centric Minecraft body (design mb-llm-centric, 2026-10-21; head switch the LLM-centric mode, body MINEBOT_LLM_CENTRIC):
 * the head owns this contract, the body follows it (shared note `mb-llm-centric-contract.md`). Four parts:
 *
 * 1. `mc.act` (body skill `act`): up to 12 small hands run in order, each checked; the run stops at the first that does not go as asked,
 *    a reflex, a `stopIf`, or a full pack, and returns one line a hand and a new map.
 * 2. `mc.view` (body skill `view`): a wider or other view of the blocks, when the map of each decision is not enough.
 * 3. The map: a text the body draws (`world.localMap`) in the format and with the symbols below, with landmarks off the map
 *    (`world.mapLandmarks`), the recent stops (`world.recentStops`) and the hidden saturation (`world.saturation`).
 * 4. The plan a command's context carries (`BodyTaskContext.plan`, bodyControlContract.ts), for the ShannonUI mod's task tree.
 *
 * The head sends the definitions below to the model (byte for byte, so the cached prefix holds) and checks an input against them and
 * `actProblem` before the body sees it; the body's own schema must accept every input these accept. The body's result is the JSON of
 * `ActResult` / `ViewResult` in the receipt's `result` (at most 16,000 characters, the receipt's bound).
 */
import { PLAN_LIMITS, promiseItemFits } from '@shannon/mind';
import type { WorldScan } from './minecraftProbeContract.js';
import { CONDITION_SCHEMA, validCondition, type ActCondition } from './minecraftActCondition.js';
import { dependsProblem, handProblem } from './minecraftActHandRules.js';
import { aggregateGoal, type ActOutcome, type CutBy, type EventsMore, type GoalOutcome, type Handover, type HandOutcome, type InventoryEvent, type RunEnd } from './continueContract.js';

export const MC_ACT_SKILL = 'act' as const;
export const MC_VIEW_SKILL = 'view' as const;
export const MC_ACT_TOOL = `mc.${MC_ACT_SKILL}` as const;
export const MC_VIEW_TOOL = `mc.${MC_VIEW_SKILL}` as const;
export const ACT_CONTRACT_VERSION = 1 as const;
export const ACT_MAX_HANDS = 12;

/** A block position, or a point to walk to. With the hand's `rel: true`, x/y/z count from her feet block when that hand begins. */
export interface ActPos { x: number; y: number; z: number }
export type ActFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
export const HAND_KINDS = ['walk', 'go', 'dig', 'place', 'pillarUp', 'use', 'look', 'jump', 'sneak', 'equip', 'craft', 'furnace', 'chest',
  'attack', 'shoot', 'eat', 'drop', 'pickup', 'wait', 'obsidian', 'fight', 'mine', 'make', 'portal', 'smelt', 'vertical'] as const;
export type HandKind = typeof HAND_KINDS[number];
/** vertical (continue contract 6): the way down or up, the form of the climb or descent, the compass words of `toward`, and what to do at a liquid. */
export const VERTICAL_DIRS = ['down', 'up'] as const;
export const VERTICAL_SHAPES = ['stairs', 'shaft', 'pillar'] as const;
export const VERTICAL_TOWARDS = ['north', 'east', 'south', 'west'] as const;
export const VERTICAL_LIQUIDS = ['stop', 'seal', 'seal_water'] as const;
export const EQUIP_SLOTS = ['hand', 'offhand', 'head', 'chest', 'legs', 'feet'] as const;
/**
 * The slot words of `equip` the body takes are hand, offhand, head, chest, legs and feet. Bench 2026-10-24 (run 38 d127, the iron armour made and put on): 2 answers of 3 wrote
 * `equip iron_chestplate torso` (the live state's worn line says 頭・胴・脚・足・左手), and the act was refused. Amendment A-11 3 (a real run: `equip shield slot=off-hand` was refused
 * and the act that broke the promise was sent): the plain variations of the hand words (`off-hand`, `main_hand`…) are read as the body's. Only what is plainly the same word.
 */
const SLOT_WORDS: Readonly<Record<string, string>> = { torso: 'chest', body: 'chest', chestplate: 'chest', helmet: 'head', leg: 'legs', leggings: 'legs',
  boots: 'feet', foot: 'feet', mainhand: 'hand', main: 'hand', main_hand: 'hand', 'main-hand': 'hand', off: 'offhand', off_hand: 'offhand', 'off-hand': 'offhand',
  頭: 'head', 胴: 'chest', 脚: 'legs', 足: 'feet', 右手: 'hand', 左手: 'offhand' };
/** The body's slot word for a word the model wrote (the word itself when it is not one of the variations). */
export const slotWordOf = (word: string): string => SLOT_WORDS[word.trim().toLowerCase()] ?? word;

/**
 * One hand. Flat (the wire's schema subset allows `anyOf` of at most 4): `do` names the kind and `actProblem` says which fields each kind
 * takes. Every field a kind does not name must be absent.
 */
export interface ActHand {
  do: HandKind;
  /** walk, go: where to arrive (within `range`, default 0.5); look: the point to face. */
  to?: ActPos;
  /** walk: the way, point by point (each next point a step or a straight run the body can walk without digging). */
  path?: readonly ActPos[];
  /** dig/place: the blocks, in order; use/furnace/chest/shoot: one block (the first). */
  at?: readonly ActPos[];
  /** place/use: the face of `at` to put against or use (default: the body's choice of a face it can reach). */
  face?: ActFace;
  /** place/pillarUp: the block to place (pillarUp default: the most numerous of cobblestone, cobbled_deepslate, dirt, netherrack). */
  block?: string;
  /** use/equip/craft/eat/shoot: the item (use: water_bucket, bucket, lava_bucket, flint_and_steel, ender_eye, a bed, a door…). */
  item?: string;
  /** craft: how many of `item`; furnace put: how many of `item`. */
  count?: number;
  /** drop/chest take/chest put: the items and counts (count absent: the whole stack kind). */
  items?: readonly { item: string; count?: number }[];
  /** furnace put: the fuel and how many. */
  fuel?: string; fuelCount?: number;
  /** furnace: put | take; chest: look | take | put | takeAll. */
  op?: 'put' | 'take' | 'look' | 'takeAll';
  /** attack/shoot/pickup/drop: an entity, `#<id>` or a name (the nearest of that name). drop: throw toward it. */
  target?: string;
  /** attack: go on until it is dead (default true); false with `seconds`: hit for that long. */
  untilDead?: boolean;
  /**
   * attack: hold the place (run 26, the blaze spawner): stand where she is, face the nearest `target` and hit it whenever it comes within
   * reach, for `seconds` (or until `stopIf`); never chase. Without it an attack chases by walk's rules (no digging: it stops and says so).
   */
  hold?: boolean;
  /** wait: seconds (0.5–30); attack: the most seconds (default 20); go: the most seconds the hand may take (5–120, default 60). */
  seconds?: number;
  /** shoot: seconds to draw (0.2–3, default 1.0: a full bow). */
  charge?: number;
  /** jump: times; pillarUp: blocks to rise (each a jump with a block placed under the feet); shoot: arrows. */
  n?: number;
  /**
   * go (run 39): where she may go instead of `to`: 2–8 cells, any one of which ends the hand (the way to the nearest is taken). The model lists the cells; the
   * body never searches for them. `rel` counts all of them from her feet.
   */
  goals?: readonly ActPos[];
  /** go: the blocks the body may dig on its way (ids, or the words stone, dirt, sand, wood). None: it digs nothing. */
  canDig?: readonly string[];
  /** go: the blocks the body may put down on its way (a footing, a bridge, a pillar, a filled hole). None: it places nothing. */
  canPlace?: readonly string[];
  /** go: the most blocks she may drop at one step (0–10, default 3). */
  maxDrop?: number;
  /** go: swim and wade (default false: water and the deep water beside the way are avoided). Lava and fire are always avoided. */
  waterOk?: boolean;
  /** go: the most blocks dug (0–200, default 40) and placed (0–100, default 24). */
  maxDig?: number; maxPlace?: number;
  /**
   * Run 39 (2026-10-26), the hands that take a range from the model and work out the small moves themselves (`go`, `obsidian`, `fight`, `mine`,
   * `make`, `portal`,
   * `smelt`; `docs/minecraft-hands-2026-10.md`): the model decides what, where and how far, and what may be done; the body does the seconds-fine work. Never a
   * search of its own beyond what the model named; always a limit and the counts back.
   * fight: `flee` runs from the target instead of fighting (default fight); `retreatHp` leaves the fight and eats or runs when health falls under it (1–19).
   */
  stance?: 'fight' | 'flee';
  retreatHp?: number;
  /** portal: the frame's plane runs along x or z. */
  axis?: 'x' | 'z';
  /** smelt: how many furnaces the batch is split over (1–4). */
  furnaces?: number;
  /** portal: go in once it burns (default true). */
  enter?: boolean;
  /** walk, go: sprint (default false). */
  sprint?: boolean;
  /** walk, go: arrive within this many blocks (0–4, default 0.5). pickup: the search radius (1–16, default 6). */
  range?: number;
  /** equip: where (default hand). */
  slot?: typeof EQUIP_SLOTS[number];
  /** sneak: on or off. */
  on?: boolean;
  /** look: compass degrees (0 north, 90 east, 180 south, 270 west) and pitch (−90 up … 90 down), instead of `to`. */
  yaw?: number; pitch?: number;
  /** dig: the tool to hold (default: the body holds what digs it fastest; it never crafts one). */
  tool?: string;
  /** dig: walk to and pick up what dropped (default true). */
  collect?: boolean;
  /** dig: go on even when the opening lets a hostile see her (the body says so and stops otherwise). */
  exposeOk?: boolean;
  /** dig/chest take: go on even with a protected or village block (a village's bed, chest, crops). */
  takeOk?: boolean;
  /** Coordinates of this hand count from her feet block at the hand's start. */
  rel?: boolean;
  /** A few words for the plan's "next hand" in the mod (at most 40 characters). */
  note?: string;
  /**
   * r3 (run 27: [equip stone_sword, walk away] stopped at the equip, "持っていない", and the walk away from a creeper never ran): when this
   * hand fails by itself, `continue` writes it as `failed` and goes on to the next hand; `stop` ends the act there. A reflex, a `stopIf`, a
   * full pack, a cancel and the deadline end the act whatever this says. Default (`handContinuesOnFail`): continue for the quick hands
   * that leave the world as it was (equip, eat, look, sneak, jump), stop for every other kind.
   */
  onFail?: 'continue' | 'stop';
  /**
   * vertical (continue contract 6: a hand of `mc.act` that digs, places and walks one step at a time, with no path search; `canDig`, `canPlace`, `maxDig`,
   * `maxPlace`, `range` and `seconds` are the fields above, shared). The model decides the way, the form and how far; the body never changes them.
   * `dir`: down | up, always written (not read from where she stands). `shape`: stairs | shaft (straight down, `dir` down only) | pillar (straight up on a block put under
   * her feet, `dir` up only). `toward`: stairs only (required there), the compass way the stairs lead. `toY`: the feet's y to reach (−64 … 320).
   * `liquid`: lava or water seen — stop | seal and go on | seal_water (seal water, stop at lava); `range` (1–2) is how far round the cell a seal reaches.
   */
  dir?: 'down' | 'up';
  shape?: 'stairs' | 'shaft' | 'pillar';
  toward?: 'north' | 'east' | 'south' | 'west';
  toY?: number;
  liquid?: 'stop' | 'seal' | 'seal_water';
  /**
   * Continue contract 2: the numbers (1 up, `ActHandLine.i`) of the earlier hands of the same act and the same pass that this hand relies on. Absent: as before, an
   * earlier hand that stops stops this one too. `[]`: it relies on no hand and goes even when an earlier one failed. `[1,3]`: it goes only when hand 1 and hand 3
   * reached what they aimed at (done or already, finished). A hand that did not run, or that depends on one that did not, is not something to rely on.
   * `onFail: continue` does not excuse the check. Itself, a later hand, a number out of range and a repeated number are refused before the body sees them.
   */
  dependsOn?: readonly number[];
}
/** The kinds whose failure does not end the act unless the hand says `onFail: 'stop'` (r3). */
export const HAND_CONTINUES_BY_DEFAULT: ReadonlySet<HandKind> = new Set(['equip', 'eat', 'look', 'sneak', 'jump']);
/** Whether the act goes on past this hand when it fails by itself (`ActHand.onFail`, or its kind's default). */
export function handContinuesOnFail(hand: Pick<ActHand, 'do' | 'onFail'>): boolean {
  return hand.onFail ? hand.onFail === 'continue' : HAND_CONTINUES_BY_DEFAULT.has(hand.do);
}
/** Stop the whole act when one holds (checked between hands and every 250 ms inside a long one). */
export interface ActStopIf {
  /** A hostile within this many blocks (1–32). */
  hostileWithin?: number;
  /** Health below this (1–20). */
  hpBelow?: number;
  /** Food (hunger bar) below this (0–20). */
  hungerBelow?: number;
  /** Any of these blocks changed (a furnace's state counts only as its block; at most 4). */
  blockChanged?: readonly ActPos[];
}
/**
 * `accept`: the hostile kinds she takes on in this act (`blaze`, `enderman`, `piglin`…; run 26: the fast judgment's shelter and flee cut
 * 27% of her calls at the spawner). For those kinds, while the act runs, the body does not back off, flee, dodge by moving, refuse an
 * exposed dig, or stop on `stopIf.hostileWithin`; the shield's guard and a fireball's deflection still act without stopping the act.
 * The reflexes of section 6 of the shared note stay (lava, drowning, falling, a lit creeper, and the low-health flight at health 8).
 */
/**
 * A thing the act says to keep for later (amendment A-7 1; written `keep=spruce_planks:4:作業台`, item:count:use): the head turns each into a promise of the plan when it
 * sends the act (`FcaPlanPort.keepPromise`). It is the head's: it is not in the arguments sent to the body, and it does not put the promise in the act's `uses` (`uses` is
 * what the act says it spends; `keep` says what is left aside).
 */
export interface ActKeep { item: string; count: number; use: string }
/** At most this many `keep` entries in one act; a count is a promise's (1 up to `PLAN_LIMITS.promiseCount`) and a use is at most `PLAN_LIMITS.promiseUse` characters. */
export const KEEP_MAX = 4;
export const KEEP_FORM = `keep=spruce_planks:4:作業台（品目:数:用途。複数はコンマで keep=spruce_planks:4:作業台,cobblestone:8:かまど。品目は物の名前か food、数は 1〜${PLAN_LIMITS.promiseCount}、`
  + `用途は ${PLAN_LIMITS.promiseUse} 字まで、${KEEP_MAX} つまで）`;
export interface ActInput {
  hands: readonly ActHand[]; stopIf?: ActStopIf; why?: string; accept?: readonly string[];
  /**
   * The task queue (design 2026-10-26): `repeat` runs the hands up to that many times (2–8; relative hands only, or the same cells are asked again);
   * `done` ends the act as done the moment it holds (the body checks it at every tick); `pre` is checked once right before the act starts (it
   * travels in the queue envelope, not in the act's arguments); `replace` names the queued items to take off first (the head applies it).
   */
  repeat?: number; done?: ActCondition; pre?: ActCondition; replace?: readonly string[];
  /**
   * Continue contract 2 and 3 (the head reads them; they are not in the arguments sent to the body, as `pre` and `replace` are not): `dependsOn` the marks of the
   * queue items of the same queue that this item relies on (`q12`; `[]` relies on none; absent: it is dropped when the item before it stops, as before) and
   * `uses` the numbers of the promises of the plan this act says it uses (the head keeps the promises' definitions as they are when it sends the act).
   */
  dependsOn?: readonly string[]; uses?: readonly number[];
  /** Amendment A-7 1: what to keep for later (the head only; see `ActKeep`). */
  keep?: readonly ActKeep[];
}

/** The older passes of a repeating act whose lines were folded into counts (amendment A-6 11; the body's form, one entry a pass): how many hand lines it had, how many hands were done and how many stopped. */
export interface EarlierPass { pass: number; lines: number; done: number; stopped: number }

/** One line a hand, in order: what was done, or where and why it stopped, or that it did not run. */
export interface ActHandLine {
  i: number; do: HandKind;
  /** `failed` (r3): the hand failed by itself and the act went on past it (`onFail: 'continue'`); its line is written as a stop's. */
  status: 'done' | 'stopped' | 'skipped' | 'failed';
  /**
   * Japanese, at most 160 characters. done: what changed (`(201,45,277)→(205,45,277) 1.2秒`, `丸石×3 を得た`); stopped: the place and the
   * reason in closed words first (`届かない`, `一歩ではない`, `掘れない`, `置けない`, `無い`, `満杯`, `見られる`, `守られた物`, `溶岩が流れ込む`,
   * `足場が無い`, `上から落ちる`, `時間切れ`, `反射`, `stopIf`), then what is there now (`そのマスは stone`); skipped: `未実行`.
   */
  line: string;
  /** stopped: the block or point where it stopped, when there is one. */
  where?: ActPos;
  /**
   * stopped with `where`: the 3×3×3 round it in the map's symbols (r2, 2026-10-22), the top layer first, rows north to south and cells
   * west to east, the middle cell `where` itself: `x=200..202 z=276..278 y=49: #.#/#.#/### y=48: … y=47: …`. At most 120 characters.
   */
  around?: string;
  /**
   * Continue contract 1 (flat on the line): what the hand aimed at and how its run ended (`HandOutcome`), and `motorOps`, the number of operations it made the body
   * carry out (amendment A-1 1: it tells `failed` from `not_started`; a skipped hand has none). The body always sends them; a result without them (an older body,
   * a test) is read by `readActResult`, which fills `goal` and `end` from `status` (a done hand is done and finished, a skipped one not started and not run, any
   * other one failed and finished).
   */
  goal?: HandOutcome['goal']; end?: HandOutcome['end']; cutBy?: HandOutcome['cutBy']; code?: string; progress?: HandOutcome['progress'];
  delta?: HandOutcome['delta']; pass?: number; motorOps?: number;
}
/** `use` of an ender eye thrown (not put in a frame): which way it flew and how far. */
export interface EnderEyeFlight {
  from: ActPos;
  /** Compass degrees of its flight, 0 north (−z), 90 east (+x), 180 south, 270 west, to one decimal. */
  bearingDeg: number;
  /** Horizontal blocks from `from` to where it stopped (or fell). */
  flew: number;
  to: ActPos;
  /** The eye broke (true) or dropped to be picked up (false). */
  broke: boolean;
}
export interface ActResult {
  v: typeof ACT_CONTRACT_VERSION;
  /** Every hand done. False too when every hand ran but one or more `failed` (then `stoppedBy` is absent). */
  ok: boolean;
  /** Hands done, of the hands asked. */
  done: number; of: number;
  stoppedBy?: 'failure' | 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline' | 'noProgress' | 'damage' | 'fall';
  /** stopIf: which (`hostileWithin:zombie 4.2m`, `hpBelow:7`). reflex: what the reflex did and where she is (`溶岩から上がった (12,64,-3)`). */
  stoppedWhy?: string;
  /** r10 (the body): the act came while a reflex held the body and began when it let go ("反射 flee（低体力の逃走）の最中のため、放された後に始めた（待ち 1.6秒）"). */
  afterReflex?: string;
  lines: readonly ActHandLine[];
  /** Where she stands and her health and food after the act. */
  at: ActPos; hp: number; food: number;
  /** The map after the act (same format as `world.localMap`). The head reads the newest map from the frame; this one is for a reader of the result alone. */
  map?: string;
  /** A thrown ender eye (the last one of the act). */
  eye?: EnderEyeFlight;
  /** A chest or furnace looked at or used: its contents after (`name×count`, at most 27). */
  container?: { at: ActPos; kind: string; items: readonly string[] };
  /** shoot: arrows left. */
  arrowsLeft?: number;
  /** Milliseconds the act took. */
  ms: number;
  /** The task queue: passes completed of the most the act was given (`repeat`); `done` and `of` then count all passes. */
  repeat?: { done: number; of: number };
  /** The task queue: the satisfied alternative of `done` with its values (`have:log 10/10`); absent when it was not met. */
  doneMet?: string;
  /**
   * Continue contract 1 (the body always sends it; `actOutcomeOf` reads it, or works it out from the lines when an older result lacks it): the act's two axes and the life it ran in.
   * `handover`: a reflex held the body and let go on the act's own target (chapter 4). `eventsMore`: where the inventory events that did not fit are fetched.
   * `earlierPasses` and `earlierEvents`: when the older passes' lines were folded into a count to keep the result small, their events are not dropped, they are carried
   * here (the lines of the newest passes stay in `lines`).
   */
  outcome?: ActOutcome; handover?: Handover; eventsMore?: EventsMore;
  earlierPasses?: readonly EarlierPass[];
  earlierEvents?: readonly InventoryEvent[];
}

export interface ViewInput {
  /** Default: her feet. */
  center?: ActPos;
  /** Blocks out from the centre (1–32, default 12). */
  radius?: number;
  /** Absolute y bounds (default: centre −4 … +4; `top` ignores them). */
  yFrom?: number; yTo?: number;
  /** layers: one grid per y; top: the surface from above with heights; slice: a vertical cut through the centre; column: the x,z column. */
  mode: 'layers' | 'top' | 'slice' | 'column';
  /** slice: north–south (ns, rows are y, columns z) or east–west (ew, columns x). Default ns. */
  axis?: 'ns' | 'ew';
  /** Show only these (block names or map symbols); everything else solid is `#`, passable `.`. At most 8. */
  only?: readonly string[];
}
export interface ViewResult {
  v: typeof ACT_CONTRACT_VERSION;
  /** The map text (format below). Past 6,000 cells the body draws `top` with each cell 2×2 and says so in the header. */
  map: string;
  /** Up to 12 landmark lines inside the view (same form as `world.mapLandmarks`). */
  landmarks?: readonly string[];
}

/** The world fields the body adds to every frame while MINEBOT_LLM_CENTRIC is on (`observation.state.world`). */
export interface LlmCentricWorld {
  /** The map of this frame (format below): redrawn when she moved a block or a block in it changed, at most every 500 ms. */
  localMap?: string;
  /**
   * Off-map landmarks, at most 12 lines: `記号 名前 (x,y,z) 方角距離・上下 注記`, nearest and most useful first. Only places of the dimension
   * she is in (run 26: an overworld crafting table read as 3 m away in the Nether); a place of another dimension, when worth saying (the
   * gate back, her base), starts with that dimension in brackets and gives no distance: `[overworld] T 作業台 (10,35,15) 拠点`.
   */
  mapLandmarks?: readonly string[];
  /** The structure she is in or beside (run 26): `ネザー要塞の中`, `砦の遺跡（bastion）の脇`, `ストロングホールドの中`, `村の中`, `エンドシティ`; absent: none. */
  inside?: string;
  /** The recent stops, at most 5 lines, newest first: `(x,y,z)→(x,y,z) 理由 ×回数 N秒前`. Counted by the body, never acted on by it. */
  recentStops?: readonly string[];
  /** The hidden food saturation (0–20). */
  saturation?: number;
  /** r4: the body's own `scan` at a spawn, a new dimension or a respawn (`WorldScan`, `minecraftProbeContract.ts`); absent until the first. */
  scan?: WorldScan;
}

/**
 * The map text. One header line, then one grid per layer, top layer first:
 *
 *   地図 v1 足=(201,45,277) x=194..208 z=270..284 方式=layers 上=北
 *   y=47
 *   z\x 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8
 *   270 # # # # # # # # # # # # # # #
 *   …
 *   y=45
 *   277 # # # w . . @ * * # # # # # #
 *
 * - Columns are x (west on the left), rows are z (north on top); the header row gives each column's last digit of x, and every row
 *   starts with its whole z. One cell is one symbol and a space.
 * - layers (underground, or no sky above her): y from feet −2 to feet +2; feet −1 … +1 at 15×15 (±7), feet ±2 at 11×11 (±5), a
 *   narrower layer's line naming its range (`y=47 x=196..206 z=272..282`). Where a hostile's feet or a spawner is 3–6 above her within
 *   ±5, the layer of the lowest one and the one over it (11×11) come first (r2, 2026-10-22: run 26's blazes and spawner were 3–4 up,
 *   off the map; the outer layers went to 11×11 for the tokens: the map was about 2,000, twice the design).
 * - surface (sky above her): `方式=surface`: one 21×21 grid (±10) of the top block with its height against her feet as a second
 *   character (cell = symbol + height + space: `#0 :1 wa`), then the 3 layers feet −1 … +1 at 11×11 (±5) as in layers.
 *   Height: 0–9 that many above her feet, + ten or more above, a–i one to nine below, v ten or more below.
 * - Last, in both, her column (`縦`, r2): from the head's cell up and from the cell under her feet down, at most 4 runs of one symbol
 *   within 16 cells, `…` when it goes on: `縦 (201,277) 上: y=46〜53 .×8 / y=54〜61 #×8 …` (run 25: the furnace seven up a shaft).
 * - Water a source is `w`, sand and gravel `s`, crops `k` (r2, 2026-10-22: count_tokens put `~ ` at three tokens a cell and `; ` at two,
 *   a letter at one; a map of a lake was half again as long).
 * - `@` is her feet in its own layer; a hostile's feet `!`, an animal's `m` (in an air cell only); `*` an air cell she walked in the last
 *   60 s. A lowercase/uppercase symbol is not interchangeable.
 */
export const MAP_LEGEND = [
  '地図の記号（1字。地図は上が北・左が西。行の頭は z、列の見出しは x の下 1 桁）:',
  '@ 自分の足 / ! 敵の足 / m 動物の足 / * 60秒以内に歩いた空気 / . 空気 / , 通れる草花・雪 / ? 未ロード / X 掘れない（岩盤・バリア）',
  '# 石の類（石・深層岩・安山岩・閃緑岩・花崗岩・凝灰岩・丸石・石レンガ）/ : 土・草・雪・粘土 / s 砂・砂利 / I 氷',
  'w 水源 / - 流れる水 / L 溶岩源 / l 流れる溶岩 / f 火 / x クモの巣',
  'i 鉄 / c 石炭 / d ダイヤ / g 金 / r レッドストーン / o ほかの鉱石（銅・ラピス・エメラルド・石英・古代の残骸）',
  'W 原木（ネザーの幹も）/ % 葉・ネザーの葉ブロック / P 板・木の建物 / D 扉 / + 柵・壁・鉄格子・ガラス / h はしご・つた / t 松明 / = レール',
  'F かまど（溶鉱炉・燻製器も）/ T 作業台 / C チェスト・樽 / B ベッド / H 干し草 / k 畑の作物（ネザーウォートも）/ S スポナー',
  'O 黒曜石（泣く黒曜石も）/ p ネザーポータル / n ネザーラック / u ソウルサンド・ソウルソイル / N ネザーレンガ（要塞）/ M マグマ / G グロウストーン',
  'E エンドストーン / Q エンドポータルの枠（空）/ R 枠（アイ入り）/ e エンドポータル・エンドゲートウェイ / $ ほかの固いブロック',
  '方式=surface のマスは「記号＋高さ」: 0〜9 は足より上、+ は10以上上、a〜i は1〜9下、v は10以上下。',
  '方式=layers の層: 足 −1〜+1 は 15×15、足 ±2 は 11×11（「y=47 x=196..206 z=272..282」のように範囲を書く）。足の 3〜6 上に敵（!）かスポナー（S）があれば、その高さの層（11×11）を一番上に足す。',
  '縦: 足の列の上（頭のマスから上へ）と下（足の下のマスから下へ）を、同じ記号の続きでまとめる。「上: y=46〜51 .×6 / y=52 #」は頭から空気が 6 段、その上が石。… はその先も続く。',
].join('\n');

/** The definition text of `mc.act` the model reads (fixed: part of the cached prefix). */
export const ACT_DESCRIPTION = [
  '体に小さな手を最大12個まとめて頼む。体は順に動かし、手ごとに思ったとおりか確かめ、外れたら（失敗・反射・stopIf・満杯）そこで止めて、手ごとの1行と新しい地図を返す。',
  '体は自分で決めない: 回り道・置き場所・道具作り・片づけ・夜の睡眠・戦うかどうかは、あなたが地図と状態を見て手で出す。',
  '手（do）と引数: walk(to か path, sprint, range: 掘らない・置かない。段差1と泳ぎだけ。地図の外の遠い点は64mごとに区切って歩き、掘る所で止まる) / '
    + 'go(to か goals: 行き先（goals は候補のマス 2〜8、どれか 1 つに着けば済み）, canDig: 掘ってよい物, canPlace: 置いてよい物, maxDrop, waterOk, seconds, maxDig, maxPlace: '
    + '道は体が引く。許した物だけ掘り・置いて着くまで歩く。溶岩は避ける) / '
    + 'dig(at: 順に掘る, tool, collect, exposeOk: 敵に見られても掘る, takeOk: 村の物も掘る) / place(block, at, face) / pillarUp(n: 真下に置きながら n 段登る, block) / '
    + 'use(item, at, face, target: バケツで汲む・注ぐ、火打ち金、ベッドで寝る、扉、エンダーアイを投げる（at 無し: 飛んだ方位と距離が返る）・枠にはめる（at と face）) / '
    + 'look(to か yaw・pitch) / jump(n) / sneak(on) / equip(item, slot) / craft(item, count: 作業台が4.5m内に要る) / '
    + 'furnace(at, op=put: item・count・fuel・fuelCount | op=take) / chest(at, op=look|take|put|takeAll, items) / '
    + 'attack(target: #id か名前, untilDead, seconds, hold: その場で待って届いたら打つ・追わない) / '
    + 'shoot(target か at, item: 弓かクロスボウ, charge: 引く秒, n: 本数) / eat(item) / '
    + 'drop(items, target か at: その方へ投げる。ピグリンへの金など) / pickup(target か range) / wait(seconds: 0.5〜30)。',
  '座標はブロックの整数。rel: true の手は、その手を始める時の足のブロックからの差（x 東+、z 南+、y 上+）。',
  '形: why は act に 1 つ（手の中に書かない。手の短い説明は note）。at・path・items は 1 つでも配列 [ ] で書く。',
  'かまど（F・燻製器・溶鉱炉）は furnace（op=take で出来上がりを取る、op=put で入れる）。chest は箱・樽（C）だけ。',
  'use・furnace・chest は目からそのマスの面が見える所で。間に固いブロックがあれば先に dig する（石 1 枚の向こうの水は、その石を dig してから use bucket）。',
  'stopIf: hostileWithin（m）・hpBelow・hungerBelow・blockChanged（見張るマス）。満たしたら全体を止めて返す。hpBelow は今の体力より低い値（以上だと 1 手も動かず止まる）。待つ手の act には hostileWithin。',
  '同じ種類の手が続く場面（トンネル・階段・橋・採掘）は、10〜12 手を 1 つの act に入れる（dig の at は 16 マスまで、walk の path は 32 点まで 1 手に）。止まりは反射・stopIf・onFail が守る。',
  'accept: この act で戦うと決めた敵の種類（例 ["blaze"]）。体はその敵から下がらず・逃げず・止まらない（盾の構えと火の玉の打ち返しはする）。'
    + '溶岩・溺れ・落下・点火クリーパー・体力8以下の逃走の反射は残る。早めに引くなら stopIf の hpBelow を高めに。',
  'onFail: 手が自分で失敗した時、continue なら「失」と書いて次の手へ進み、stop ならそこで act を止める。既定は equip・eat・look・sneak・jump が continue、ほかは stop。'
    + '急ぐ act（離れる・食べる）の前の手が失敗しそうなら continue に。反射・stopIf・満杯・時間切れはいつでも act を止める。',
  'ずれた時は、返った行（止まった場所・理由・そのマスの今の中身）と地図から次の手を直す。同じ手を同じまま繰り返さない。',
].join('\n');
/** The definition text of `mc.view`. */
export const VIEW_DESCRIPTION = [
  '地図を広く・別の向きで見る（読むだけ）。毎判断の地図で足りない時（縦穴・崖・上にある物・遠い水や溶岩・詰まった理由）に使う。',
  'mode: layers（y ごとの層）/ top（上から。表面の記号と高さ）/ slice（中心を通る縦の断面。axis=ns か ew）/ column（その x,z の縦の列）。',
  'center（既定は足）、radius（1〜32、既定12）、yFrom・yTo、only（見たい種類だけ。ほかは # と . にまとめる）。6,000マスを超えると top を2×2にまとめる。',
].join('\n');

const pos = (description: string) => ({ type: 'object', description, additionalProperties: false, required: ['x', 'y', 'z'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } });
const itemCounts = { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['item'],
  properties: { item: { type: 'string', maxLength: 64 }, count: { type: 'integer', minimum: 1, maximum: 2304 } } } };

/** The input schema of `mc.act` (the head's; the body's must take every input this takes). */
export const ACT_INPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['hands'],
  properties: {
    hands: { type: 'array', minItems: 1, maxItems: ACT_MAX_HANDS, description: '順に動かす手（1〜12）。見えている手はまとめて出す。', items: {
      type: 'object', additionalProperties: false, required: ['do'],
      properties: {
        do: { type: 'string', enum: [...HAND_KINDS] },
        to: pos('walk の着く所、look の向く点'),
        path: { type: 'array', minItems: 1, maxItems: 32, items: pos('道の点'), description: 'walk の道（掘らずに歩ける点の列）' },
        at: { type: 'array', minItems: 1, maxItems: 16, items: pos('ブロック'), description: 'dig・place は順に全部。use・furnace・chest・shoot は 1 つ' },
        face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'] },
        block: { type: 'string', maxLength: 64 },
        item: { type: 'string', maxLength: 64 },
        count: { type: 'integer', minimum: 1, maximum: 2304 },
        items: itemCounts,
        fuel: { type: 'string', maxLength: 64 },
        fuelCount: { type: 'integer', minimum: 1, maximum: 64 },
        op: { type: 'string', enum: ['put', 'take', 'look', 'takeAll'] },
        target: { type: 'string', maxLength: 64, description: '生き物（#id か名前）' },
        untilDead: { type: 'boolean' },
        hold: { type: 'boolean' },
        goals: { type: 'array', minItems: 2, maxItems: 8, items: pos('行き先の候補'), description: 'go の行き先の候補（どれか 1 つに着けば済み）' },
        canDig: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 40 }, description: 'go で掘ってよい物（id か stone・dirt・sand・wood）' },
        canPlace: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', maxLength: 40 }, description: 'go で置いてよい物（足場・橋・柱）' },
        maxDrop: { type: 'integer', minimum: 0, maximum: 10 },
        waterOk: { type: 'boolean' },
        stance: { type: 'string', enum: ['fight', 'flee'] },
        retreatHp: { type: 'integer', minimum: 1, maximum: 19 },
        axis: { type: 'string', enum: ['x', 'z'] },
        furnaces: { type: 'integer', minimum: 1, maximum: 4 },
        enter: { type: 'boolean' },
        maxDig: { type: 'integer', minimum: 0, maximum: 200 },
        maxPlace: { type: 'integer', minimum: 0, maximum: 100 },
        seconds: { type: 'number', minimum: 0.5, maximum: 120 },
        charge: { type: 'number', minimum: 0.2, maximum: 3 },
        n: { type: 'integer', minimum: 1, maximum: 16 },
        sprint: { type: 'boolean' },
        range: { type: 'number', minimum: 0, maximum: 16 },
        slot: { type: 'string', enum: [...EQUIP_SLOTS] },
        on: { type: 'boolean' },
        yaw: { type: 'number', minimum: -360, maximum: 360 },
        pitch: { type: 'number', minimum: -90, maximum: 90 },
        tool: { type: 'string', maxLength: 64 },
        collect: { type: 'boolean' },
        exposeOk: { type: 'boolean' },
        takeOk: { type: 'boolean' },
        rel: { type: 'boolean' },
        note: { type: 'string', maxLength: 40 },
        onFail: { type: 'string', enum: ['continue', 'stop'] },
        dir: { type: 'string', enum: [...VERTICAL_DIRS], description: 'vertical の向き（down か up）' },
        shape: { type: 'string', enum: [...VERTICAL_SHAPES], description: 'vertical の形（stairs・shaft は down だけ・pillar は up だけ）' },
        toward: { type: 'string', enum: [...VERTICAL_TOWARDS], description: 'vertical stairs の向き' },
        toY: { type: 'integer', minimum: -64, maximum: 320, description: 'vertical で着く足の y' },
        liquid: { type: 'string', enum: [...VERTICAL_LIQUIDS], description: 'vertical で溶岩・水が見えた時（止める・塞いで続ける・水だけ塞ぐ）' },
        dependsOn: { type: 'array', maxItems: 11, items: { type: 'integer', minimum: 1, maximum: ACT_MAX_HANDS }, description: '頼る前の手の番号（1 から）。[] は何にも頼らない' },
      } } },
    stopIf: { type: 'object', additionalProperties: false, required: [], properties: {
      hostileWithin: { type: 'number', minimum: 1, maximum: 32 },
      hpBelow: { type: 'number', minimum: 1, maximum: 20 },
      hungerBelow: { type: 'number', minimum: 0, maximum: 20 },
      blockChanged: { type: 'array', minItems: 1, maxItems: 4, items: pos('見張るブロック') },
    } },
    why: { type: 'string', maxLength: 120, description: 'この手の組のねらい（短く）' },
    accept: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 }, description: 'この act で戦うと決めた敵の種類（体はそれから逃げない）' },
    repeat: { type: 'integer', minimum: 2, maximum: 8, description: '手の組を最大何回まわすか' },
    done: { ...CONDITION_SCHEMA, description: '満たした所で済みにする条件' },
    pre: { ...CONDITION_SCHEMA, description: '始める時に確かめる条件' },
    replace: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 8 }, description: '先に消す列の項目' },
    dependsOn: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 8 }, description: '頼る列の項目。[] は何にも頼らない' },
    uses: { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 1, maximum: 999 }, description: '使う約束の番号' },
    keep: { type: 'array', maxItems: KEEP_MAX, description: '後で使うために残す物（約束になる）', items: { type: 'object', additionalProperties: false, required: ['item', 'count', 'use'],
      properties: { item: { type: 'string', maxLength: 64 }, count: { type: 'integer', minimum: 1, maximum: PLAN_LIMITS.promiseCount },
        use: { type: 'string', maxLength: PLAN_LIMITS.promiseUse } } } },
  },
});

/** The input schema of `mc.view`. */
export const VIEW_INPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['mode'],
  properties: {
    center: pos('中心（既定は足）'),
    radius: { type: 'integer', minimum: 1, maximum: 32 },
    yFrom: { type: 'integer', minimum: -64, maximum: 320 },
    yTo: { type: 'integer', minimum: -64, maximum: 320 },
    mode: { type: 'string', enum: ['layers', 'top', 'slice', 'column'] },
    axis: { type: 'string', enum: ['ns', 'ew'] },
    only: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 40 } },
  },
});

export function actProblem(input: ActInput): string | null {
  for (const [index, hand] of input.hands.entries()) {
    const problem = handProblem(hand) ?? dependsProblem(index + 1, hand, input.hands.length) ?? (input.repeat === undefined ? null : repeatProblem(hand));
    if (problem) return `手${index + 1}（${hand.do}）: ${problem}`;
  }
  return queueFieldProblem(input);
}
/** The task queue's fields beyond the schema: `repeat` a whole number of 2–8, `done` and `pre` conditions the body reads, `replace` item ids or all. */
function queueFieldProblem(input: ActInput): string | null {
  if (input.repeat !== undefined && !(Number.isInteger(input.repeat) && input.repeat >= 2 && input.repeat <= 8)) return 'repeat は 2〜8 の整数';
  if (input.done !== undefined && !validCondition(input.done)) return 'done が条件の形ではない';
  if (input.pre !== undefined && !validCondition(input.pre)) return 'pre が条件の形ではない';
  if (input.replace?.every(id => /^(?:q[0-9]{1,6}|all)$/u.test(id)) === false) return 'replace は列の項目（q15）か all';
  if (input.dependsOn?.every(id => /^q[0-9]{1,6}$/u.test(id)) === false) return 'dependsOn は列の項目（q12）の並び。何にも頼らないなら []';
  if (input.dependsOn !== undefined && new Set(input.dependsOn).size !== input.dependsOn.length) return 'dependsOn に同じ項目が 2 度ある';
  if (input.uses?.every(id => Number.isInteger(id) && id >= 1) === false) return 'uses は約束の番号（1 から）の並び';
  return keepProblem(input.keep);
}
/** `keep` (amendment A-7 1): up to `KEEP_MAX` entries, each an item (a name or `food`), a whole count and a use of a few words; a refusal shows the form to write. */
export function keepProblem(keep: ActInput['keep']): string | null {
  if (keep === undefined) return null;
  if (!Array.isArray(keep) || keep.length > KEEP_MAX) return `keep は ${KEEP_MAX} つまで: ${KEEP_FORM}`;
  for (const entry of keep) {
    const given = entry as Partial<ActKeep> | null;
    if (!given || typeof given !== 'object') return `keep の中身が 品目:数:用途 の形ではない: ${KEEP_FORM}`;
    if (!promiseItemFits(given.item)) return `keep の品目は物の名前（oak_planks・cobblestone）か food（今は ${JSON.stringify(given.item)?.slice(0, 30)}）: ${KEEP_FORM}`;
    if (!Number.isInteger(given.count) || given.count! < 1 || given.count! > PLAN_LIMITS.promiseCount) return `keep の数は 1〜${PLAN_LIMITS.promiseCount} の整数: ${KEEP_FORM}`;
    if (typeof given.use !== 'string' || !given.use.trim() || given.use.length > PLAN_LIMITS.promiseUse) return `keep の用途は ${PLAN_LIMITS.promiseUse} 字までの言葉: ${KEEP_FORM}`;
  }
  return null;
}
/** A repeated hand that names cells must count them from her feet: the same absolute cells asked again are the same cells. */
function repeatProblem(hand: ActHand): string | null {
  const named = hand.to !== undefined || (hand.path?.length ?? 0) > 0 || (hand.goals?.length ?? 0) > 0 || (hand.at?.length ?? 0) > 0;
  return named && !hand.rel ? 'repeat の手は rel:true で書く（絶対座標の手を繰り返すと同じマスをまた掘る・置くことになる）' : null;
}
/** One hand's fields against its kind, then the checks a kind adds. */
/**
 * An act's result as the body sent it (`ActResult`), or null when it is not one. A line without `goal` and `end` (a body before the contract, a test) gets them from
 * its `status` and the act's `stoppedBy` (continue contract 1: the table's `statusMap`): a done hand is done and finished, a skipped one not started and not run, a hand that
 * stopped on a cut (a reflex, `stopIf`, a full pack, a cancel, the deadline…) partial and cut, any other stopped or failed hand failed and finished.
 */
export function readActResult(text: string | undefined): ActResult | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ActResult>;
    if (!(value && value.v === ACT_CONTRACT_VERSION && Array.isArray(value.lines) && typeof value.done === 'number' && typeof value.of === 'number')) return null;
    const result = value as ActResult;
    const cut = result.stoppedBy !== undefined && result.stoppedBy !== 'failure';
    return { ...result, lines: result.lines.map(line => {
      if (line.goal !== undefined && line.end !== undefined) return line;
      const filled = line.status === 'done' ? { goal: 'done' as const, end: 'finished' as const }
        : line.status === 'skipped' ? { goal: 'not_started' as const, end: 'not_run' as const }
          : line.status === 'stopped' && cut ? { goal: 'partial' as const, end: 'cut' as const, cutBy: result.stoppedBy as CutBy }
            : { goal: 'failed' as const, end: 'finished' as const };
      return { ...filled, ...line, goal: line.goal ?? filled.goal, end: line.end ?? filled.end };
    }) };
  } catch { return null; }
}
/**
 * The act's goal and end: the body's `outcome` when the result has one, else worked out from the lines by the contract's order (`aggregateGoal`; a line without
 * `motorOps` counts one operation unless it was skipped). `end` is `cut` when the act stopped on a cut (`stoppedBy` other than `failure`), `not_run` when no hand ran.
 */
export function actOutcomeOf(result: ActResult): { goal: GoalOutcome; end: RunEnd; cutBy?: CutBy } {
  if (result.outcome) return { goal: result.outcome.goal, end: result.outcome.end, ...(result.outcome.cutBy ? { cutBy: result.outcome.cutBy } : {}) };
  const hands = result.lines.map(line => ({ goal: line.goal ?? (line.status === 'done' ? 'done' : line.status === 'skipped' ? 'not_started' : 'failed'), motorOps: line.motorOps ?? (line.status === 'skipped' ? 0 : 1) }));
  const goal = aggregateGoal(hands, result.doneMet !== undefined);
  const cut = result.stoppedBy !== undefined && result.stoppedBy !== 'failure';
  const end: RunEnd = hands.length > 0 && hands.every(hand => hand.goal === 'not_started') && !hands.some(hand => hand.motorOps > 0) ? (cut ? 'cut' : 'not_run')
    : cut ? 'cut' : 'finished';
  return { goal, end, ...(cut ? { cutBy: result.stoppedBy as CutBy } : {}) };
}
/** A view's result (`ViewResult`), or null. */
export function readViewResult(text: string | undefined): ViewResult | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ViewResult>;
    return value && value.v === ACT_CONTRACT_VERSION && typeof value.map === 'string' ? value as ViewResult : null;
  } catch { return null; }
}

export { handFieldNames } from './minecraftActHandRules.js';
export { ACT_MAX_MS, actMilliseconds, actExpectedMilliseconds, actRemainingMilliseconds, tunedBy, VERTICAL_MS_PER_STEP, verticalSteps, withVerticalSeconds } from './minecraftActTime.js';
export type { ActTimeTuning } from './minecraftActTime.js';
