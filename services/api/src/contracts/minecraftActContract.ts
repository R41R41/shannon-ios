/**
 * The LLM-centric Minecraft body (design mb-llm-centric, 2026-10-21; head switch SHANNON_MINECRAFT_LLM_CENTRIC, body MINEBOT_LLM_CENTRIC):
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
import type { WorldScan } from './minecraftProbeContract.js';

export const MC_ACT_SKILL = 'act' as const;
export const MC_VIEW_SKILL = 'view' as const;
export const MC_ACT_TOOL = `mc.${MC_ACT_SKILL}` as const;
export const MC_VIEW_TOOL = `mc.${MC_VIEW_SKILL}` as const;
export const ACT_CONTRACT_VERSION = 1 as const;
export const ACT_MAX_HANDS = 12;

/** A block position, or a point to walk to. With the hand's `rel: true`, x/y/z count from her feet block when that hand begins. */
export interface ActPos { x: number; y: number; z: number }
export type ActFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
export const HAND_KINDS = ['walk', 'dig', 'place', 'pillarUp', 'use', 'look', 'jump', 'sneak', 'equip', 'craft', 'furnace', 'chest',
  'attack', 'shoot', 'eat', 'drop', 'pickup', 'wait'] as const;
export type HandKind = typeof HAND_KINDS[number];
export const EQUIP_SLOTS = ['hand', 'offhand', 'head', 'chest', 'legs', 'feet'] as const;

/**
 * One hand. Flat (the wire's schema subset allows `anyOf` of at most 4): `do` names the kind and `actProblem` says which fields each kind
 * takes. Every field a kind does not name must be absent.
 */
export interface ActHand {
  do: HandKind;
  /** walk: where to arrive (within `range`, default 0.5); look: the point to face. */
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
  /** wait: seconds (0.5–30); attack: the most seconds (default 20). */
  seconds?: number;
  /** shoot: seconds to draw (0.2–3, default 1.0: a full bow). */
  charge?: number;
  /** jump: times; pillarUp: blocks to rise (each a jump with a block placed under the feet); shoot: arrows. */
  n?: number;
  /** walk: sprint (default false). */
  sprint?: boolean;
  /** walk: arrive within this many blocks (0–4, default 0.5). pickup: the search radius (1–16, default 6). */
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
export interface ActInput { hands: readonly ActHand[]; stopIf?: ActStopIf; why?: string; accept?: readonly string[] }

/** One line a hand, in order: what was done, or where and why it stopped, or that it did not run. */
export interface ActHandLine {
  i: number; do: HandKind;
  /** `failed` (r3): the hand failed by itself and the act went on past it (`onFail: 'continue'`); its line is written as a stop's. */
  status: 'done' | 'stopped' | 'skipped' | 'failed';
  /**
   * Japanese, at most 160 characters. done: what changed (`(201,45,277)→(205,45,277) 1.2秒`, `丸石×3 を得た`); stopped: the place and the
   * reason in closed words first (`届かない`, `一歩ではない`, `掘れない`, `置けない`, `無い`, `満杯`, `見られる`, `守られた物`, `溶岩が流れ込む`,
   * `足場が無い`, `時間切れ`, `反射`, `stopIf`), then what is there now (`そのマスは stone`); skipped: `未実行`.
   */
  line: string;
  /** stopped: the block or point where it stopped, when there is one. */
  where?: ActPos;
  /**
   * stopped with `where`: the 3×3×3 round it in the map's symbols (r2, 2026-10-22), the top layer first, rows north to south and cells
   * west to east, the middle cell `where` itself: `x=200..202 z=276..278 y=49: #.#/#.#/### y=48: … y=47: …`. At most 120 characters.
   */
  around?: string;
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
  stoppedBy?: 'failure' | 'reflex' | 'stopIf' | 'inventoryFull' | 'cancelled' | 'deadline';
  /** stopIf: which (`hostileWithin:zombie 4.2m`, `hpBelow:7`). reflex: what the reflex did and where she is (`溶岩から上がった (12,64,-3)`). */
  stoppedWhy?: string;
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
  'stopIf: hostileWithin（m）・hpBelow・hungerBelow・blockChanged（見張るマス）。満たしたら全体を止めて返す。',
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

/** The body skills the head offers in the LLM-centric mode beside `mc.act` and `mc.view` (reads only): others are not offered. */
export const LLMC_READ_SKILLS: ReadonlySet<string> = new Set(['find-blocks', 'find-structure', 'list-nearby-entities', 'check-recipe',
  'check-container', 'goal-evidence']);

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
        seconds: { type: 'number', minimum: 0.5, maximum: 30 },
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
      } } },
    stopIf: { type: 'object', additionalProperties: false, required: [], properties: {
      hostileWithin: { type: 'number', minimum: 1, maximum: 32 },
      hpBelow: { type: 'number', minimum: 1, maximum: 20 },
      hungerBelow: { type: 'number', minimum: 0, maximum: 20 },
      blockChanged: { type: 'array', minItems: 1, maxItems: 4, items: pos('見張るブロック') },
    } },
    why: { type: 'string', maxLength: 120, description: 'この手の組のねらい（短く）' },
    accept: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 }, description: 'この act で戦うと決めた敵の種類（体はそれから逃げない）' },
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

/** What each kind takes: required fields, then the optional ones; any other field is a problem. */
const HAND_FIELDS: Readonly<Record<HandKind, { needs: readonly (readonly string[])[]; may: readonly string[] }>> = {
  walk: { needs: [['to', 'path']], may: ['sprint', 'range'] },
  dig: { needs: [['at']], may: ['tool', 'collect', 'exposeOk', 'takeOk'] },
  place: { needs: [['at'], ['block']], may: ['face'] },
  pillarUp: { needs: [['n']], may: ['block'] },
  use: { needs: [['item']], may: ['at', 'face', 'target'] },
  look: { needs: [['to', 'yaw']], may: ['pitch'] },
  jump: { needs: [], may: ['n'] },
  sneak: { needs: [['on']], may: [] },
  equip: { needs: [['item']], may: ['slot'] },
  craft: { needs: [['item']], may: ['count'] },
  furnace: { needs: [['at'], ['op']], may: ['item', 'count', 'fuel', 'fuelCount'] },
  chest: { needs: [['at'], ['op']], may: ['items'] },
  attack: { needs: [['target']], may: ['untilDead', 'seconds', 'hold'] },
  shoot: { needs: [['target', 'at']], may: ['item', 'charge', 'n'] },
  eat: { needs: [], may: ['item'] },
  drop: { needs: [['items']], may: ['target', 'at'] },
  pickup: { needs: [], may: ['target', 'range'] },
  wait: { needs: [['seconds']], may: [] },
};
const COMMON = new Set(['do', 'rel', 'note', 'onFail']);
/** The fields a kind of hand takes (needed, then optional, then the common ones), for a refusal that names them. */
export function handFieldNames(kind: HandKind): string[] {
  const fields = HAND_FIELDS[kind];
  return fields ? [...fields.needs.flat(), ...fields.may, 'rel', 'note', 'onFail'] : [];
}
const ONE_AT: ReadonlySet<HandKind> = new Set(['use', 'furnace', 'chest', 'shoot', 'drop']);

/** What is wrong with an act's hands beyond the schema (a field a kind does not take, a missing one), or null. Closed words, Japanese. */
export function actProblem(input: ActInput): string | null {
  for (const [index, hand] of input.hands.entries()) {
    const problem = handProblem(hand);
    if (problem) return `手${index + 1}（${hand.do}）: ${problem}`;
  }
  return null;
}
/** One hand's fields against its kind, then the checks a kind adds. */
function handProblem(hand: ActHand): string | null {
  const fields = HAND_FIELDS[hand.do];
  if (!fields) return 'do が分からない';
  const allowed = new Set([...COMMON, ...fields.may, ...fields.needs.flat()]);
  const extra = Object.keys(hand).filter(key => !allowed.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（${hand.do} の欄: ${handFieldNames(hand.do).join('・')}）`;
  const missing = fields.needs.find(group => !group.some(key => (hand as unknown as Record<string, unknown>)[key] !== undefined));
  if (missing) return `${missing.join(' か ')} が要る`;
  if (ONE_AT.has(hand.do) && hand.at && hand.at.length !== 1) return 'at は 1 つ';
  return KIND_CHECKS[hand.do]?.(hand) ?? null;
}
const KIND_CHECKS: Partial<Record<HandKind, (hand: ActHand) => string | null>> = {
  furnace: hand => !['put', 'take'].includes(hand.op!) ? 'op は put か take' : hand.op === 'put' && !hand.item && !hand.fuel ? 'put には item か fuel' : null,
  chest: hand => hand.op === 'put' && !hand.items?.length ? 'put には items' : null,
  wait: hand => hand.seconds! < 0.5 || hand.seconds! > 30 ? 'seconds は 0.5〜30' : null,
};

/** An act's result as the body sent it (`ActResult`), or null when it is not one. */
export function readActResult(text: string | undefined): ActResult | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ActResult>;
    return value && value.v === ACT_CONTRACT_VERSION && Array.isArray(value.lines) && typeof value.done === 'number' && typeof value.of === 'number'
      ? value as ActResult : null;
  } catch { return null; }
}
/** A view's result (`ViewResult`), or null. */
export function readViewResult(text: string | undefined): ViewResult | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ViewResult>;
    return value && value.v === ACT_CONTRACT_VERSION && typeof value.map === 'string' ? value as ViewResult : null;
  } catch { return null; }
}

/**
 * The time of each hand, from what it is asked (r2, 2026-10-22; run 27: a walk of 80 m west had a ceiling of 11.6 s whatever its length,
 * and 4 of the first 5 acts were cut at their deadline; its 2.4 s guess never asked the next decision ahead):
 * - walk: the way's length from where she will stand when it begins (her feet, then each hand's end) through `path` or to `to`,
 *   across and up; typical at 4.3 m/s, the ceiling at half that (a way round) plus 3 s; 32 m when where she stands is not known;
 * - dig, place: by the cells; pillarUp, jump, shoot: by `n`; attack and wait: by `seconds`; craft: by `count`; the rest fixed.
 */
const WALK_MPS = 4.3, SPRINT_MPS = 5.6, UNKNOWN_WALK_M = 32;
/** The longest act (the body's own bound is 180 s; the command adds its margin). */
export const ACT_MAX_MS = 170_000;
type HandTime = (hand: ActHand, metres: number) => number;
const cells = (hand: ActHand) => hand.at?.length ?? 1, times = (hand: ActHand) => hand.n ?? 1;
const walkMs = (hand: ActHand, metres: number) => 1_000 * metres / (hand.sprint ? SPRINT_MPS : WALK_MPS);
const CEILING_MS: Partial<Record<HandKind, HandTime>> = {
  walk: (hand, metres) => 3_000 + 2 * walkMs(hand, metres), dig: hand => 10_000 * cells(hand), place: hand => 1_500 * cells(hand),
  pillarUp: hand => 1_200 * times(hand), attack: hand => 1_000 * (hand.seconds ?? 20) + 2_000,
  shoot: hand => (1_500 + 1_000 * (hand.charge ?? 1)) * times(hand), wait: hand => 1_000 * (hand.seconds ?? 1) + 500,
  pickup: hand => 3_000 + 1_000 * (hand.range ?? 6), use: () => 4_000, craft: hand => 2_000 + 300 * Math.min(64, hand.count ?? 1),
  jump: hand => 1_000 * times(hand) + 500, chest: () => 6_000, furnace: () => 5_000, eat: () => 4_000,
};
const TYPICAL_MS: Partial<Record<HandKind, HandTime>> = {
  walk: (hand, metres) => 500 + walkMs(hand, metres), dig: hand => 900 * cells(hand), place: hand => 400 * cells(hand),
  pillarUp: hand => 600 * times(hand), attack: hand => Math.min(8_000, 1_000 * (hand.seconds ?? 6)), wait: hand => 1_000 * (hand.seconds ?? 1),
  eat: () => 1_700, pickup: hand => 1_000 + 300 * (hand.range ?? 6), use: () => 1_000, shoot: hand => (500 + 1_000 * (hand.charge ?? 1)) * times(hand),
  craft: hand => 500 + 150 * Math.min(64, hand.count ?? 1), jump: hand => 600 * times(hand), chest: () => 1_500, furnace: () => 1_200,
  equip: () => 300, look: () => 200, sneak: () => 200, drop: hand => 300 * (hand.items?.length ?? 1),
};
const distance = (from: ActPos, to: ActPos) => Math.hypot(to.x - from.x, to.z - from.z) + Math.abs(to.y - from.y);
/** Each hand with the metres it walks: from `from` (her feet when the act begins), each hand starting where the one before ended. */
function handMetres(input: ActInput, from: ActPos | null): Array<{ hand: ActHand; metres: number }> {
  let at: ActPos | null = from ? { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) } : null;
  return input.hands.map(hand => {
    if (hand.do === 'pillarUp' && at) at = { ...at, y: at.y + times(hand) };
    if (hand.do !== 'walk') return { hand, metres: 0 };
    const points = (hand.path?.length ? hand.path : hand.to ? [hand.to] : []).map(point => hand.rel && at
      ? { x: at.x + point.x, y: at.y + point.y, z: at.z + point.z } : point);
    if (!points.length) return { hand, metres: 0 };
    let metres = 0;
    if (hand.rel && !at) metres = points.reduce((sum, point, index) => sum + distance(index ? points[index - 1]! : { x: 0, y: 0, z: 0 }, point), 0);
    else if (!at) metres = UNKNOWN_WALK_M + points.slice(1).reduce((sum, point, index) => sum + distance(points[index]!, point), 0);
    else metres = points.reduce((sum, point, index) => sum + distance(index ? points[index - 1]! : at!, point), 0);
    at = hand.rel && !at ? null : points[points.length - 1]!;
    return { hand, metres };
  });
}
/** How long an act may run on the body: the sum of each hand's ceiling, within 5 s and `ACT_MAX_MS` (the command adds its own margin). */
export function actMilliseconds(input: ActInput, from: ActPos | null = null): number {
  const total = handMetres(input, from).reduce((sum, { hand, metres }) => sum + (CEILING_MS[hand.do]?.(hand, metres) ?? 2_000), 0);
  return Math.round(Math.max(5_000, Math.min(ACT_MAX_MS, total)));
}
/** How long an act is likely to take (for asking the next decision while it runs). */
export function actExpectedMilliseconds(input: ActInput, from: ActPos | null = null): number {
  return Math.round(handMetres(input, from).reduce((sum, { hand, metres }) => sum + (TYPICAL_MS[hand.do]?.(hand, metres) ?? 400), 0));
}
