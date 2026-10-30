import { PLAN_LIMITS } from '@shannon/mind';
import type { WorldScan } from './minecraftProbeContract.js';
import { type ActCondition } from './minecraftActCondition.js';
import { type ActOutcome, type EventsMore, type Handover, type HandOutcome, type InventoryEvent } from './continueContract.js';

export const MC_ACT_SKILL = 'act' as const;

export const MC_VIEW_SKILL = 'view' as const;

export const MC_ACT_TOOL = `mc.${MC_ACT_SKILL}` as const;

export const MC_VIEW_TOOL = `mc.${MC_VIEW_SKILL}` as const;

export const ACT_CONTRACT_VERSION = 1 as const;

export const ACT_MAX_HANDS = 12;

/** A block position, or a point to walk to. With the hand's `rel: true`, x/y/z count from her feet block when
 * that hand begins. */
export interface ActPos {
  x: number;
  y: number;
  z: number;
}

export type ActFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

export const HAND_KINDS = [
  'walk',
  'go',
  'dig',
  'place',
  'pillarUp',
  'use',
  'look',
  'jump',
  'sneak',
  'equip',
  'craft',
  'furnace',
  'chest',
  'attack',
  'shoot',
  'eat',
  'drop',
  'pickup',
  'wait',
  'obsidian',
  'fight',
  'mine',
  'make',
  'portal',
  'smelt',
  'vertical',
] as const;

export type HandKind = (typeof HAND_KINDS)[number];

/** vertical (continue contract 6): the way down or up, the form of the climb or descent, the compass words of
 * `toward`, and what to do at a liquid. */
export const VERTICAL_DIRS = ['down', 'up'] as const;

export const VERTICAL_SHAPES = ['stairs', 'shaft', 'pillar'] as const;

export const VERTICAL_TOWARDS = ['north', 'east', 'south', 'west'] as const;

export const VERTICAL_LIQUIDS = ['stop', 'seal', 'seal_water'] as const;

export const EQUIP_SLOTS = ['hand', 'offhand', 'head', 'chest', 'legs', 'feet'] as const;

/**
 * The slot words of `equip` the body takes are hand, offhand, head, chest, legs and feet. Bench 2026-10-24 (run
 * 38 d127, the iron armour made and put on): 2 answers of 3 wrote
 * `equip iron_chestplate torso` (the live state's worn line says 頭・胴・脚・足・左手), and the act was refused. Amendment
 * A-11 3 (a real run: `equip shield slot=off-hand` was refused
 * and the act that broke the promise was sent): the plain variations of the hand words (`off-hand`,
 * `main_hand`…) are read as the body's. Only what is plainly the same word.
 */
export const SLOT_WORDS: Readonly<Record<string, string>> = {
  torso: 'chest',
  body: 'chest',
  chestplate: 'chest',
  helmet: 'head',
  leg: 'legs',
  leggings: 'legs',
  boots: 'feet',
  foot: 'feet',
  mainhand: 'hand',
  main: 'hand',
  main_hand: 'hand',
  'main-hand': 'hand',
  off: 'offhand',
  off_hand: 'offhand',
  'off-hand': 'offhand',
  頭: 'head',
  胴: 'chest',
  脚: 'legs',
  足: 'feet',
  右手: 'hand',
  左手: 'offhand',
};

/** The body's slot word for a word the model wrote (the word itself when it is not one of the variations). */
export const slotWordOf = (word: string): string => SLOT_WORDS[word.trim().toLowerCase()] ?? word;

/**
 * One hand. Flat (the wire's schema subset allows `anyOf` of at most 4): `do` names the kind and `actProblem`
 * says which fields each kind
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
  /** place/pillarUp: the block to place (pillarUp default: the most numerous of cobblestone, cobbled_deepslate,
   * dirt, netherrack). */
  block?: string;
  /** use/equip/craft/eat/shoot: the item (use: water_bucket, bucket, lava_bucket, flint_and_steel, ender_eye, a bed, a door…). */
  item?: string;
  /** craft: how many of `item`; furnace put: how many of `item`. */
  count?: number;
  /** drop/chest take/chest put: the items and counts (count absent: the whole stack kind). */
  items?: readonly { item: string; count?: number }[];
  /** furnace put: the fuel and how many. */
  fuel?: string;
  fuelCount?: number;
  /** furnace: put | take; chest: look | take | put | takeAll. */
  op?: 'put' | 'take' | 'look' | 'takeAll';
  /** attack/shoot/pickup/drop: an entity, `#<id>` or a name (the nearest of that name). drop: throw toward it. */
  target?: string;
  /** attack: go on until it is dead (default true); false with `seconds`: hit for that long. */
  untilDead?: boolean;
  /**
   * attack: hold the place (run 26, the blaze spawner): stand where she is, face the nearest `target` and hit it
   * whenever it comes within
   * reach, for `seconds` (or until `stopIf`); never chase. Without it an attack chases by walk's rules (no
   * digging: it stops and says so).
   */
  hold?: boolean;
  /** wait: seconds (0.5–30); attack: the most seconds (default 20); go: the most seconds the hand may take (5–120, default 60). */
  seconds?: number;
  /** shoot: seconds to draw (0.2–3, default 1.0: a full bow). */
  charge?: number;
  /** jump: times; pillarUp: blocks to rise (each a jump with a block placed under the feet); shoot: arrows. */
  n?: number;
  /**
   * go (run 39): where she may go instead of `to`: 2–8 cells, any one of which ends the hand (the way to the
   * nearest is taken). The model lists the cells; the
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
  maxDig?: number;
  maxPlace?: number;
  /**
   * Run 39 (2026-10-26), the hands that take a range from the model and work out the small moves themselves (`go`,
   * `obsidian`, `fight`, `mine`,
   * `make`, `portal`,
   * `smelt`; `docs/minecraft-hands-2026-10.md`): the model decides what, where and how far, and what may be done;
   * the body does the seconds-fine work. Never a
   * search of its own beyond what the model named; always a limit and the counts back.
   * fight: `flee` runs from the target instead of fighting (default fight); `retreatHp` leaves the fight and eats
   * or runs when health falls under it (1–19).
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
  slot?: (typeof EQUIP_SLOTS)[number];
  /** sneak: on or off. */
  on?: boolean;
  /** look: compass degrees (0 north, 90 east, 180 south, 270 west) and pitch (−90 up … 90 down), instead of `to`. */
  yaw?: number;
  pitch?: number;
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
   * r3 (run 27: [equip stone_sword, walk away] stopped at the equip, "持っていない", and the walk away from a creeper
   * never ran): when this
   * hand fails by itself, `continue` writes it as `failed` and goes on to the next hand; `stop` ends the act
   * there. A reflex, a `stopIf`, a
   * full pack, a cancel and the deadline end the act whatever this says. Default (`handContinuesOnFail`): continue
   * for the quick hands
   * that leave the world as it was (equip, eat, look, sneak, jump), stop for every other kind.
   */
  onFail?: 'continue' | 'stop';
  /**
   * vertical (continue contract 6: a hand of `mc.act` that digs, places and walks one step at a time, with no path
   * search; `canDig`, `canPlace`, `maxDig`,
   * `maxPlace`, `range` and `seconds` are the fields above, shared). The model decides the way, the form and how
   * far; the body never changes them.
   * `dir`: down | up, always written (not read from where she stands). `shape`: stairs | shaft (straight down,
   * `dir` down only) | pillar (straight up on a block put under
   * her feet, `dir` up only). `toward`: stairs only (required there), the compass way the stairs lead. `toY`: the
   * feet's y to reach (−64 … 320).
   * `liquid`: lava or water seen — stop | seal and go on | seal_water (seal water, stop at lava); `range` (1–2) is
   * how far round the cell a seal reaches.
   */
  dir?: 'down' | 'up';
  shape?: 'stairs' | 'shaft' | 'pillar';
  toward?: 'north' | 'east' | 'south' | 'west';
  toY?: number;
  liquid?: 'stop' | 'seal' | 'seal_water';
  /**
   * Continue contract 2: the numbers (1 up, `ActHandLine.i`) of the earlier hands of the same act and the same
   * pass that this hand relies on. Absent: as before, an
   * earlier hand that stops stops this one too. `[]`: it relies on no hand and goes even when an earlier one
   * failed. `[1,3]`: it goes only when hand 1 and hand 3
   * reached what they aimed at (done or already, finished). A hand that did not run, or that depends on one that
   * did not, is not something to rely on.
   * `onFail: continue` does not excuse the check. Itself, a later hand, a number out of range and a repeated
   * number are refused before the body sees them.
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
 * `accept`: the hostile kinds she takes on in this act (`blaze`, `enderman`, `piglin`…; run 26: the fast
 * judgment's shelter and flee cut
 * 27% of her calls at the spawner). For those kinds, while the act runs, the body does not back off, flee, dodge
 * by moving, refuse an
 * exposed dig, or stop on `stopIf.hostileWithin`; the shield's guard and a fireball's deflection still act
 * without stopping the act.
 * The reflexes of section 6 of the shared note stay (lava, drowning, falling, a lit creeper, and the low-health
 * flight at health 8).
 */
/**
 * A thing the act says to keep for later (amendment A-7 1; written `keep=spruce_planks:4:作業台`, item:count:use):
 * the head turns each into a promise of the plan when it
 * sends the act (`FcaPlanPort.keepPromise`). It is the head's: it is not in the arguments sent to the body, and
 * it does not put the promise in the act's `uses` (`uses` is
 * what the act says it spends; `keep` says what is left aside).
 */
export interface ActKeep {
  item: string;
  count: number;
  use: string;
}

/** At most this many `keep` entries in one act; a count is a promise's (1 up to `PLAN_LIMITS.promiseCount`) and a
 * use is at most `PLAN_LIMITS.promiseUse` characters. */
export const KEEP_MAX = 4;

export const KEEP_FORM =
  `keep=spruce_planks:4:作業台（品目:数:用途。複数はコンマで keep=spruce_planks:4:作業台,cobblestone:8:かまど。品目は物の名前か food、数は 1〜${PLAN_LIMITS.promiseCount}、` +
  `用途は ${PLAN_LIMITS.promiseUse} 字まで、${KEEP_MAX} つまで）`;

export interface ActInput {
  hands: readonly ActHand[];
  stopIf?: ActStopIf;
  why?: string;
  accept?: readonly string[];
  /**
   * The task queue (design 2026-10-26): `repeat` runs the hands up to that many times (2–8; relative hands only,
   * or the same cells are asked again);
   * `done` ends the act as done the moment it holds (the body checks it at every tick); `pre` is checked once
   * right before the act starts (it
   * travels in the queue envelope, not in the act's arguments); `replace` names the queued items to take off first
   * (the head applies it).
   */
  repeat?: number;
  done?: ActCondition;
  pre?: ActCondition;
  replace?: readonly string[];
  /**
   * Continue contract 2 and 3 (the head reads them; they are not in the arguments sent to the body, as `pre` and
   * `replace` are not): `dependsOn` the marks of the
   * queue items of the same queue that this item relies on (`q12`; `[]` relies on none; absent: it is dropped when
   * the item before it stops, as before) and
   * `uses` the numbers of the promises of the plan this act says it uses (the head keeps the promises' definitions
   * as they are when it sends the act).
   */
  dependsOn?: readonly string[];
  uses?: readonly number[];
  /** Amendment A-7 1: what to keep for later (the head only; see `ActKeep`). */
  keep?: readonly ActKeep[];
}

/** The older passes of a repeating act whose lines were folded into counts (amendment A-6 11; the body's form,
 * one entry a pass): how many hand lines it had, how many hands were done and how many stopped. */
export interface EarlierPass {
  pass: number;
  lines: number;
  done: number;
  stopped: number;
}

/** One line a hand, in order: what was done, or where and why it stopped, or that it did not run. */
export interface ActHandLine {
  i: number;
  do: HandKind;
  /** `failed` (r3): the hand failed by itself and the act went on past it (`onFail: 'continue'`); its line is
   * written as a stop's. */
  status: 'done' | 'stopped' | 'skipped' | 'failed';
  /**
   * Japanese, at most 160 characters. done: what changed (`(201,45,277)→(205,45,277) 1.2秒`, `丸石×3 を得た`); stopped:
   * the place and the
   * reason in closed words first (`届かない`, `一歩ではない`, `掘れない`, `置けない`, `無い`, `満杯`, `見られる`, `守られた物`, `溶岩が流れ込む`,
   * `足場が無い`, `上から落ちる`, `時間切れ`, `反射`, `stopIf`), then what is there now (`そのマスは stone`); skipped: `未実行`.
   */
  line: string;
  /** stopped: the block or point where it stopped, when there is one. */
  where?: ActPos;
  /**
   * stopped with `where`: the 3×3×3 round it in the map's symbols (r2, 2026-10-22), the top layer first, rows
   * north to south and cells
   * west to east, the middle cell `where` itself: `x=200..202 z=276..278 y=49: #.#/#.#/### y=48: … y=47: …`. At
   * most 120 characters.
   */
  around?: string;
  /**
   * Continue contract 1 (flat on the line): what the hand aimed at and how its run ended (`HandOutcome`), and
   * `motorOps`, the number of operations it made the body
   * carry out (amendment A-1 1: it tells `failed` from `not_started`; a skipped hand has none). The body always
   * sends them; a result without them (an older body,
   * a test) is read by `readActResult`, which fills `goal` and `end` from `status` (a done hand is done and
   * finished, a skipped one not started and not run, any
   * other one failed and finished).
   */
  goal?: HandOutcome['goal'];
  end?: HandOutcome['end'];
  cutBy?: HandOutcome['cutBy'];
  code?: string;
  progress?: HandOutcome['progress'];
  delta?: HandOutcome['delta'];
  pass?: number;
  motorOps?: number;
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
  done: number;
  of: number;
  stoppedBy?: 'failure' | 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline' | 'noProgress' | 'damage' | 'fall';
  /** stopIf: which (`hostileWithin:zombie 4.2m`, `hpBelow:7`). reflex: what the reflex did and where she is
   * (`溶岩から上がった (12,64,-3)`). */
  stoppedWhy?: string;
  /** r10 (the body): the act came while a reflex held the body and began when it let go ("反射
   * flee（低体力の逃走）の最中のため、放された後に始めた（待ち 1.6秒）"). */
  afterReflex?: string;
  lines: readonly ActHandLine[];
  /** Where she stands and her health and food after the act. */
  at: ActPos;
  hp: number;
  food: number;
  /** The map after the act (same format as `world.localMap`). The head reads the newest map from the frame; this
   * one is for a reader of the result alone. */
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
   * Continue contract 1 (the body always sends it; `actOutcomeOf` reads it, or works it out from the lines when an
   * older result lacks it): the act's two axes and the life it ran in.
   * `handover`: a reflex held the body and let go on the act's own target (chapter 4). `eventsMore`: where the
   * inventory events that did not fit are fetched.
   * `earlierPasses` and `earlierEvents`: when the older passes' lines were folded into a count to keep the result
   * small, their events are not dropped, they are carried
   * here (the lines of the newest passes stay in `lines`).
   */
  outcome?: ActOutcome;
  handover?: Handover;
  eventsMore?: EventsMore;
  earlierPasses?: readonly EarlierPass[];
  earlierEvents?: readonly InventoryEvent[];
}

export interface ViewInput {
  /** Default: her feet. */
  center?: ActPos;
  /** Blocks out from the centre (1–32, default 12). */
  radius?: number;
  /** Absolute y bounds (default: centre −4 … +4; `top` ignores them). */
  yFrom?: number;
  yTo?: number;
  /** layers: one grid per y; top: the surface from above with heights; slice: a vertical cut through the centre;
   * column: the x,z column. */
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
   * she is in (run 26: an overworld crafting table read as 3 m away in the Nether); a place of another dimension,
   * when worth saying (the
   * gate back, her base), starts with that dimension in brackets and gives no distance: `[overworld] T 作業台 (10,35,15) 拠点`.
   */
  mapLandmarks?: readonly string[];
  /** The structure she is in or beside (run 26): `ネザー要塞の中`, `砦の遺跡（bastion）の脇`, `ストロングホールドの中`, `村の中`, `エンドシティ`; absent: none. */
  inside?: string;
  /** The recent stops, at most 5 lines, newest first: `(x,y,z)→(x,y,z) 理由 ×回数 N秒前`. Counted by the body, never acted on by it. */
  recentStops?: readonly string[];
  /** The hidden food saturation (0–20). */
  saturation?: number;
  /** r4: the body's own `scan` at a spawn, a new dimension or a respawn (`WorldScan`, `minecraftProbeContract.ts`);
   * absent until the first. */
  scan?: WorldScan;
}
