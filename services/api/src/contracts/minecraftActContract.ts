import { ACT_CONTRACT_VERSION,ACT_MAX_HANDS,HAND_KINDS,VERTICAL_DIRS,VERTICAL_SHAPES,VERTICAL_TOWARDS,VERTICAL_LIQUIDS,EQUIP_SLOTS,KEEP_MAX,
  KEEP_FORM } from './minecraftActTypes.js';
import type { ActHand,ActKeep,ActInput,ActResult,ViewResult } from './minecraftActTypes.js';
export { MC_ACT_SKILL, MC_VIEW_SKILL, MC_ACT_TOOL, MC_VIEW_TOOL, ACT_CONTRACT_VERSION, ACT_MAX_HANDS, HAND_KINDS, VERTICAL_DIRS,
   VERTICAL_SHAPES, VERTICAL_TOWARDS, VERTICAL_LIQUIDS, EQUIP_SLOTS, slotWordOf, HAND_CONTINUES_BY_DEFAULT, handContinuesOnFail, KEEP_MAX,
      KEEP_FORM } from './minecraftActTypes.js';
export type { ActPos, ActFace, HandKind, ActHand, ActStopIf, ActKeep, ActInput, EarlierPass, ActHandLine, EnderEyeFlight, ActResult,
   ViewInput, ViewResult, LlmCentricWorld } from './minecraftActTypes.js';
/**
 * The LLM-centric Minecraft body (design mb-llm-centric, 2026-10-21; head switch the LLM-centric mode, body MINEBOT_LLM_CENTRIC):
 * the head owns this contract, the body follows it (shared note `mb-llm-centric-contract.md`). Four parts:
 *
 * 1. `mc.act` (body skill `act`): up to 12 small hands run in order, each checked; the run stops at the first
 * that does not go as asked,
 *    a reflex, a `stopIf`, or a full pack, and returns one line a hand and a new map.
 * 2. `mc.view` (body skill `view`): a wider or other view of the blocks, when the map of each decision is not enough.
 * 3. The map: a text the body draws (`world.localMap`) in the format and with the symbols below, with landmarks off the map
 *    (`world.mapLandmarks`), the recent stops (`world.recentStops`) and the hidden saturation (`world.saturation`).
 * 4. The plan a command's context carries (`BodyTaskContext.plan`, bodyControlContract.ts), for the ShannonUI mod's task tree.
 *
 * The head sends the definitions below to the model (byte for byte, so the cached prefix holds) and checks an
 * input against them and
 * `actProblem` before the body sees it; the body's own schema must accept every input these accept. The body's
 * result is the JSON of
 * `ActResult` / `ViewResult` in the receipt's `result` (at most 16,000 characters, the receipt's bound).
 */
import { PLAN_LIMITS,promiseItemFits } from '@shannon/mind';
import { CONDITION_SCHEMA,validCondition } from './minecraftActCondition.js';
import { dependsProblem,handProblem } from './minecraftActHandRules.js';
import { aggregateGoal,type CutBy,type GoalOutcome,type RunEnd } from './continueContract.js';

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
 * - Columns are x (west on the left), rows are z (north on top); the header row gives each column's last digit
 * of x, and every row
 *   starts with its whole z. One cell is one symbol and a space.
 * - layers (underground, or no sky above her): y from feet −2 to feet +2; feet −1 … +1 at 15×15 (±7), feet ±2 at 11×11 (±5), a
 *   narrower layer's line naming its range (`y=47 x=196..206 z=272..282`). Where a hostile's feet or a spawner is
 * 3–6 above her within
 *   ±5, the layer of the lowest one and the one over it (11×11) come first (r2, 2026-10-22: run 26's blazes and
 * spawner were 3–4 up,
 *   off the map; the outer layers went to 11×11 for the tokens: the map was about 2,000, twice the design).
 * - surface (sky above her): `方式=surface`: one 21×21 grid (±10) of the top block with its height against her feet as a second
 *   character (cell = symbol + height + space: `#0 :1 wa`), then the 3 layers feet −1 … +1 at 11×11 (±5) as in layers.
 *   Height: 0–9 that many above her feet, + ten or more above, a–i one to nine below, v ten or more below.
 * - Last, in both, her column (`縦`, r2): from the head's cell up and from the cell under her feet down, at most
 * 4 runs of one symbol
 *   within 16 cells, `…` when it goes on: `縦 (201,277) 上: y=46〜53 .×8 / y=54〜61 #×8 …` (run 25: the furnace seven up a shaft).
 * - Water a source is `w`, sand and gravel `s`, crops `k` (r2, 2026-10-22: count_tokens put `~ ` at three tokens
 * a cell and `; ` at two,
 *   a letter at one; a map of a lake was half again as long).
 * - `@` is her feet in its own layer; a hostile's feet `!`, an animal's `m` (in an air cell only); `*` an air
 * cell she walked in the last
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
  ("方式=layers の層: 足 −1〜+1 は 15×15、足 ±2 は 11×11（「y=47 x=196..206 z=272..282」のように範囲を書く）。足の 3〜6 " +
"上に敵（!）かスポナー（S）があれば、その高さの層（11×11）を一番上に足す。"),
  '縦: 足の列の上（頭のマスから上へ）と下（足の下のマスから下へ）を、同じ記号の続きでまとめる。「上: y=46〜51 .×6 / y=52 #」は頭から空気が 6 段、その上が石。… はその先も続く。',
].join('\n');

/** The definition text of `mc.act` the model reads (fixed: part of the cached prefix). */
export const ACT_DESCRIPTION = [
  '体に小さな手を最大12個まとめて頼む。体は順に動かし、手ごとに思ったとおりか確かめ、外れたら（失敗・反射・stopIf・満杯）そこで止めて、手ごとの1行と新しい地図を返す。',
  '体は自分で決めない: 回り道・置き場所・道具作り・片づけ・夜の睡眠・戦うかどうかは、あなたが地図と状態を見て手で出す。',
  '手（do）と引数: walk(to か path, sprint, range: 掘らない・置かない。段差1と泳ぎだけ。地図の外の遠い点は64mごとに区切って歩き、掘る所で止まる) / '
    + ("go(to か goals: 行き先（goals は候補のマス 2〜8、どれか 1 つに着けば済み）, canDig: 掘ってよい物, canPlace: 置いてよい物, maxDrop, waterOk, " +
"seconds, maxDig, maxPlace: ")
    + '道は体が引く。許した物だけ掘り・置いて着くまで歩く。溶岩は避ける) / '
    + ("dig(at: 順に掘る, tool, collect, exposeOk: 敵に見られても掘る, takeOk: 村の物も掘る) / place(block, at, face) / pillarUp(n: " +
"真下に置きながら n 段登る, block) / ")
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
  ("stopIf: hostileWithin（m）・hpBelow・hungerBelow・blockChanged（見張るマス）。満たしたら全体を止めて返す。hpBelow は今の体力より低い値（以上だと 1 " +
"手も動かず止まる）。待つ手の act には hostileWithin。"),
  ("同じ種類の手が続く場面（トンネル・階段・橋・採掘）は、10〜12 手を 1 つの act に入れる（dig の at は 16 マスまで、walk の path は 32 点まで 1 " +
"手に）。止まりは反射・stopIf・onFail が守る。"),
  'accept: この act で戦うと決めた敵の種類（例 ["blaze"]）。体はその敵から下がらず・逃げず・止まらない（盾の構えと火の玉の打ち返しはする）。'
    + '溶岩・溺れ・落下・点火クリーパー・体力8以下の逃走の反射は残る。早めに引くなら stopIf の hpBelow を高めに。',
  ("onFail: 手が自分で失敗した時、continue なら「失」と書いて次の手へ進み、stop ならそこで act を止める。既定は equip・eat・look・sneak・jump が " +
"continue、ほかは stop。")
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
    keep: { type: 'array', maxItems: KEEP_MAX, description: '後で使うために残す物（約束になる）', items: { type: 'object', additionalProperties: false,
       required: ['item', 'count', 'use'],
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
/** The task queue's fields beyond the schema: `repeat` a whole number of 2–8, `done` and `pre` conditions the
 * body reads, `replace` item ids or all. */
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
/** `keep` (amendment A-7 1): up to `KEEP_MAX` entries, each an item (a name or `food`), a whole count and a use
 * of a few words; a refusal shows the form to write. */
export function keepProblem(keep: ActInput['keep']): string | null {
  if (keep === undefined) return null;
  if (!Array.isArray(keep) || keep.length > KEEP_MAX) return `keep は ${KEEP_MAX} つまで: ${KEEP_FORM}`;
  for (const entry of keep) {
    const given = entry as Partial<ActKeep> | null;
    if (!given || typeof given !== 'object') return `keep の中身が 品目:数:用途 の形ではない: ${KEEP_FORM}`;
    if (!promiseItemFits(given.item)) return `keep の品目は物の名前（oak_planks・cobblestone）か food（今は ${JSON.stringify(given.item)?.slice(0, 30)}）: ${KEEP_FORM}`;
    if (!Number.isInteger(given.count) || given.count! < 1 ||
       given.count! > PLAN_LIMITS.promiseCount) return `keep の数は 1〜${PLAN_LIMITS.promiseCount} の整数: ${KEEP_FORM}`;
    if (typeof given.use !== 'string' || !given.use.trim() ||
       given.use.length > PLAN_LIMITS.promiseUse) return `keep の用途は ${PLAN_LIMITS.promiseUse} 字までの言葉: ${KEEP_FORM}`;
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
 * An act's result as the body sent it (`ActResult`), or null when it is not one. A line without `goal` and `end`
 * (a body before the contract, a test) gets them from
 * its `status` and the act's `stoppedBy` (continue contract 1: the table's `statusMap`): a done hand is done and
 * finished, a skipped one not started and not run, a hand that
 * stopped on a cut (a reflex, `stopIf`, a full pack, a cancel, the deadline…) partial and cut, any other stopped
 * or failed hand failed and finished.
 */
export function readActResult(text: string | undefined): ActResult | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ActResult>;
    if (!(value && value.v === ACT_CONTRACT_VERSION && Array.isArray(value.lines) && typeof value.done === 'number' &&
       typeof value.of === 'number')) return null;
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
 * The act's goal and end: the body's `outcome` when the result has one, else worked out from the lines by the
 * contract's order (`aggregateGoal`; a line without
 * `motorOps` counts one operation unless it was skipped). `end` is `cut` when the act stopped on a cut
 * (`stoppedBy` other than `failure`), `not_run` when no hand ran.
 */
export function actOutcomeOf(result: ActResult): { goal: GoalOutcome; end: RunEnd; cutBy?: CutBy } {
  if (result.outcome) return { goal: result.outcome.goal, end: result.outcome.end, ...(result.outcome.cutBy ? { cutBy: result.outcome.cutBy } : {}) };
  const hands = result.lines.map(line => ({ goal: line.goal ?? (line.status === 'done' ? 'done' :
     line.status === 'skipped' ? 'not_started' : 'failed'), motorOps: line.motorOps ?? (line.status === 'skipped' ? 0 : 1) }));
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
export { ACT_MAX_MS, actMilliseconds, actExpectedMilliseconds, actRemainingMilliseconds, tunedBy, VERTICAL_MS_PER_STEP, verticalSteps,
   withVerticalSeconds } from './minecraftActTime.js';
export type { ActTimeTuning } from './minecraftActTime.js';
