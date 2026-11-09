import { MAP_LEGEND_V2 } from '../../contracts/minecraftMapLegendV2.js';
import { NETHER_BY_SECONDS, PREP_DESCENT_RULE, PREP_RULES_WORDS, SAFETY_FIRST } from './minecraftLlmcPrepRules.js';
import { factsIn, hasKind, nearKinds } from './minecraftPlanFacts.js';
import type { PlanKind } from '@shannon/mind';
import { FOOD_ACQUISITION_KNOWLEDGE } from './minecraftFoodAcquisition.js';
/**
 * mb-llmc v2 (改修案 2.1): the mode's instructions and knowledge, cut once more from `minecraftKnowledgeCore.ts` (own prompt):
 * - `V2_ALWAYS`: what every decision needs (how to decide, how to read the live state, the map, falls, enemies, the plan). With the header,
 *   the decision protocol and the reading (`anthropicFcaMinecraftSystem.ts`) it is the cached system text, aimed at three thousand tokens.
 * - `V2_STAGES`: the knowledge of a stage of the route (materials, the Nether, the blazes, the pearls and eyes, the End), which the code picks
 *   from the plan's current node, the dimension and what has happened (`stagesFor`) and puts after the cache's last mark, before the live state
 *   (`stageKnowledge`). The own-prompt text had all of them in the cached text (1.8k tokens) for every decision.
 * What each rule of `minecraftKnowledgeCore.ts` became is in `docs/minecraft-llmc-v2-2026-10.md`. A line is for what no code says or keeps:
 * the walk's rules are `around` and `route`, the stops of the map are the act preflight's. Change these words only between supervised runs.
 */
/**
 * The goal and the owner's yardstick (mb-llmc-cand 11, chapter 4 A): the numbers are `DRAGON_MILESTONES` (`minecraftLlmcRoad.ts`), one constant.
 * GPT's blind review of the prompt (2026-10-28, owner approved): the rules a decision follows (the order of priority, the preparation, the urgent answer, what
 * a reason does not skip) are here in the instructions; the live state and the results say facts and states only. A rule is said once: the number of acts is
 * `V2_DECIDE`'s and the limit of hands `mc_act`'s; the descent's requirement is `PREP_DESCENT_RULE`'s (also the first plan's).
 */
const GOAL = [
  '## 目的と物差し',
  `- 目的は課題の goal。持ち主の物差しは速さ: エンドラ討伐なら 3 時間以内（理想 1.5 時間）。ネザーへ入るまでは ${Math.round(NETHER_BY_SECONDS / 60)} 分ほど（準備を含む）で、なめらかに。`,
  '- 速さと同じだけ、生きていることが大事。死ぬと持ち物と時間を失い、用心より時間がかかる。',
  '- 優先の順: 差し迫った危険を避ける → 準備の必須を満たす → 目的へ早く進める。時間を理由に止めたり、早く完了にしたりしない。目安は物差しで、手を決める物ではない。',
].join('\n');

/** The descent's preparation as a rule for choosing the action (one place; the live state and the results say only the state of it). */
const PREP = PREP_DESCENT_RULE;

const DECIDE = [
  '## 決め方（手の書き方は mc_act）',
  '- 毎判断、live の urgent・planNow・shortage・footing・around・route・threats・lastResults と plan を読んで決める。',
  '- 結果を待たずに決められる手（作る・持ち替え・食べる・拾う）は次の移動と同じ act へ。同じ手の連続は repeat と done・mine の count・go の seconds。'
    + '動く対象・未知経路は結果を読み直す。途中失敗で後の手は未実行。'
    + '後続の前提は dependsOn。進行中の手は危険・失敗・目的変更時だけ replace。後で使う物は act の keep に書く（帳簿に載る）。約束の物は残し、割るなら why に番号と理由。',
  '- 範囲スキルでは目的・対象・行き先・掘る/置く許可・済む条件を選ぶ。食事・睡眠・片づけ・戦うか逃げるかもあなたが決める。'
    + '経路・工作・設置・戦闘の細部は体に任せる。',
  '- why は節の札で始める（「[p1.2] 丸石でハーフブロック」）。別の節なら番号と理由を書く。数は観測済みと「これから」を分ける。',
  '- 履歴は act の各手の行（周り・地図・probe の長い答えは lastResults に一度だけ）。後で要る座標・危険は plan か why に書く。'
    + '止まったら未成立の前提を直す。同じ手を同じまま出さない。座標・向き・上限だけ変えても、同じ障害や許可不足が残る場合がある。',
  '- 分からない時・同じ止まり 2 回・落ちた時・live に look が出た時は、調べる判断で mc_view か mc_probe（同じ止まり→history と path か sight、落ちた→column、敵→around）。'
    + 'investigation に原因が出ていればそれを使う。原因が分かったら plan_update の forbid（してはいけない事）か caution（気をつける事）の op で、今の節に 1 行書く（plan.rules に出る）。',
  '- wait だけの act は夜・回復の待ちで他に手が無い時だけ、why に待つ対象と理由。',
  '- 「見られる」で止まったマスを exposeOk で掘り直さない。見られない別のマス（敵と反対側・下の岩）を掘る。敵のいる側へ近づく向きに掘らない・歩かない。'
    + 'attack が「届かない」で 2 回止まった的は追わない（hold で来るのを待つか離れる）。食料・盾・金の防具が無いまま遠出して敵を追わない。',
  '- 自分で書いた注意（plan.rules）に反して節を飛ばさない。次元が変わったら scan と landmarks を見て計画を見直す。',
].join('\n');

/**
 * An urgent decision (GPT's review 2026-10-28: the rule was in the live state's 「answer」, a live that is data; it is here, the live state says only
 * that it is the short one).
 */
const URGENT = [
  '## 急ぎの時',
  '- live の mode が「急ぎの版」の判断: 考えは 2〜3 文、mc_act は 1 つ・手は合わせて 3 つまで、why は 20 字まで（「[急ぎ] …」）。'
    + '離れる・敵との間にブロックを置く・囲う・食べるを、採掘や工作より先に。足場が「押されたら落ちる」なら、空所から離れるのが先。',
].join('\n');

/**
 * The dictionary of the live state (D3): every field the model may see, one line each: what it is, its units, what its absence means. Notion 09-1c 2-2
 * P1 (2026-10-24): an absent field is not an absent fact (a field is cut by relevance, unmeasured, unloaded, past its range, or left out of the urgent
 * state); the plan's done is a count of nodes, its next is the order, not what can be done now.
 */
const LIVE = [
  '## live の項目辞典（コードが作った事実で、手は決めない）',
  '- 出ていない項目は「無い」とは限らない（関係で省いた・未測定・未ロード・範囲外・急ぎの版）。安全や成否を左右する不明だけ probe か view で調べる。',
  '- plan: done（済み扱いの節/全体。達成率ではない）・next（予定の次 3 節。すぐできるとは限らない）・blocked・rules（今の節と親の禁止・注意の行。forbid・caution で書いた行と頭が事実で足した行。最大 8）。'
    + '済む条件（doneWhen）は観測で満たされるとコードが済みにする（今済んだ印ではない）。',
  '- urgent: 急ぎの理由（敵が近い・体力が低く敵がいる・前の act が反射か stopIf で止まった）。mode「急ぎの版」は急ぎの時の短い live の印。',
  '- planNow: 今の節「[p6.4] 題（済む条件: …／今: 未: 足りない物 数/要る数）＠座標（道: 親›子）」。今: は条件を今の観測で読んだ結果。'
    + 'road・meter（エンドラ討伐だけ）: road は最上位の節の順（✓ 済み・◀今・（止）止めた・（未・飛ばした）今より前の開いた節）、meter は開始からの秒と次の節目の「あと」か「遅れ」（準備の節目は今の数付き）。',
  '- shortage: 今の段階（ダイヤの前・ネザーの前・奥・エンド）に足りない準備と着ていない防具。recovery: 体力が自然に戻らない事実と食料の当て。footing: 足元の空所の数と「押されたら落ちる」。',
  '- around: 足の周りの歩ける所。最初の 10 行は足の 8 方向の 1 歩・頭の上・足の下（掘らず置かず、上り 1・下り 3、斜めは角の列が空く時だけ）。'
    + 'その後は水平 6 マスの足・頭・床を高さ別に、完全な座標で。書いていない所は固い岩（掘って通る）か地図に無い所（不明）。「掘る (x,y,z) 石の類（溶岩の隣: …）」は、開けると溶岩が流れ込むマス。',
  '- away: 急ぎの敵から離れる、掘らずに歩ける隣（「は無い」= どれも近づくか、掘る・置くが要る）。route: 今の節の＠座標への道（掘らずに行ける最も近い立ち位置・道の点・掘り k マス）。敵と体力は見ない。目的地が地図の外なら、その先の道は不明。'
    + 'liquid・obsidian: 水・溶岩・黒曜石の近い順の距離・届くか（5m まで）・間のブロック（obsidian は黒曜石の節だけ。水と溶岩の両方に隣り合うマス＝開けると出会う）。',
  '- pack: 持ち物の空きマスと、拾い続けた石や土が占める所。使用数は省いた分も含めた全部から数える。',
  '- repeat・look・investigation: 同じ止まりが 2 回以上の事実・調べる事実（落ちた・溺れかけた・大きく打たれた）・驚きの後に頭が調べた probe の答え。stops・jobs・events: 最近の止まり・かまどなど外の仕事と残り秒・前の判断の後の出来事。',
  '- map: 層ごとの地図（around と route の元。記号は下の凡例）。landmarks: 目印（[overworld] 付きは別の次元。方角・上下は今の足から）。scan: 体の走査（次元変化などの後に 1 回）。'
    + 'lastResults: 履歴に無い前の結果を 1 回だけ（止まった手の周りの 3×3×3・view の地図・probe の続き）。',
  '- state: 位置 at・inside（今いる構造物）・worn（防具の耐久 残り/最大）・health（0〜20。ハート 1 個 = 2）・fullness（満腹 0〜20）・'
    + 'fullnessLostIn5min・saturation（隠れた満腹）・oxygen（息 n/20）・minutes（課題の経過分）。'
    + 'inventory: 持ち物（品目×数）。「ほか N 件は略」= 省いた分（省いた物は無いとは限らない）。',
  '- foodPoints: total（食料の点＝持ち物の食べ物の合計。満腹 fullness とは別）・items。',
  '- threats: 敵 1 体 1 行（#id 名前 距離 (座標) 方角・見え方）。行になるのは 24m 内（クリーパー・エンダーマン 32m、飛び道具の種類 48m）。'
    + '見え方: 見える（射線の中）= 撃たれる所 / 見えない・道はある = 回って来る / 壁の向こうで届かない = 急ぎではない / 飛び道具 = 遠くから撃つ種類 / 無い = 未測定。残りは「ほか N 体」。'
    + 'near: 敵でない生き物と落ちている物（16m 内）。',
  '- queue: 体の列。▶ が実行中（残りの秒・手の進み）、・が待ち。足せる数も出る。',
].join('\n');

const MAP = [
  '## 地図（予備）',
  '- 足=(x,y,z) が足のマス、頭は y+1。層は全部同じ範囲。',
  // The body's legend, word for word (mb-llmc-cand 2): its symbol lines and the surface form's. The layers' ranges are the v2 map's own (above).
  ...MAP_LEGEND_V2.split('\n').slice(0, 10),
  '縦: 足の列の上下（「上: y=46〜51 .×6 / y=52 #」= 空気 6 段の上が石）。',
].join('\n');

const FALLS = [
  '## 落ちる・水・溶岩・空所',
  '- 高さの差が大きい上り下りは vertical、横の移動と短い段差は go。素手で真下へ掘らない。水の中や真上では下へ掘らない。溶岩（L・l）の隣は掘らない・歩かない。降りてよいのは落差 n≤3、4 以上は vertical の stairs か着地点に水。',
  '- 空所（溶岩の海・深い穴・崖）は、縁より 1 段下の岩のトンネルか、1 マスごとに足元と両脇に置いた壁付きの橋で渡る。壁の無い幅 1 の橋は使わない（押されると落ちる）。'
    + 'footing に「押されたら落ちる」がある間は、立ち止まらない・跳ばない・縁で積まない。',
].join('\n');

/** The coordinator, 2026-11-03 (leg 2's plan 5.10: the sea and the night on the 1.4 km walk, the phantoms for a body that has not slept). */
const LONG_WALK = '- 地上の長い歩き（1 km 超）は朝に出る。ベッドで寝ると夜を飛ばせる。';
/** The coordinator's outside view of 11/4 (night-rules-external-20261104.md): the hour to stop starting, the night before the armour, the climb. */
const PREP_NIGHT_STOP = '- ベッドがあれば、11500 を過ぎて地上にいたら長い移動・探索を始めず、洞窟から離れた岩の中に 1×2 を掘って塞ぎ、12542 に寝る（敵は壁越しでも水平 8・上下 5 で寝させない）。'
  + 'sleep の手は起きたらベッドを拾い直す。鉄の兜・胸の前は夜に地上を歩かない。地上に着くのが 12500〜23500 になるなら岩の中で寝てから上る。';
/**
 * With 12 eyes on the ground the stages are prep and stronghold at once, and prep's "walk long ways in the morning" and "stop starting at 11500"
 * went in with the stronghold's "go on through the night, no hole before dark" (the outside review of 11/10, Q1; end1109s14's detour to a village
 * to sleep, ~190 s, may be this). While the stronghold stage is on, its night line is the only one: these two are taken out of prep's text.
 */
const PREP_NIGHT_LINES: ReadonlySet<string> = new Set([LONG_WALK, PREP_NIGHT_STOP]);
const PREP_NIGHT_ELSEWHERE = '- 夜と長い道の動き方は、下のストロングホールドの段の行に従う（材料の段の「朝に出る」「11500 を過ぎたら始めない」はこの場面では使わない）。';
function stageText(id: StageId, ids: readonly StageId[]): string {
  if (id !== 'prep' || !ids.includes('stronghold')) return V2_STAGES[id];
  const lines = V2_STAGES.prep.split('\n');
  const at = lines.findIndex(line => PREP_NIGHT_LINES.has(line));
  const kept = lines.filter(line => !PREP_NIGHT_LINES.has(line));
  kept.splice(at < 0 ? 1 : at, 0, PREP_NIGHT_ELSEWHERE);
  return kept.join('\n');
}

const DANGER = [
  '## 敵と体力',
  '- 体の反射（溶岩・溺れ・落下・燃え・クリーパー・飛び道具・体力 8 以下の逃走・瀕死の食事・打ち返し）は体がして、act を止めて何をしたかを返す。その先はあなたが出す。',
  '- 危ない act には stopIf: 夜・洞窟・ネザーは hostileWithin 8〜12（クリーパーは 10）、射線の中を通る act は hpBelow 12 前後（今の体力より低く）、待ち打ちは hostileWithin。'
    + 'accept に入れた種類は hostileWithin に数えない（fight の相手もその手の間は同じ）。hpBelow と反射は accept でも効く。戦うと決めた敵だけ accept に入れ、ほかの敵で止めたい act には hostileWithin。'
    // end1109f12b: a go with accept [wither_skeleton] dug through the wall to it; struck from 20 to 10 on the way, then lost the trade at 12.
    + 'go の accept に近接敵を入れない（止まらず敵の隣を歩き続ける。その方へ行くなら先に fight か別の方角。go は壁も掘る）。',
  '- 体力 8 以下では戦わない: sprint で離れる→囲う（足の周り 4 面と頭の上）→食べる→満腹 18 以上で wait（自然回復は満腹 18 以上のみ）。ベッドは夜に寝る（ネザー・エンドのベッドは爆発する: そこでは寝ない）。夜の露出や敵 2 体以上は先に囲うか避ける。',
  '- 体力が戻らない間（満腹 18 未満。recovery が出る）は、下りる・戦う前に食べる。敵が近くても 1 個食べてから（1.6 秒）。戻らないまま下りたり戦ったりすると、落下や矢 2〜3 発で死ぬ。',
  '- 「今いる所は … から見える」と出たら、囲う・食べる前に見えない所へ。壁の向こうの敵は急ぎではない。',
  '- 近接敵（ピグリン・ゾンビ・ウィザースケルトン・溺死ゾンビ）には歩いて逃げ切れない。回復しない時・夜・敵2体以上は体力8超でも、食べるか間に2マスplace。柱はpillarUp 2、ウィザースケルトンは3段。跳ぶ頭上の空間も確認。'
    + '鉄以上の剣があり体力 8 超で遮れない時は打ち返す（equip→accept→attack target=#id untilDead。禁止・shortage に反しない時）。'
    + 'ウィザースケルトンとは体力 14 以上で斬り合う（1 打ち 4〜8 と毒。12 からは 2 打ちで死ぬ）。',
].join('\n');

const PLAN = [
  '## 計画',
  '- 計画は自分のもの（順を変える・足す・割る・blocked と reason）。済んだ・止まった・変えた時だけ plan_update。順を守る（例: 鉄の剣を作った後にネザーへ）。'
    + '節を飛ばす・後回しにする時は reason に理由を書く。',
  '- 体が別の節の項目を続けて始めると、頭が今の節をその節へ動かすことがある（戻すのは plan_update の current）。今の節が未達の準備の節の間は動かない。',
  '- 済む条件（doneWhen）と、消費して無くなる物の子の閉じ方は plan_update の説明。shortage は戦い・奥への移動の前に埋める。',
].join('\n');

/** The text every decision reads (the knowledge part of the cached system text). */
export const V2_ALWAYS = [GOAL, PREP, DECIDE, URGENT, LIVE, MAP, FALLS, DANGER, PLAN].join('\n\n');

export type StageId = 'prep' | 'nether' | 'blaze' | 'pearl' | 'stronghold' | 'end';
export const STAGE_IDS: readonly StageId[] = ['prep', 'nether', 'blaze', 'pearl', 'stronghold', 'end'];
/** The knowledge of each stage, cut from the own prompt's 材料と手順 / ネザー・要塞・ブレイズ / パール・アイ・エンド. */
export const V2_STAGES: Readonly<Record<StageId, string>> = Object.freeze({
  prep: [
    '## 材料と手順',
    LONG_WALK,
    '- ファントムは 3 夜寝ていないと夜に現れることがあり、空から急降下して襲う。',
    '- ベッドで寝ると、ファントムが現れるまでの不眠の数えが戻る。',
    '- 夜（オーバーワールド）は、sleep の手で寝て朝にする（体が持っているベッドを置き、朝に拾い直す）（夜は敵が増え、ファントムも来る）。ネザー・エンドでは寝ない（爆発する）。',
    PREP_NIGHT_STOP,
    '- バケツを作ったら最初の水源ですぐ汲む（run61 は空のまま地上を通り、地下で 6 分探した帰りに死んだ）。',
    // run62 (11/5): the pickup's walk went onto the magma floor of a ruined portal; two deaths and the diamond pickaxe were lost there.
    '- 壊れたポータルの周りはマグマの床が多い。拾いに歩く前に、足元とその先のマグマを丸石か土で覆う（途中の足場の安全は保証されない）。立っている段は掘らない。',
    '- 夜明けの森のスケルトンとゾンビは、木の下の日陰では燃え残る（朝でも森の中は安全ではない）。',
    '- 走査の「壊れたポータル」（荒廃したポータル）が近ければ序盤に寄る: 箱に金の防具・火打ち金・ファイヤーチャージ・黒曜石があることがある。'
      + '枠の黒曜石はダイヤのツルハシで掘れる（泣く黒曜石は枠にならない）。火打石は砂利を掘ると 1 個 10%（置いて掘り直せる）。火打ち金と矢の分がそろうまで砂利は捨てない。',
    '- waterOkは入水の許可で、呼吸できる道の保証ではない。地下水や天井下へ入る前に、column・地図で頭を空気へ出せる地点と戻る通路を確認し、移動・採掘・回収・戻りの時間を残りの息と比べる。'
      + '空気の地点や往復が不明なら入らず、乾いた通路の迂回か乾いた足場からの採掘を選ぶ。上が水や岩なら真上へのgoだけでは逃げられない。'
      + '水中で息が減ったら採掘や後続の手を止め、確認した空気へ戻る。浮上反射の開始は呼吸回復ではない。水中で地図の読取りや掘る探索を重ねる時間も息を使う。'
      + '退路をactの末尾に書いても、先の失敗・期限切れでは動かない。水中作業の失敗後は、待つ列を足さず単独の帰還へreplaceし、呼吸回復後に次を決める。',
    '- 掘る経路は地図・columnで通路と頭上の材質を調べ、今の道具で掘れる岩・鉱石・土砂を用途に合わせてcanDigに選ぶ。'
      + 'stoneの許可に鉱石は含まれない。cannot_digは具体的な材質と道具・重力・液体を確認して許可か経路を直し、短く進んで再観測する。秒数や向きだけ変えない。',
    '- 高所から下りる前は column で通過空間と着地の床・水を確かめる。つたの途中は着地ではない。階段・足場と実在する着地点へのgoを比べ、水に入るならwaterOk・許す落差maxDrop、葉等を通るならdigを指定。つたが切れた所から着地までの落差も数える。',
    FOOD_ACQUISITION_KNOWLEDGE,
    '- foodPreparation は加工の見込み。炉・作業台・燃料・設置場所と加工後の持ち物を観測で確かめる。',
    '- jobs は見込み。保留・再接続後は残り秒で待ち直さず furnace op=take で現物確認。焼き待ち・夜待ちの間は、焼き上がりに頼らない採取・作業台・食料と帰路を進める。',
    '- ベッドのある安全な囲いでは、射線・敵の到達・足場を確かめ、朝待ちと調理・工作・近くの夜の狩り（食料源の選び方の条件）を比べる。ベッドが無い夜は朝待ちを選ばず、次の順番に従う。',
    // 1107c (11/7): with no bed the head waited 13 of its 19.6 minutes in a dirt pocket, 11 blocks above the iron shaft's depth. The owner: food first by day,
    // iron can be dug at night, and the bed matters most. 1107d (11/7): the line presupposed an enclosure; on a jungle top the dirt ring had no face
    // (nothing_to_set_against), the head waited 4 minutes in the open and a zombie killed it. One ordered rule now, the shelter first and anywhere.
    // (margin.descentKit / gated never reaches the head's input: read1107d3 found it in none of the 285 non-assistant entries, so it is not explained here.)
    '- ベッドが無い夜（暗くなる少し前から朝まで）の順番: '
      + '① 木・葉・柱の上なら、まず地面（土・石の上）へ下りる（葉や空気の隣には何も置けない）。'
      + '② その場で足元を 2 段掘って入り（vertical の shaft で toY を今の足の y−2）、頭の上に土か丸石を 1 個置いて塞ぐ。4 方に壁を建てるより速く、地面ならどこでも作れる囲い。'
      + '③ 石のツルハシがあれば、その底から facts の「鉄」の行の鉄鉱石へ vertical（stairs）で toY まで掘り下り、鉄・石炭を掘る（「鉄」の行が無ければ mc_probe kind=scan の鉄鉱石の行の座標へ）（地下の暗さは昼も夜も同じで、塞いだ縦穴なら夜でも危険は増えない。洞窟に抜けたら塞ぐ）。'
      + '満腹度 14・体力 16 以上なら食料 40 点の前でもよい。石のツルハシが無ければ、囲いの中で工作・調理をする。'
      + '④ 囲いの外で wait しない（外の待ちは敵に見つかる）。朝になったら地上へ戻り、食料とベッドの続きをする（ベッドが一番: 寝れば夜を飛ばせる）。',
    '- 死んだ後は最新の持ち物・着ている物・敵から計画を組み直す。危険な死亡地点へ裸で直行しない。まず安全な所で道具・食料・盾や防具を作り直す選択と回収を比べる。'
      + '済んだ道具取得の節は履歴であり、今使える道具ではない。回収するなら最新nearの対象と実際の高さ・道・敵を確かめ、現装備での回収と再調達を比べる。'
      + '移動が時間切れでも距離が縮まらない時、秒数を増す・goをwalkへ替えるだけでは道はできない。乾いた側から通路を整えるか、回収を打ち切り準備へ計画を組み直す。'
      + '対象が消えpickupでも見つからなければ、過去の個体を当てに再入水しない。最後に通過した地表は落とし物の位置とは限らない。',
    '- 射手に撃たれている間は、分かっている敵の向きと足場から射線を切る・離れる手を先に選ぶ。'
      + '同じsight・around・columnを何度も読む間も攻撃される。追加の読取りは逃げる手を決めるために必要な不明だけに絞り、工作・回収・食事は安全な位置で行う。'
      + 'ウィッチは例外: 薬（毒・負傷）は 10m 先まで投げ、走って離れる背中にも当たる（end1110r1 は 2.8m から逃げて 6 秒で体力 7→0）。'
      + '4m 内なら離れずに fight（target=#id・一番強い斧か剣）で打ち続ける（体力 26・石の斧で 3〜4 打ち）。体力が低くても近ければ打つ方が生き残る。10m より遠い時だけ、壁の陰へ入って見えなくする。',
    '- 食料が少ない時は、今見えている動物・作物・箱と、手持ちの調理見込みを先に使う。鶏しか見えなくても食料源であり、地下へ行けば補えるという根拠にはならない。'
      + '周りに無ければ食料探索の過去観測と比べ、地表の未探索方向を短い中継点で探す。到着後にscanかaroundで現在の個体を確かめてから狩る。'
      + '未確認のcow→pig→sheep等をfightに並べると、最初の対象なしで後ろも未実行になる。過去の個体は移動・消失していることがある。',
    '- 食料の所在と到達・加工を分ける。未知の場所の食料を当てに準備を省かない。省略を選ぶなら、今の携帯食料・防具・実在する補給先・戻り方を比べてprepの理由と計画に残す。'
      + '「探索に時間がかかった」「既に地下」「skippedを書いた」だけでは、食料や防具は補えない。箱は食料入りとは限らず、建物と周囲の敵を確かめる。射手のいる建物へ無防備で食料を取りに行かない。',
    '- 地下で食料を補えない時は、帰還の観測記録と以前の通過点から戻る道を比べ、pathやcolumnで短い区間ずつ確認する。'
      + '通過記録は逆向きの安全を保証しない。新しい穴を掘り続ける前に既存の階段・通路を調べる。水や鉱石の座標は地上の出口ではない。'
      + '魚は見えた個体と岸・水面の出入口を確かめて狙う。魚を探すためだけに地下から水の天井を開けない。',
    '- 地上へ上る時は、live の「下りた跡」を逆にたどる道と、新しく掘り上がる道を比べる（run61: 新しい水・岩の階段で 7 分かかり、上りの途中の洞窟 y44 で'
      + '日の出の約 3 分後にゾンビ 4 体に囲まれて死んだ）。上りで同じ所の止まりが 2 回続いたら、足の周りと頭の上を塞いでから道を組み直す。'
      + '地下・洞窟は朝でも暗く敵が湧く: 朝になったことを洞窟を通る理由にしない。',
    '- 補助の魚を取ると選んだ時だけ、岸から届くかsightで調べ、狙う個体を選んでfightへ追従と武器の持替えを任せる。attackを選ぶなら先に手の武器を確認する（食後は食べ物や空手のことがある）。動く魚の過去座標へgoしてから複数個体を攻撃する列にはしない。'
      + '潜るなら先に氷などの出入口を開け、水へ入れたことと戻る穴・息を確認する。goの水中の上下移動は、体の幅と高さが通る既知の静水の通路だけで、氷や壁を越えない。'
      + '1個体の結果後に持ち物と落ちた食料を確かめ、回収・加工・補給の成果で続行を決める。呼吸の反射後は水面への復帰を先にし、深い魚の追跡と届く別個体・地上の食料を比べる。',
    '- 準備の必須と目標は system の「準備の決まり」。ここは材料と手順の知識。食料の点（live の foodPoints.total。満腹 fullness とは別）は、ネザーの奥へ 100、エンドへ 330（焼き牛 16。最低 80）。'
      + 'かまどの燃料は石炭を先に取る（石炭 1 で 8 個。鉄 24 と肉なら石炭 4〜6）。原木・板は道具と作業台の分で燃やさない（run62: 燃やして、下で作業台が作れなかった）。'
      + '鉄と一緒に肉も焼く。食べ物の当てが近ければ、取るのは数十秒〜2 分。',
    '- 石で鉄を掘る間は最初の延べ棒3個で鉄のツルハシを先に作る。棒・作業台を確認し、make の手持ち加工と不足一覧を使う。防具全量を待たない。',
    '- 以後は所持・作成済みを引いた残りをまとめて掘り焼く（鉄は総目安24〜36・石炭6）。生の鉄5以上は smelt furnaces=2〜3 に分け（1個10秒）、jobs の残秒で掘る・作る。',
    '- 木は、足の高さから幹に届く木か、走査の近い原木を選ぶ。崖の上・高い所の木へ土で登る手が 2 回止まったら、その木はやめて別の木へ。',
    '- 木が無い時: 地表の木（mc_probe kind=scan で原木の方角・mc_view mode=top で上から）→村の木の物（扉・柵・ベッド・作業台・板、takeOk）→難破船→廃坑（vertical の stairs で下りる）。',
    '- 村は鉄より前に 128m 内を回る（takeOk: true。鉄ゴーレムと村人は打たない）: ベッド（下の決まり）、干し草（1 個でパン 3）、育った畑、箱は chest op=look→take。',
    PREP_RULES_WORDS,
    SAFETY_FIRST,
    '- 鉄は facts の「鉄」の行・走査の鉄鉱石の行・地図の i の座標へ掘りに行く（全体では y=16 前後に多いが、座標の分かる鉄があれば y=16 まで下りなくてよい。埋まった近い鉄は遠くの空気に面した鉄より早い）。ダイヤは y=-58 前後（d、鉄のツルハシ）。水バケツは水源（w）の隣から use（流れ - からは汲めない）。',
    '- 資源のマスと作業の立ち位置は別。距離や数より、通れる道・高低差・掘る/置く許可・視線と足場を比べる。'
      + '今届く操作に移動は不要。不明な経路は path、操作の届き方は sight、上下は column で確かめる。'
      + 'search_timeout 後は、観測した10m以内の立てる中継点か短い階段へ区切る。遠い資源の高さだけ変えて繰り返さない。',
    '- 頭上の砂・砂利で止まったら、落下する列の外に床と頭の空間がある作業位置を取る。水の隣・流れる先・退路も先に確認する。'
      + 'そこから届く支えは横から dig し、不要な pillarUp を先に挟まない。届かない時だけ sight・column で作業高さを決める。'
      + '掘った後は落下と水流が落ち着くのを待ち、地形を読み直してから進む。支えを掘れたことと、通路ができたことは別。waterOk だけで水中を真上に登れるとは限らない。',
    '- 黒曜石は現在数と不足分を数え、到達できる溶岩源 L と既存の O を組み合わせて集める。同じ作業位置から続けて取れる源も比べる。多い溜まりでも道が未確認なら早いとは限らない。'
      + '水入りバケツ・ダイヤpick・作業位置を先に確保し、obsidian に対象・足場に使う物・採掘の上限を渡す。注水・待機・採掘・回収・水の汲み戻しはこの手が行う。'
      + '同じ高さでつながった源は 1 回の注水で面を固め、続けて掘る。'
      + '22 個なら源 22 マスを at に挙げ、count=22・seconds=300 で 1 手にできる（count 省略時は at の数、seconds は 5〜300・既定 90）。'
      + '手動で水を置くなら、先に乾いた作業位置・流れる先・源を回収できる視線を確かめる。水を置いてから流れに逆らう移動を前提にしない。'
      + '手で掘る時は足元・立っているマスからは離れたマスを開ける。'
      + '失敗後は実在庫と世界を読む。置いた水は持ち物の water_bucket ではない。源を汲み戻してから水バケツが必要な手を再開する。',
    '- ゲートは portal の手（枠の内側の左下と向き。黒曜石10・火打ち金（鉄1・火打石1）かファイヤーチャージ（荒廃したポータルの箱））が組んで点けて入る。',
    '- portal の at の 1 段下が枠の下の段。'
      + 'そこや内側が土・草・石の類・砂利・ネザーラック・玄武岩・魂の砂なら体が掘ってから置く。'
      + '泣く黒曜石もダイヤのツルハシがあれば掘る。村や人の物・液体では止まる。',
    '- 点火は火打ち金を先に使い、無ければファイヤーチャージ。'
      + '火打石を待つ間に enter:false で枠だけ先に組める（点ける物が無くても ok、行に「点火は未」）。',
    '- すでに点いたポータル（p ネザー・e エンド）の入り方: そのマスの中へ walk（range=0。足と頭がポータルのマスで、下は枠の黒曜石）して、約 4 秒立って待つ。着いた先が次元の変化。'
      + 'ポータルのマスには place できず、その上面は床ではない。',
    '- ネザーで作り直す: 真紅・歪んだ幹（素手で可）→板（1 で 4）→作業台（持ち歩く）・棒。丸石 3→ハーフブロック 6。盾は板 6・鉄 1 で offhand に equip。'
      + '金の防具は延べ棒 4（靴）〜5（兜）。',
  ].join('\n'),
  nether: [
    '## ネザーと要塞',
    SAFETY_FIRST,
    '- ネザーの x・z はオーバーワールドの 1/8（ネザーの座標をオーバーワールドの go に使わない。オーバーワールドでは 8 倍）。帰りのゲートの座標を where に書く（帰りも p のマスの中へ walk して約 4 秒待つ）。y=31 より下は溶岩の海、マグマ（M）は燃える。',
    '- ピグリンは金の防具を 1 つ着るまで襲う（着るまでピグリンの群れ・砦の遺跡の 8m 内に長居しない）。金を掘る・箱を開けると怒る。',
    // Rig end1109f01 (c1): an unprovoked zombified piglin came 5 m near, the decision struck it, its group answered and she died without a hand.
    '- ゾンビピグリン（zombified_piglin）は中立: こちらが殴るまで襲わない。1 体を殴ると、近くのゾンビピグリン全部が怒って一斉に来る（1 体 20 の体力・金の剣で、数体に囲まれると鉄の防具でも数秒で死ぬ）。'
      + '中立（殴らなければ来ない）・地図の & は attack・accept しない（道の上なら回るか待つ）。体が怒りを知るのは最初に殴られた後なので、1 体でも殴った後・2 体以上がまっすぐ寄って来る時は threats に出る前でも怒っているとみる: 開けた所で戦わず 1 幅の通路か 2 段の柱へ退いて 1 体ずつ斬る。',
    '- 要塞（N）: 着いたら world.scan の「ネザーの区画」を見る。'
      + '432m 四方に要塞か砦のどちらか 1 つがあり、今の区画の x・z の範囲と、見えた他の区画が出る。',
    '- 区画が「要塞」ならその方へ進める。'
      + '「砦（この区画に要塞は無い）」なら隣の区画が候補で、境から 50m 以上入って mc_probe kind=scan radius=16 で読み直す（高い所から mc_view mode=top でも見る）。',
    '- 区画が「未確認」で読み込みが 9 割未満なら、待つか読めていない側へ 150m 進んで読み直せる（go は 1 手 90m 以内）。'
      + '向きに手がかりが無い時は z 軸（南北）を先に、それでも無ければ直角の向きが候補になる。',
    // Rig end1109f10 (random world, the spawner some 830 m off; the old "10 m relay" line further down taught the hand-dig): west 90 m, then south, then west again, then south (33 min, no fortress); after a search_timeout
    // she dug by hand 1 cell a decision (about 10 m in 3 min); a group of plain skeletons (a soul sand valley) was read as the fortress's sign.
    '- 200m 内に要塞が無い時: 1 つの方角を決め、新しい区画の答え（要塞・砦）が scan に出るまでその方角を変えない（行き来すると同じ所を 2 度通る）。'
      + 'go は 1 手 60〜90m で出し続け、道探しが時間切れでも同じ方角の 20〜40m 先へ出し直す（1 マスずつ手で掘る判断を重ねると 3 分で 10m しか進まない）。'
      + 'ふつうの skeleton の群れはソウルサンドの谷のしるしで、要塞のしるしではない（要塞のしるしは nether_bricks・wither_skeleton・blaze）。',
    '- world.scan は描画の距離の 9 割まで最大 30 秒待つ。'
      + '足りなければ、着いてから 120 秒まで、読み込みが 20% 増えるごとに読み直す。',
    '- scan の「描画の距離の 39%」はまだ 9 割未満。'
      + '「読み込めた約 121m までに無い（この先はまだ読めていない）」は、その先の不在を言わない。'
      + '「この範囲に無い」は 9 割以上読めた時だけの表現。',
    '- 要塞やスポナー（S）の近くでは通路を歩かず、床より 1 段下の岩に 1 幅 2 高のトンネルを掘って進む（足と頭を dig→1 歩）。射線の中で立ち止まらない'
      + '（wait・食べる・作るは見えない所で）。',
    '- ガストの火の玉は体が打ち返す。溶岩の縁・橋の上で撃たれたら岩の側へ寄って受ける（押されて落ちるのが多い死に方）。ウィザースケルトンは近づかれる前に離れる。',
    '- ポータルの対は live の「控え」の行（ネザー側の座標 ↔ 向こう側の座標）。ネザーで死ぬと持ち物はそこに約 5 分残る（近くにいる間だけ減る）。'
      + 'リスポーンはベッドか最初の場所（オーバーワールド）。取りに戻るか装備を作り直すかは、最後の死の行の残り時間と比べて決める。',
    '- sprint は書かない時、体が安全な所だけ走る（溶岩・火・マグマが 2 マス内に無く、隣に maxDrop を超える崖が無い所）。'
      + '走らせたくない時だけ sprint:false。sprint:true は常に走る指定で、3 マスの溝の走り跳びには sprint:true を書く。',
    '- ソウルサンドの上は歩幅が 4 割（時間 2.5 倍）。go の経路探索は、回り道が少し長いだけなら避けて回り、他に道が無ければ渡る。',
    '- 遠い go（要塞が見えるまでの道）は最初から canDig=[netherrack,basalt,blackstone]（要塞の床・壁へ入るなら nether_bricks も）・canPlace=[cobblestone,netherrack]'
      + '・maxDig 120〜200・maxPlace 40〜100・seconds 100〜120 が目安になる。'
      + 'ただし maxPlace は「いま持っている置ける物の数 − 32」まで（1 回の go で使い切ると、橋の途中で置く物 0 になって進めも戻れもしない）。'
      + '出る前に丸石か netherrack を 64 個以上持つと橋の材料になる。'
      + 'ネザーでは掘る経路の費用が 2.5 倍で、体は開けた所や丘の上を選びやすく、掘った netherrack の補充は当てにしにくい。'
      + '既定の maxDig 40・maxPlace 24 では limit_dig・limit_place で止まることがある。',
    // Rig end1109f11 (random world): two far gos with maxPlace 60 and 80 laid all 128 cobblestone over a void, leaving her on a plank bridge with nothing to place.
    // Rig end1109f01 (c1): a go from 25 m short of the fortress to the spawner with canPlace laid 32 cobblestone as a bridge over a 17-deep gap
    // and she fell to health 10; the gap she fell into is where the zombified piglins were.
    '- go の canPlace は、空所（落差のある所）の上では壁の無い幅 1 の橋と柱を置いて渡る（壁を置くのは溶岩の上だけ）。'
      + 'だから要塞・スポナーの近く（要塞が見えてから、スポナーの足場まで）の go は canPlace を付けず、canDig だけで岩の中を通す。'
      + '岩の中に道が無い（no_path・search_timeout）なら、空所を渡らず、岩のある側へ回る中継点・トンネル（上の 1 段下の岩）・vertical up stairs で高さを合わせる。'
      + 'go の道に「幅 1 の橋」「押されたら落ちる」が出たら、その go は止めて岩の側へ戻る。',
    // end1109f13 (random world): a go with canPlace from the rim of a lava lake (the lava 4 below) stepped off while laying the first floor; she could not climb
    // the 4-high wall out of the lava and died in 5 s (the lava-escape reflex jumped in place).
    '- 溶岩の湖（縁の下に溶岩が見える空所）は渡らず回る: go に canPlace を付けず canDig だけで岸の岩の中を通すか、湖の無い方角を選ぶ'
      + '（縁で最初の床を置く間に溶岩へ落ちると、3 段以上の岸は登れず数秒で死ぬ）。',
    '- 溶岩を渡る go は先に回り道を探す。'
      + 'それでも溶岩の上に床を置く時は、体が両脇の床と足の高さの壁も置くので、place を 1 マスずつ出す必要は無い。'
      + '溶岩 1m につき最大 5 個使うため、maxPlace 40〜100 と材料に余裕が要る。',
    // end1108b S8b (Haiku): 40 cobblestone went into a bridge over the lava sea, she then dug the bridge's own blocks for more, they fell into
    // the lava, and she was left on a column one block wide until the request failed.
    '- 溶岩や空所の上の橋・柱にいる間は、自分が置いた床と両脇を掘らない（掘った物は下の溶岩へ落ちて拾えず、立つ所が減る）。'
      + '置く物が残り 16 個を切ったら、橋の先へ進まず、来た道を陸（ネザーラックの地面）まで戻り、足場ではない壁や丘のネザーラックを掘って 64 個以上にしてから進み直す。'
      + '要塞が溶岩の海の向こうの高い所にある時は、海の上の長い橋より、陸の岩の中を要塞の高さへ上る階段（vertical up stairs）と岩の中のトンネルを先に比べる。',
    '- ポータルの手（enter）で入ると、その act は「次元が変わった…（手の途中）」と止まって返る（入れた印で、失敗ではない）。入った直後の 60 秒は、scan と landmarks で足元と溶岩を確かめてから動く。'
      + 'ゲートの出口の高さは、地上の枠の高さとは限らない（出口が溶岩の岸のことがある）。着いたら、足元と溶岩を確かめる。',
    '- go は 1 手 90m 以内に分ける。limit_time は、同じ行き先をそのまま出し直せば着く。'
      + 'ただし search_timeout（道探しが終わらない）が続く所は、出し直しても同じ所で止まる: 同じ go を繰り返さず、同じ方角の 20〜40m 先の立てる所を行き先にして区切る（10m 未満に刻む・1 マスずつ手で掘ると、判断の回数ばかり増えて 1 分に数 m しか進まない）。'
      + '同じ所から同じ探しが 2 回時間切れになると、体も直線上 24m、次に 12m の中継点で区切る（1 回の go で 6 回まで）。'
      + '体の行に「体が中継点（n 回）でも進めなかった」と出たら、行き先を変える合図になる。'
      + 'limit_place は置く物の上限（置く所が maxPlace の残りを超える）なので、1 手を短くするか maxPlace を上げる。',
    // run62 (11/5): five deaths to wither skeletons, the body met three at once in the open.
    '- ウィザースケルトン（背が 2.4 マス）は 2 マスの穴に入れず、柱は 3 段で届かない（2 段では届く）。2 体以上なら開けた通路で戦わず、2 段で塞ぐか 1×2 のトンネルへ下がる。'
      + '床1段下の1×2退避路も、入口・開口の射線、近敵の間合いと逃げ道は別に確認する。',
    '- ブレイズの湧き場（要塞）から出る前に体力を戻す（要塞の生き物を残して出ると、ウィザースケルトンとブレイズに囲まれて体力が短い間に尽きかねない）。足場の外へ出てからは、出口側へ短い go を重ねる。',
    '- 道のバイオームで危険が変わる: 玄武岩の三角州・荒地は静かで、真紅の森（crimson_forest）にはピグリンとホグリンが湧く。'
      + '金の防具を 1 つ着ていないとピグリンは敵になるので、真紅の森を避ける道を選ぶか、金のブーツを先に作る（金 4 がそろう時）。',
    // S8's lab of 11/5 (go 204f7aa): 144 m at 1.02 m/s, 249 m at 1.49 m/s; a hoglin took her from 20 to 7 near the warped forest.
    '- 速さの目安は 1 ブロック 0.7〜1.0 秒（岩をくぐる所は 1 秒前後。溶岩の岸では溶岩よけの反射が go を止めることがある）。溶岩上の壁付きの橋は、床だけの橋より材料を多く使う。',
    // Rig end1109f15: three hoglins in a crimson forest at the start; she fought one by this line's "先に倒す" and four hits took her from 20 to 0 in 70 s.
    '- 開けた所を走るので、ホグリン（体力 40・1 撃 5 前後）に寄られやすい。斬り合わない（f15：4 撃で体力 20→0）。見えたら go の行き先をそれから離す。寄られたら 2 段積んで上に立つ（届かない）。',
    '- go が止まったら、体の行の言う通りに直して同じ先へもう一度 go する: limit_dig・limit_place は上限を増やす（「maxDig を増やす」）、dead_end の「が nether_bricks で登れない」は'
      + '「canDig に足す」、no_blocks は行が名指しする物（「荷の netherrack×99 を canPlace に足す」）を足す、「置く物 cobblestone を N 個置いて使い切った」は置く物を足すか補う。'
      + 'low_floor と「置いたブロックが世界に現れない」の時は、同じ go をもう一度で進んだ。マグマの上で反射が体を握っている間（urgent の「反射の最中」）は、送った手は動かない'
      + '（run62: 送り直し続けて 2 分半焼かれた）: 反射が放すのを待ち、放したら足元を丸石か土で覆うか、マグマの無いマスへ 1 手で出る。火のマスは dig で消せる（unsafe の行が「火 (x,y,z) は dig で消せる」と言う）。',
    '- 要塞を探す: mc_probe kind=scan が「ネザー要塞」の向きを言う。近づいたら mc_probe kind=camp が湧き場と足場を言う。'
      // Rig end1109f06 (c6): she circled the fortress's near end for minutes and read it as the spawner; the spawner was 195 m on, past the loaded 128 m.
      + 'camp が読むのは読み込み済みの約 128m まで: 要塞に着いても「湧き場はありません」なら、そこは湧き場ではない。ネザーレンガの橋・壁が続く向きへ 100m 進んで camp を読み直す（要塞の端を湧き場と思ってうろついても湧かない）。',
    '- ツルハシ: ネザーに入る前に石のツルハシを 2〜3 本作って持つ（丸石 3・棒 2 で 1 本）。体は安い道具から使うので、石とネザーラックは石のツルハシで掘る。'
      + 'ダイヤのツルハシの耐久（持ち物の行）が 300 を切ったら、黒石か丸石と棒で石のツルハシを作って使う。',
    '- 道具が壊れて止まった時（行が「同じ種類以上の予備が荷に無い」と言う）は、作るか拾って持ってから同じ手をもう一度。鉄はネザーに無い。鉄のツルハシは 1 本が耐久 250 で、'
      + 'ネザーの岩を掘り続けると壊れる。予備が荷にあれば go は持ち替えて続ける作りだが、実機では未確認。',
    // end1109f19: go with accept [magma_cube] walked past one on a ledge; two hits (20→15.8) knocked her off the 6-drop edge, fell 25 and died at 40 s.
    '- マグマキューブ（ネザーの跳ねる立方体）も近接敵: 跳びついて 1 打ち 3〜6 と強いノックバック。体力が多くても、崖・橋・縁の近くで殴られると押されて落ちる（落下で死ぬ）。'
      + 'accept に入れて横を通らない。8m 内に来たら、足場に「押されたら落ちる」が無い開けた所（または壁を背にして）で attack target=#id untilDead（大は割れて小が出る: 小も斬り切る）、'
      + 'footing に「押されたら落ちる」がある間は、先に空所から 3 マス以上離れてから斬る。遠い（8m より先）なら hostileWithin 8 を付けて別の道。',
  ].join('\n'),
  blaze: [
    '## ブレイズ',
    SAFETY_FIRST,
    '- ブレイズは shortage が空の後（前は戦わず射線の外へ離れ塞ぐ）。空で体力 14 以上、8m 内に 1 体だけ見えたら待たず attack target=#id（下の剣の項）',
    '- 湧き場へ入る手（足場へ着く go と最初の fight）は、体力 20・満腹度 18・持ち物の食料 150 点・盾 1 枚がそろうまで送られない（足りない物は返す行が言う）。食べて回復を待つ・盾を作る・食料を取るは自分で決める。'
      + '食料の点はロッドが増えると減る（残りの本数×約 21 点、最低 60 点）。',
    '- 戦い方: mc_probe kind=camp は湧き場・足場と hideouts（遮蔽候補）を返す場合がある。hideouts は cells[0] 基準（なければ現足）で、今の足からの安全到達を保証しない。必要なら path で道と到着点を読み、go 後の実到着を確認する。'
      + '着いたら先に遮蔽へ go で入る。倒すのは剣で: 見えている 8m 内の 1 体へ attack target=#id（下の剣の項）を短い act で出し、終わったら遮蔽へ戻る。遮蔽が見つからない時だけ、camp の足場から出る。'
      + 'ブレイズに矢は使わない（矢はエンドのドラゴンとクリスタル用に 30 本残す。下の弓の項）。高すぎる相手は降りるまで待ち、届く相手を斬る。'
      + '手に剣を持つ（attack が自分で持ち替える）。必ず stopIf hpBelow 12 を付け、1 回の act は短く（seconds 15 まで）。スポナーは壊さない。',
    '- 湧き場の足場にいる間は、全部の act に accept: ["blaze"] を付ける（dig で火を消す・go・eat・pickup・place だけの act にも）。fight・attack の手の間は体が自動で同じ扱いにするが、'
      + '戦いの手が無い act には accept が無く、燃えていて blaze に見られているだけで床の反射が体を取り、足元を掘って下がる（火を消す dig だけの act の間に足場の床を掘り、'
      + '足場が無くなって落ち、camp を見失うことがある）。1 段の穴は上に浮く blaze から隠れない。accept があれば、反射が体を取るのは体力が低くなった時だけ。'
      + '足場を失ったら、荷の丸石で go（canPlace=[cobblestone]）か place で床を戻す（go の no_blocks の行が荷の丸石を名指しする）。',
    '- 待つだけの手は倒せない: attack hold=true（動かず盾で待つ）は end1108h16 で 10〜20 秒を約 25 回出して 1 体。ブレイズは 2m 内まで来ないと寄らず、離れて火の玉を撃ち続ける（盾が削れるだけ）。'
      + 'fight は 1 回の act で体力が大きく減ることがある。体力が 12 を割ったら岩の陰で回復し、12 を割る前に退く。',
    '- 倒すと「落とし物 blaze_rod×1」が行の先頭に出る。拾うのは次の手（pickup、敵がいない時）。行に「湧き場 (x,y,z) まで Nm」「盾 −N（残り M）」「見送り N」が出る。'
      + 'shoot で倒した時は「blaze #id を倒した (x,y,z)（Nm）。落とし物 blaze_rod×1 が (x,y,z)（Nm、id N）（pickup target=#N …）」と出る（「落とし物は見えない」なら棒は出なかった）。',
    // end1108h7b S7 (11/8): a rod 10 m off was asked for by radius, the nearest brick was taken instead, and four hands asked for arrows that were never drops.
    '- ロッドは pickup target=#N（行の id）で拾う: 体がその物まで歩いて拾う。id が分からない時は pickup target=blaze_rod（24m 内のロッドだけ）。target 無しの pickup は 6m 内の一番近い物（煉瓦など）を拾うだけ。'
      + '射った矢は拾えない（当たった矢は消え、外れて刺さった矢は落とし物ではない）。矢を拾う手は出さない。',
    // end1108h25-27 S7 (11/8): a rod fell behind the room's bricks 3 m up; pickup came back 「掘らない道が無い」 three times over 3 minutes, the go that
    // dug 3 bricks got there after the rod was gone. Across the four camps that made rods 20 of 52 kills dropped one, so each lost rod is about 2 more kills.
    '- pickup が「掘らない道が無い」「そこまで着けない」と返した棒へ、同じ pickup を出し直さない（何度出しても同じ答え: end1108h27 で 3 回・3 分、その間に棒は消えた）。'
      + '次の 1 手で、同じ act に go to=棒のマス canDig=[nether_bricks,netherrack] maxDig 6（accept ["blaze"]）→ pickup target=blaze_rod を続けて出す。'
      + '棒が溶岩の上・足場の外の空所なら諦めて次の 1 体へ（棒 1 本は平均 2 体分）。',
    // end1108h27 S7 (11/8): attacks on blazes behind the room's bricks came back 届かない 7 times (5 s each and a decision between), twice on the same id.
    '- attack が「届かない: … 5秒近づけない」と返した相手へ、同じ id の attack を出し直さない（ブレイズは動くので、間の煉瓦を掘っても追いつけない。'
      + '体の行の「同じ所・同じ理由で2回目」は 3 回目も同じになる合図）。次は、live の行で見えていて 8m 内・足から 3m より上でない別の 1 体を斬るか、'
      + '見える 1 体がいなければ湧き場から 3m 以内の壁のある野営マスへ go で入る。',
    // end1108g7 S7 (11/8): she waited 18 m off the spawner, where none came, and one blaze shot dead dropped its rod 18 m off, never picked.
    '- 湧くのはあなたが湧き場から 16m 内にいる間だけ（湧き場の 4 マス内に出る）。退く合図が無い間は湧き場から 16m 内にいる。8m 内に見えている 1 体は待たずにすぐ attack（体が追って斬る。待っても 3m までは来ない）。'
      + '見えている 1 体がいない時・8m より外の時は、湧き場から 3m 以内の壁のある野営マス（mc_probe kind=camp）に入る: 新しいのはそのすぐ横に湧くので、見えたらすぐ斬る（S7 を通った回は湧き場から 1〜3m で 11〜17 体。5〜7m の床の縁は数体から撃たれる）。16m より遠くで待つと 1 体も来ない（attack・fight の行の「湧き場まで Nm」で確かめる）。',
    '- 棒は倒した場所に落ちる: 湧き場のそばで倒せば拾いやすく、溶岩の上や遠くで倒すと拾えない。斬るのは湧き場の近くを飛ぶ個体を先に。'
      + '倒した後、敵が遠い・少ない間に pickup で拾う（拾わないと 7 本は数えられない）。',
    '- 待ち打ち: ブレイズは 10〜40 秒おきに湧き（あなたが 16m 内の間）、1 体で棒は 0〜1 本（平均 0.5）。7 本そろうのは 14 体で約 6 割・18 体で約 9 割・20 体で約 9.4 割: 時間・食料・盾は 20 体の分で見込む。'
      + '粉にするのは 7 本そろってから。',
    '- 盾は止めた火の玉 1 個で耐久が 6 減る（盾 1 枚 336）。6 体が撃つと盾 1 枚が約 25 秒で壊れる。体は防げない: 湧き場に長く立たない・撃つ体を減らす・盾の予備と火炎耐性を持つ。'
      + '7 本には 7 分前後と盾 2〜3 枚を見込み、傷が 12 を超えたら退く。',
    // S2's blaze labs raid4-5 and an outside view of 11/5: the retreat signs, the sortie at 18, and only a blaze seen and reachable as a target.
    '- 退く合図（どれか 1 つ）: 体力 8 以下・燃えていて体力 12 以下・溜めている個体が同時に 3 体以上・盾の耐久 30 以下・肉が残り 3 個以下。'
      + '当たったらスポナーから 17m 以上離れ、体力 20・満腹 18 以上まで戻してから行く。出るのは体力 18 以上になってから（12 で出るとすぐ退くことになる: S2 のラボ）。'
      + '退くのは戻るため: 盾が 30 以下で 2 枚目の材料（板 6＋鉄 1）が無い時も、体力を戻したら盾なしで、射手が 1 体だけ見える遮蔽から続ける（盾が無いことは止める理由にならない）。',
    '- 戦う相手は、live の行で「見える（射線の中）」の届く個体だけ。壁の向こう（「壁の向こうで届かない」・unreachable）や見えない個体を fight・attack の相手にしない'
      + '（振れないまま体力だけ減った: S2 のラボ）。追うのは 8m 内で、足から 3m より上に浮いていない個体。条件がそろわなければ、遮蔽で待つのは体力を戻す間だけ: 体力 18 以上なら湧き場から 3m 以内の壁のある野営マスへ go で入り、見えた 1 体を待たずに斬る（壁の陰の attack hold には来ない: end1108h23 で 51 回・10 分、振れたのは 0 回）。',
    '- 遮蔽（岩の角）から始め、遮蔽で終える: 打ちに出るのは 1 回の act で短く、体力 12 で角へ退く。戻ったら回復するか盾を選ぶ（盾の残りが 60 を切ったら 2 枚目＝板 6＋鉄 1 を作るか退く）。'
      + '盾は止めた火の玉 1 発で 6 減る。実測: 盾を構えたままでも打撃は通る。盾は 4〜5 分の射線で壊れる。体力は 20 秒で 10 以上減る場面がある。',
    // end1108h16 S7 (11/8): two chases (attack #id) killed in 0.7 and 2.7 s with no health lost; about 25 holds of 10 to 20 s killed 1.
    // The owner (11/8): the arrows are kept for the dragon, and blazes are killed by sword or axe, safely and one-sidedly.
    '- 剣（主の手）: 見えている 8m 内の 1 体へ attack target=#id seconds=15（stopIf hpBelow 12・accept ["blaze"]）。体が剣を持ち、そのブレイズへ歩いて 3m 内で振る（体力 20 を鉄の剣で 4 振り・約 2 秒、ダイヤなら 3 振り）。'
      + '実測（end1108h16）: 追って斬った 2 回は 0.7 秒と 2.7 秒で倒し、傷 0。待つだけの hold は約 25 回で 1 体。'
      + '寄るのはブレイズが火の玉 3 発を撃ち終えた直後が安全（その後約 5 秒は撃たない。燃える体が光っている間は溜めていて、約 3 秒で撃つ）。'
      + '体は 5 秒近づけない時（高すぎる・壁）と、湧き場から 12m を超えた時に追うのをやめて返す（「追うのをやめた: スポナー … から Nm」）。その時は遮蔽へ戻り、体力 18 以上なら部屋の床の縁から次に見えた 1 体を追う（壁の陰で待っても来ない）。'
      + '倒したら pickup target=#N で棒を拾い、遮蔽へ戻る。',
    '- 立つ所: 湧き場から 16m 内（湧きは 16m 内の間だけ）・湧く範囲（湧き場の 4 マス）の外で、射手が 1 体だけ見える岩の陰。'
      + '2 体以上の射手から見える所へは出ない: 3 体に 1〜3m で見られると火の玉と火で 5 秒に体力 14 減った。射手が 2 体以上見える時は、斬りに出るより先に岩の陰で 1 体だけ見える所へ動く。'
      + '斬る相手との間に自分で石を置かない（end1108h16: 自分の置いた丸石が矢の道と追う道を何度も塞いだ）。',
    '- 弓と矢: ブレイズには使わない。矢はエンドで要る（クリスタルとドラゴンに弓と矢 30 本）。矢 32 本で倒せたブレイズは 6 体だけ（実測 11/8）なので、矢で 7 本は集まらない。'
      + 'shoot の手は、荷の矢が 30 本を超える分だけ、剣の届かない 1 体（高く浮いたまま降りない）に使ってよい。',
  ].join('\n'),
  pearl: [
    '## パールとアイ',
    SAFETY_FIRST,
    '- パールの当て: ①歪んだ森（青い森）のエンダーマン ②ピグリンに金の延べ棒を渡す（当たりは約 2.1%、当たると 2〜4 個。金 15.6 個で平均 1 個、14 個には平均 220 個・9 割なら 380 個。ばらつきが大きい）'
      + '③夜のオーバーワールドのエンダーマン（少ない）。足りない数に対する手間（秒）で当てを並べて選ぶ。金が少なくても交換は金の分だけ取り、残りをエンダーマン（1 体で平均 0.4〜0.5 個。14 個に約 28 体: 平均の期待値）で補ってよい。通り道のエンダーマンも取る。',
    '- 歪んだ森が見えない時: 走査（mc_probe kind=scan）で見えていない方向と、通っていないバイオームの方向へ、1 回 90m 以内の go で進み、着くたびに走査し直す。見えた谷や森の反対側を先にする。'
      + 'ネザーで森を探す移動と、ゲートへ戻る時間・夜までの待ち・地上の個体の少なさを比べ、足りない数を早く集められる当てを選ぶ。'
      + 'live の「パール n/14」の行に、金の交換の見込みが出る。',
    // S6's reading of the 1.21.11 barter table (11/5), as averages only (the owner's decision: no seed's own sequence).
    '- 交換が得なのは、金 1 個にかかる秒（交換は 1 個約 7 秒・掘る時間も入れる）が、エンダーマン 1 体を倒す秒 × 0.128 より短い時（金 1 個はエンダーマン 0.128 体分）。'
      + '持っている金（箱・砦・余り）は、ピグリンが近ければ count=N で全部渡す。パールのために金を掘りに行かない: 金 1 個はパール約 0.07 個で、12 個に平均 190 個要り、掘って集める道にならない。'
      // end1109p06 replay: 3 of 7 went to dig gold once the roof fights had ended with 0 blows (the old "dig when a kill is slower than 2 min" line).
      + '屋根の戦いが打撃 0 で終わる時（怒った相手が足元より下にいる・近づかない）は、金ではなく屋根の場所を直す: 相手と同じ高さの地面へ下りて屋根を作る（階段で下りる・probe kind=roofsite）か、別の個体を fight target=enderman で呼ぶ。'
      + '交換の副産物: 光の矢（金 1 で平均 0.77 本。矢 30 に数える）・糸・黒曜石（主目的にはしない）・泣く黒曜石（枠には使えない）。',
    '- ピグリンとの交換: use item=gold_ingot target=piglin count=N が金 N 個までの交換を行う（count は 1〜64、省略時 1）。'
      + '届く範囲の大人で怒っていない個体に、最大 3 体まで 1 個ずつ渡し、6 秒見終わるのを待って出た物を拾い、繰り返す。'
      + '先に金の防具を 1 つ着ける'
      + '（equip item=golden_boots。着けた後に読み戻し、違えば equip_failed）。code: not_adult（子ども）・piglin_hostile（怒っている）・out_of_reach・not_accepted・nothing_returned。',
    '- エンダーマン（HP 40・背が 3 マス）: 目を合わせると怒る。準備なしに合わせない（look で足元）。弓は使わない（テレポートでよける）。'
      + 'fight target=enderman は体が屋根の穴を作って戦う: 平らな床で 3×3×2 の空きがある所に立って呼ぶ。建築用ブロック 11 個（黒曜石以外、丸石・土・ネザーラック等）が要り、'
      + '不足は missing_item、くり抜きかぼちゃは pumpkin。場所が悪いと近い屋根候補へ移動を試し、無理なら no_site。穴の中から目（足の 2.55 上）を見て怒らせ、'
      + '屋根の縁で打つ（自然湧きラボ25分で34体・パール11個、HP損失/死亡0。装備・場所固定の局所実績で、頭の場所選びから14個取得・帰還は未確認）。怒った後は目を見ない。離れる時は live の away の隣へ。',
    '- 怒ったエンダーマンが 4m 内で打って来る時は、歩いて離れない・その場で食べない: テレポートで追い付き、背を向けた間と食べる 1.6 秒に打たれる'
      + '（end1109p05: 体力 12 から「離れる」「食べて離れる」「食べる」を続け、怒った 2 体に 11 秒で倒された）。急ぎでも、打って来る #id を fight target=#id で打ち返す（剣・盾）か、'
      + '2 マスの高さの天井の下（自分の屋根の下）へ 1〜2 歩入る。食べるのは倒した後か天井の下で。',
    '- fight target=enderman と種類で呼ぶと、怒っている個体を先に、次に目が見える 8〜48m の個体（30m 以内を先）を選ぶ。',
    '- 48m 内の全部が目を隠されている時は enderman_not_visible で、最寄りの個体と間の物が文に出る。'
      + 'その時は mc_probe kind=roofsite で、目の見える個体の多い屋根の場所を読み、そこへ go してから fight をもう一度呼ぶ（立った所で呼び続けると、見える個体が無いまま時間が過ぎる）。'
      + '壁や崖に囲まれた所から屋根の場所や開けた所へ出る go は、maxDig 40〜60・maxPlace 24〜30・canDig=[netherrack,basalt,blackstone]（足元の周りが丸石なら cobblestone も）で書く'
      + '（end1109p07b: 囲まれた窪みから maxDig 4〜8・canDig netherrack だけの go を続け、limit_dig 11 回・dead_end 3 回で約 20 分出られず、真珠 0。maxDig 60・maxPlace 30 の go 1 回で出て、その後の約 5 分で 4 個）。',
    '- 怒った個体が 15 秒近づかない時は enderman_did_not_arrive で、居場所が文に出る。'
      + 'そちら側に屋根を作り直すか、別の個体を選ぶ手がある。その個体は 5 分の間、近くまで来ない限り fight target=enderman の選びから外れ、近くに居ても次の項目を止める危険には数えない。',
    '- 48m 内に 1 体もいない時の lost は、見えている遠くの個体を最大 3 体、id・距離・方角・マスで添える。'
      + 'その方角への go が、別の個体へ近づく手がかりになる。',
    // S5's rig of 11/5: 「make blaze_powder 6」 made the powder of 3 rods and the eyes stopped at missing; the counts are written out.
    '- アイは粉 1 + 真珠 1（ロッド 1 本で粉 2）。count は作る物の数: アイ 14 個なら craft item=blaze_powder count=14（ロッド 7 本を使う）→ '
      + 'craft item=ender_eye count=14（粉 14 + 真珠 14）。作業台は要らない（count=6 を 1 回で呼んで 2.0 秒）。粉が足りないと出たら、残りのロッドから粉を足す。',
    '- 枠に最初から入っているアイ P は、要塞に着くまで分からない（1 枠ごとに約 1 割: 平均 1.2、2 以上が約 3 割、4 以上は 3% ほど）。要るアイ＝12−P−手持ち＋予備 2'
      + '（投げで割れるのが 1 回に約 2 割）。P を知らずに作る数は 14（ロッド 7・パール 14）。ロッド 6 本で出ると P が 2 以上の時（約 3 割）しか足りず、足りない時はネザーへの往復を払う。'
      + 'ロッドを 1 本減らして得るのは数分で、往復の方が高いので、ロッドの集まりが極端に遅いなどの理由が無ければ 7 本取る。枠が見えたら、live の枠の行が足りない数・手持ちから作れる数・ネザーで取る分を出す。',
    '- ネザーを出るのはアイが 12 になってから（P は平均 1.2 で要るのは約 11、投げは 1 回に約 2 割で割れるので、10 で出ると枠で足りずに往復することが多い）。',
    // end1108a S9 (11/8): with 12 eyes in the overworld her plan went back to the Nether for 2 more before throwing one.
    '- もうオーバーワールドにいて、アイを 10 個以上持っているなら、足すためにネザーへ戻らない（投げて落ちたアイは拾う）。先に投げてストロングホールドを探す。'
      + '2 投で交点が出て、割れなかったアイは落ちて拾える。12 個で足りる見込みは約 9 割。枠の部屋で空きを数え、足りない時だけ戻る。',
  ].join('\n'),
  stronghold: [
    '## ストロングホールド',
    SAFETY_FIRST,
    // end1108g S9 (11/8): three sleeps failed on a slow server and the head waited out a 20-minute night in place (45-minute limit hit, 497 m short).
    // end1109 (h32b S9): one no_bed_spot, then 13 waits of 30 s on a perch in the air, 0 m/s for the last 7 minutes, 560 m short.
    // end1109s07 S9 (11/9): three minutes before dark she dug a hole, walled it and waited for night to sleep (~200 s still).
    '- 地上の長い道は夜も止まらずに進む（鉄の鎧か盾があれば戦える。無い時も敵が寄ったら fight か go で離れ、暗いうちの wait はしない。水の中の drowned だけは戦わない: 下の海の行）。sleep は暗くなって最初の 1 回だけ、その場で試す。'
      + '暗くなる前に穴・囲い・柱を作って夜を待たない。「夜まで約 3 分」でも go を続け、暗くなった所で sleep を 1 回試す（s07 は夜の 3 分前に穴を掘って囲い、待って 約 200 秒止まった）。'
      // end1109s14 S9 (11/9): swimming at sea seven minutes before dark, she turned 120 m north to a village to sleep (~190 s with the waits).
      + '海・水の上で夕方や夜になっても、寝るために陸・村へ寄り道しない。交点への go（waterOk）を続け、陸の上で暗くなった時だけ sleep を 1 回（s14：夜の 7 分前に北の村へ 約 120m 寄り、待って寝て 約 190 秒）。'
      + 'sleep が not_night（夜まであと N 秒）で返っても wait で待たず、go を続ける（s12：wait 30・20・15 秒と sleep を繰り返して 約 130 秒）。'
      + '寝られなかったら（not_slept・enemy_near・no_bed_spot のどれでも）、朝を待たずにすぐ go で交点へ進む。wait で朝を待たない（h32b：宙の足場で 30 秒の wait を 13 回、最後の 7 分は 0 m/s。end1108g：寝られずに 20 分待った）。',
    // end1109 (h32b S9): a go laid a stair 16 high into the air; the head's stair down took one step, its plan then forbade going down without a floor
    // and digging its own blocks, and no way down was left. The body says the way down of a perch in the air (宙の足場) in its stop.
    '- 自分が積んだ柱・宙の階段の上で止まったら、体の返事の「宙の足場」の案で下りる: 真下の列が固ければ vertical down shape=shaft toY=地面の高さ（足元を掘って 1 段ずつ落ちる）。'
      + '柱の脇の出っ張りにいる時は、隣の柱の天辺へ移ってから shaft。宙では stairs down は 1 段しか組めない（次の段を置く面が無い）。'
      + '「橋・柱の上で自分の床を掘らない」は溶岩・深い空所の上の橋の話で、地面に立つ自分の柱を天辺から shaft で下りるのは別。'
      + '計画に「縦に下りない」と書く時も、柱の天辺からの shaft と地面の高さへの go は禁じない（止まった所から下りる道が無くなる）。',
    '- ストロングホールドへの道は地上とネザー経由の 2 つ。',
    // end1108b S9 (11/8): the intersection lay 1,375 m away across a sea; she took the sea for a wall (「海の上は渡れない」「橋で届く量ではない」),
    // tunnelled and bridged in 30 m legs at 0.5-0.8 m/s, and went for a gate, flint and gold instead. The same body swam the sea at about 3 m/s.
    '- 海・川・湖は泳いで渡れる。go に waterOk を付けると、体は水面を泳いで進む（実測で約 3 m/s。深い海でも歩きとほぼ同じ速さ）。'
      + 'waterOk の無い go は水を避けて足場を置く道（橋）を探し、置く数の上限で止まる。海に橋を架けない・海の下を掘って進まない。walk は泳がない。',
    '- 交点が海の向こうにあることは、地上の道をやめる理由にならない。ゲート・火打ち金・金の防具がそろっていないなら、ネザー経由へ切り替えず、go waterOk で交点へ向かう。',
    // end1109s02 S9 (11/9): the first legs toward the sea went without waterOk (replay of the captured decision: 0/5 with waterOk);
    // the body bridged 64 cobblestone over the sea in two legs and later had nothing to climb with. With the reason inline: 6/6.
    '- 長い道は 1 手を長く出す: go の to は 200m 前後先（1 手 1,000m まで受け付ける）、waterOk（海が見えていなくても毎回。無いと水の上に橋を架けて丸石を使い切る）と canDig（dirt・gravel・sand）・canPlace（cobblestone）・maxDig 20・maxPlace 40 を付ける。'
      + '1 手ごとに判断の待ちが入るので、30m 刻みでは全体が 0.5〜0.8 m/s に落ちた（end1108b）。交点が出た後は、to に交点そのものを出してよい（体が 64m ずつ区切り、地表の高さを選ぶ）。'
      + '止まった後の出し直しも、行き先は交点のまま、seconds 120 で出す（h32b は 1 手の行き先の中央値 55m・判断の待ちが全体の 33%）。',
    // end1108g S9 (11/8): with stone in canDig and maxDig raised to 150-200, the walk tunnelled through the hills at 0.35 m/s (2,369 cobblestone thrown away).
    // end1109s06 S9 (11/9): at a stone mountain wall after limit_dig, Haiku still put stone in canDig and raised maxDig (170 m in ~570 s). Replay of the captured
    // decision: stone 4/4 with the old line; 0/4 with the stop shapes named here and the go reason line scoped, 3/4 went round.
    '- 長い地上の道では canDig に stone を入れない（石の山・崖・村の石の塀に当たっても）。石を掘り抜くと 1m に 2〜4 マス掘り、0.35 m/s に落ちた（end1108g。s06 は山の 170m に 570 秒）。'
      + '掘らずに歩けば 2〜2.5 m/s なので、2 倍の回り道でも石を掘るより早い。'
      + 'limit_dig・search_timeout で止まった時、周りに「掘れば歩ける: 石の類」が並ぶ時、行き先を地表へ上げた y が今の足より 15 以上高い時は、canDig も maxDig も変えず、同じ go の行き先だけを交点の方位から 30〜45° 左か右へずらす（地図で低い側・歩ける側。外れた分は次の手で戻す）。'
      + 'to の y は地表の高さ（体は遠い地中の行き先を地表に上げる）。',
    '- 丸石は 64 あれば足りる（泳ぐ道は置かない）。掘った石・土で持ち物が埋まったら捨てる。夜は岸に上がってから囲うか寝る（水の上にベッドは置けない）。',
    // end1109s07 S9 (11/9): in deep water a drowned threw its trident from 6 m below; the head chose fight three times (0 swings: the body's fight
    // cannot swim to a target under water), stayed in one spot and was hit about 9 times in 40 s, and died 60 m short of the intersection.
    '- 水の中・水面で drowned（三叉槍を投げる）に撃たれたら fight しない。体の fight は水の中の相手へ泳いで近づけない（s07：fight 3 回とも振り 0・unreachable、同じ所で 40 秒に約 9 回撃たれて死んだ）。'
      + 'drowned は 10m より遠い相手には投げないので、すぐ go waterOk で同じ行き先（交点）へ泳ぎ続けて離れるか、近い陸へ上がる。陸に上がって寄ってきた drowned なら fight でよい。食べるのは離れてから。',
    '- ネザー経由（ゲートの近くでアイを投げ、精密な線の横へ 24〜32m 動いて 2 投目で交点を出す → ネザーに入り直す → 入った側のゲートの枠を回収 → (x/8, z/8) へ歩く → 2 つ目のゲートで出る）は距離が 1/8 になる。',
    '- ネザーの歩きが通らないことがある（出口が溶岩の岸で、search_timeout が続く）。',
    '- どちらの道にするかは、アイの交点が出た時に、ゲートから交点までの距離（地上で歩く長さ）を測って、頭が決める。',
    '- アイは 12 個以上まとめて作ってから投げる（粉 14 = craft item=blaze_powder count=14、アイ 14 = craft item=ender_eye count=14）。線の先へ進みながら 1 個ずつ作って投げても交点は出ない（S5 の隔離台: 820 秒で交点 0）。'
      + '交点は、投げた線の横へ動いて投げた 2 本目で出る（帳簿の「次の投げ位置」）。',
    '- ネザー経由で入った後は、掘る前にネザー側の座標を控え、1 つ目のゲートの向こう側の枠の黒曜石 10 をダイヤのツルハシで回収できる（1 個 9.4 秒、計約 94 秒）。',
    '- 回収した黒曜石 10 が 2 つ目のゲートの分になり、竜戦用の 12 は残る（戦い用 8 以上がエンドの入場条件）。',
    '- 枠を回収したゲートは帰りには使わない。',
    '- アイは use item=ender_eye（at 無し）で投げる。体が目玉の飛びを最大 10 秒追い、結果の eye に 向き（bearingDeg 0 北・90 東）・飛んだ距離・終わり方'
      + '（落ちた＝pickup で拾える／割れた）を返す。頭が帳簿に書き、live の「目玉の帳簿」に 交点・誤差の見積り・次に投げる場所の案 を出す。'
      + '精密な線では最初は最後の線の横へ 24〜32m が次の投げ位置の案で、交点が出ない時は帳簿の案が 200m などへ広がる。',
    '- 精密な線 2 本は交角 0.5° 以上なら交点の候補になり、狭い角ほど誤差の見積りが大きくなる（約 1,460m・0.9° では ±90m 前後）。',
    '- 最初の 3 つの要塞は原点 (0,0) から 1,280〜2,816m の輪の上にあり、アイは一番近い要塞へ飛ぶ。交点がこの輪から大きく外れたら向きや帳簿を疑う。',
    '- 交点が出たら、もう投げない: 交点まで歩き、mc_probe kind=frames radius=128 で枠を探す（地表から地下の枠が見える）。アイは枠 12 にそのまま要り、投げると 5 回に 1 回は割れる。'
      + '投げ直すのは、交点の誤差が 128m を超える時だけ（交点の 100m 手前で）。',
    '- 目玉が真下へ沈んだ（down）所、または 12m 足らずで止まった（arrived）所が要塞の入口。',
    '- ポータルの部屋は入口から 7〜72 ブロック離れていた（測った世界では）。',
    '- 落ちたアイは約 5 分、pickup で拾える（割れるのは 5 回に 1 回ほど）。',
    '- 枠の部屋のシルバーフィッシュのスポナー（S）は dig at=そのマス で壊せる（go の canDig と mine はスポナーを掘らない）。',
    '- アイは枠 12 のうち最初から入っていない分が要る（最初から入っているのは平均 1.2 個なので約 11 個）。手元が 10 個を切るなら、要塞へ向かう前に増やす（落ちたアイを拾う・粉とパールで craft・足りなければ取りに戻る）。',
    '- 枠は mc_probe kind=frames（x z=探す中心、省くと足。radius=16〜128、既定 64）が、要塞のエンドポータルの枠を近い順に最大 12 個教える。入口で radius 128 を使う'
      + '（読み込みの外なら 16 ブロック刻みの輪の次に歩く点を返すので、歩いて着いたらもう一度）。感染した石レンガは要塞が近い印で、枠ではない。枠が見えたら live の印（Q）にも出る。',
    // S5's rig of 11/5 (S5b, from above the stronghold): 14 hands between vertical shaft and go on the way down; the body alone took 2 go hands.
    // end1109s04 S9: frames seen 77 m off and 53 m down; one go to the frame with maxDig=150 tunnelled on the slant (145 dug, 120 s limit, 175 s in all)
    // and ended in the wall 5 m from the frames. s03b, from nearly over them, went down in 41 dug and 30 s.
    // end1109s05b S9: the frames lay under an aquifer (340 sources in 7 blocks); the second go carried waterOk, swam into it and dug under water,
    // a vertical shaft could not seal it (no face), and she drowned under a 23-block ceiling at 1,255 s.
    '- 下り: 枠が見えたら、地表を枠の真上まで歩いてから真下へ掘る。1 つの act に 2 手で出す: '
      + '[go いちばん近い枠の x,今の足の高さ,z range=4 canDig=[dirt,sand,gravel]（stone を入れない。体が地表を歩く）, '
      + 'go その枠の座標 range=2 maxDig=150 canDig=[stone,dirt,gravel,stone_bricks ほか 12 種まで] canPlace=[cobblestone]（waterOk は付けない。付けると地下の水の溜まりの中を掘り進んで溺れる）]。真上の近くにいても同じ 2 手で出す（着いていれば 1 手目はすぐ済む）'
      + '（vertical と go を行き来しない）。斜めに掘ると 1m 進むのに約 2 マス掘る（横 77m・下 53m を斜めに 145 マス・約 175 秒、真上からなら約 55 マス・約 40 秒）。'
      + '行き先は枠そのものにする（ずらした所に range を足すと壁の中・枠から 5m 先に着き、目が届かない）。止まったら、行の言う物を canDig に足して同じ go。水の隣で止まったら（行に「流れ込む」）、水から 5m 以上離れた乾いた所から '
      + 'vertical down stairs 枠へ向く向き y=枠の y+1 liquid=seal で下りる（水の中の掘りは 1 マス 6 秒・息は約 15 秒。真下の shaft は水の中だと塞ぐ面が無い）。真下を素手で掘らず、溶岩に注意。'
      + '石レンガの廊下に出たら歩く。ひび割れ・苔の石レンガに紛れた感染石を掘るとシルバーフィッシュが出る。図書室・牢屋・泉の部屋は寄らない。',
    '- 枠（Q）の部屋: 溶岩の溜まりの上の台に枠 12 か所（最初から入っている枠もある）。目の無い枠ごとに 1 回の act で [{do:go, to:枠の座標, range:3}, {do:use, item:ender_eye, at:[枠の座標]}]'
      + '（at は配列で 1 つ）。1 枠 0.7〜2.0 秒で、はまった数 N/12 が毎回行に出て、最後の枠で「エンドポータルが開いた」と出る。足りないアイは live の「ポータルの枠」の行に出る。',
    '- 入る前に、近くで place した bed を use してリスポーン地点にしておく（昼でも設定できる）。エンドで死んでも、この近くで復活して戻れる（ベッドで寝るのはここまで。エンドの中のベッドは爆発する）。',
    '- 初めてエンドへ入る手（e のマスへ walk）の必須は、積める物 64・水入りバケツ・ベッド 8・戦い用の黒曜石 8・食料 330 点（焼き牛 16。竜の戦いは 20 分ほど食べ続け、焼き牛 4 では途中で 0 になった）。',
    '- ベッド 8・戦い用の黒曜石 8 が欠けても、関所が最初に止めてから 10 分たてば、鉄以上の剣・積める物・水入りバケツ・食料 80 点で予備の手（止まり木の竜を剣。弓と矢があればクリスタルも）として入れる（集めるのはそこまで。ある分のベッドも使う）。',
    '- 目標はベッド 10・戦い用の黒曜石 12・弓・矢 30（光の矢も含む）・鉄以上の剣で、予備の武器の不足だけでは入場は止まらない。',
    '- エンドで死んだ記録か、この課題でエンドに入った観測がある時の再入場は、積める物 20・食料 80 点が必須で、ベッドと黒曜石の集め直しは要らない。',
    '- 開いたら中の e のマスへ walk（to=ポータルのマス、range=0）で入る。go ではなく walk（go は「ポータルは walk の的にして入る」と断る）。ポータルは溶岩の上のシートなので、'
      + '枠の輪（足が枠の上）から歩き込む。行に「エンドへ移った (100,49,0)」と出れば着いた。',
    '- エンドに入る前に、丸石か黒曜石を 3 個以上（できれば 64 以上）荷に持つ。着く足場（虚空の黒曜石 5×5）に竜の火の玉が落ちると、体の反射が足元へ 1 個積んで 1 段上がって避ける'
      + '（0.4 秒・被害 0、ラボ実測）。積む物が無いと雲で 4 秒ほどで死ぬ（台帳の cover_none:「足元に積めるブロックが無い。次: 黒曜石か丸石を手に入れる」）。',
  ].join('\n'),
  end: [
    '## エンド',
    SAFETY_FIRST,
    // The lab's words are kept as they were (S1's measure); the section audit of 11/5 adds when to cross and where to.
    // e04b (11/9): the platform lay inside the island; 「虚空のことが多い」 made the model count an 89 m bridge and wait in the hole 30 min.
    '- 着くのは黒曜石の台（100,49,0）。台は世界ごとに、島の外の虚空に浮くことも、島の中に埋まることもある。'
      + '埋まっていれば周りと真上が端の石の閉じた穴で空が見えず、竜はあなたを撃てないので狙いの周回（phase 1）のまま降りない: 待たずに vertical（stairs）で上へ掘り上がり、地表から島の上を歩いて行く（地続きで橋は要らない）。'
      + '虚空なら足元に橋を置いて渡る（go の canPlace は足元の床だけで、壁は作らない。幅 1 の橋は押されると落ちるので、玉や敵が来る間は渡らない）。縁では sneak（歩いて落ちるのは防ぐが、押されるのは止めない）。落ちたら戻れない。'
      + '足場から島へは go to=島の上のマス canPlace=["cobblestone"] maxPlace=100 seconds=120（ラボで 30 ブロックを 30 秒・置 14・被害 0。竜は島の上に止めて測定）。',
    '- 渡るのは竜が遠い時（phase 2 で着陸へ向かう間など）。行き先は台から原点 (0,y,0) 側の主島の、観測済みの床と頭上の空間があるマス。',
    '- エンダーマンは目が合うと怒るため、足元か地平より下を見ると視線を避けられる。',
    '- エンダーマンの少ない足場なら、待つ間に目を合わせたり巻き込んで殴ったりする危険が減る。',
    '- 怒ったエンダーマンには、竜が遠い間に足元の水か内側の高さ 2 マスの天井の下へ入ると、攻撃を避ける足場になる。',
    '- 橋・島の縁・止まり木の窪みは、エンダーマンに押されると落下や竜の攻撃が重なる。',
    '- 島への橋（幅 1）の先端は、竜の玉が落ちる向きによっては、体の避けが「道なし」になる（S1 の実測）。先端で長居せず、玉が来る向きを見て渡り、足場の石を積める数（3 個以上）を持つ。',
    '- 息の雲が地面に残る間、go は雲の中を通る道を引かない。他に道が無いと「go 止まった dead_end: 道の先が竜の息の雲の中で、避けると道が無い（雲は約 30 秒で消える）」を返す。'
      + 'この文が出たら、雲が消える（観測の dragonBreath が空になる）まで高い足場で待つか、別の側から行く。雲を受けて反射が 1 段上がった後に同じ go をすぐ出し直すと、雲の中へ戻って傷を受ける。',
    '- 止まり木に竜が座っている間（phase 5〜7）に、表彰台から 5〜12m に立っていても被害は無かった（座った瞬間に頭の向く側の 5m だけ 3）。',
    '- 檻つきの柱は、本命が尽きて竜の体力が 100 超の時の予備の最後に当たる（低い体力なら剣か残りのベッドで届く）。',
    '- 鉄格子の檻つきのクリスタルの柱を登る時は、水の入ったバケツ（鉄 3）を hotbar（最初の 9 スロット）に持つ。自動の落下止めは対応版で有効な時だけ手・hotbar の水を使う。'
      + '垂直 10・25・90m を各 1 回、体力 20 での着水・回収を確認した。pack からの自動装備はしない。'
      + '虚空・未読地形・横の押し・敵との接触・実戦での救命は未保証。旧無効版や有効状態が未確認なら頼らない。'
      + '柱の上から落ちる（翼の押し・爆発・踏み外し）と、20 ブロックで被害 17、それ以上で死ぬ（ラボ。防具は落下を減らさない）。計画的な下降では事前に着地点に水を置くか vertical を使い、自動救済を待って水を置かずに跳び降りない。'
      + '落ちないことを第一に、足元と両脇を積める物で囲い、柱の上に居る時間を短くする。',
    '- 柱の上は歩いて離れる道が無い。ラボ: 幅 1・30 ブロックの柱の上に、積める物も水バケツも持たずに居た体は 144 秒で死んだ（玉が 8 つ線を通り、最後の雲が柱の上に載って 1 秒ごとに 6 を 3 回）。'
      + 'ブロック 12 個と水バケツを持つ体は、玉を 3 つ落とされても 3 回積んで上がり（96→99）被害 0、2 × 153 秒の待ちも被害 0（積む度に 1 個減る）。'
      + '登る時は、積める物を 3 個以上残し、柱の上に居る時間を短くする（地面の約 2 倍、玉が来る）。島の地面でじっと立つ体は 2 × 150 秒で被害 0 だった。'
      + '柱と足場はエンドストーンか丸石で積み、黒曜石では積まない。下りる時は柱を掘るので、ダイヤのツルハシでもエンドストーンは 1 個約 0.6 秒、黒曜石は約 9.4 秒かかる'
      + '（実走: 黒曜石の柱の上で材料の黒曜石を掘り、黒曜石の柱を掘って下りて、柱の上に約 13 分居た）。黒曜石はベッドの手の台と爆風よけにだけ使い、足りない材料は地上のエンドストーンを掘って足す。'
      + '積む途中でエンドストーンと丸石が尽きたら、黒曜石で続けずにいったん柱を下り（エンドストーンの柱は速く掘れる）、地上でエンドストーンを 10 個以上掘ってから登り直す。',
    '- live の「竜」「エンドクリスタル」「竜の息の雲」「火の玉」「止まり木」の行は体の観測そのもの。体が決めないのは、どこに立つか・いつ振るか・いつ逃げるか'
      + '（床の逃げ以外）・どのクリスタルを先に壊すか・ベッドを使うか。',
    '- 順番: 先にクリスタルを壊し（残り 2 以下まで）、その後で止まり木の竜をベッドで倒す。クリスタルが残る間は竜が周回中に +2 体力/秒で回復し、座りの間に与えた傷が次の座りまでに消える'
      + '（実走: 結晶 10 本が残る中、ベッド 1 回で 200→173 にした竜が、飛び立って約 13 秒で 200 に戻った。ベッドは 8 個しか無いので、結晶が 3 本以上残る間は使わない）。',
    '- 倒し方: 本命はベッドで倒す。竜が座っていてベッドを持つ間、live に「ベッドの手」の行が出る: 立つ所・先に置く黒曜石・ベッドの足のマスと枕・見込みを体が測った候補なので、'
      + 'その行の go → place → place（ベッド）→ use を 1 つの act に並べて、そのまま行う（マスを自分で選び直さない）。行が無ければ待ち場で次の座りを待つ。'
      + '竜が飛んでいる間も live に「待ち場の候補（次の座りを待つ所…）」の行が出る（結晶が 3 本以上残る間は待たず、結晶を壊しに行く）。止まり木から 20m より遠い時と 8m より近い時（窪み・泉の上）は、その候補へ go して座りを待つ'
      + '（止まり木の上で待った体は、着地の前の息の雲が窪みに落ちて歩いて出る道が無く、体力 20→0 を約 5 秒で死んだ。実走）'
      + '（1 回の座りは約 27 秒、座ってから 60m 歩くと約 14 秒かかり、ベッドの手に間に合わない。台の 2 本は 60〜75m 先で待ち、座りを逃した）。',
    '- 弓か矢が無い時のクリスタル（実走で 1 本通った形）: 檻なしの低い柱の脇を vertical pillar up（canPlace）で登り、柱の上端より 1〜2 段下で止めて、attack target="end_crystal"（柱の黒曜石が爆発を遮る）。'
      + 'out_of_reach なら 1 段上げる、blast_unsafe なら間に 1 個置くか 1 段下げる。'
      + '壊したらすぐ vertical down で地面へ降りる。柱の上に残る時間は全部、玉と落下の危険になる。'
      + '登り始めるのは、live の「竜」の行が止まり木に座っている時か、周回（phase 0）の途中で竜が自分から 30m 以上離れている時。周回の竜は柱の輪の近くを回るので 30〜60m にいることが多く、その間は柱の根で登る準備をして、30m 以上ならすぐ登る（実走: 周回の竜が 26〜56m の間「離れるまで待つ」で約 250 秒地面に居て、結晶は 1 本も減らなかった）。'
      + '「狙いを定めて火の玉（phase 1）」の間は竜があなたへ向かって飛んで来るので、距離が遠くても登らない。地面で（息の雲を避けて）エンドストーンを掘りながら、竜が周回に戻るか座るのを待つ。'
      + '柱の上に居る間に竜が phase 1 になるか 30m 以内に来たら、結晶の前でもすぐ vertical down shaft で降りる（dig・walk の繰り返しは 1 段ずつ止まる）。結晶は竜から遠い側の柱から壊す'
      + '（実走: 竜が phase 1 で 49m 先の時に結晶の脇を登り始め、11m まで来た竜の体に当たって約 30 ブロック打ち上げられ、約 130 ブロック飛ばされて島の外の奈落へ落ちた）。'
      + '柱の材料は島の地面のエンドストーンを掘って、登る前にそろえる（柱の高さ＋3 個。ダイヤのツルハシでエンドストーン 1 個約 0.6 秒、黒曜石は約 9.4 秒）。'
      + '柱の上で自分の柱や結晶の柱の黒曜石を掘って材料にしない（実走: 結晶を 1 本壊した後、柱の上で黒曜石を約 13 分掘り続けて降りず、食料が尽き、火の玉と反射の跳ねで約 13 マス落ちて死んだ）。'
      + '1 本ごとに 降りる → 地面でエンドストーンを掘る → 次の低い柱へ歩く、を繰り返す。',
    '- 予備は檻なしのクリスタルを地面から弓で壊しつつ、止まり木の竜を窪みの足場から剣で打てる（結晶の全破壊は剣の前提ではない）。',
    '- 竜の体力が 50 以下なら、結晶や檻へ行かず、次の座りの窪みの剣か残りのベッドで倒せる範囲。',
    '- 本命が尽きて竜の体力が 100 超なら、檻なしを弓で壊して回復を減らす余地があり、檻は最後の選択になる。',
    '- ゲームの規則: 竜の頭への爆発の被害は'
      + ' 35(q²+q)+1、q=(1−d/10)×(遮られない割合)、d は枕の中心から頭の足元まで（d=0 で 71、1m で 61、2m で 51、3m で 43）。同じ竜への 2 発目は、前の当たりから 10 tick（0.5 秒）'
      + 'たたないと差分しか入らない。止まり木の間（phase 5〜7）の被害の累計が 50 を超えると、その一撃まで全部入って飛び立つ（1 回の座りで最大約 121）が、着地の途中（phase 3）にはこの上限が無い。'
      + 'クリスタルが残る間は、最寄りの 1 本から竜が 10 tick ごとに 1（+2 体力/秒）回復する。止まり木の竜を頭の下の窓（約 2.5 秒）で剣で打つ形は通らなかった（隔離ラボで撃破 0）。',
    '- 窪みの剣は、結晶が残る竜の体力 50 以下の仕上げにも使える形（頭の下の短い窓で打つ形とは別）。',
    '- 窪みの足場で倒した形（隔離ラボは結晶なしで 4 回中 4 回・死亡 0）: ①竜の向き（dragon.yaw）の横 10〜14m の開けた足場で、'
      + '竜から見える所に待つ（着地 phase 3 の約 3 秒後に決める）。②dragon.phase が 6（座って探す）になったら、live の窪みの足場（basin）の先頭へ go（range 0.5・seconds 12）。'
      + '③剣を持つ attack target=ender_dragon seconds=30 onFail="continue" の直後に、その座りの向きの横 10〜14m の待ち場への go を同じ act に並べられる。',
    '- attack は perch_over で止まり、onFail="continue" なら頭の次の判断を待たず後ろの go が動く。',
    '- 離陸の翼で窪みに残ると約 20 ブロック打ち上げられて落下死し、ポータルの近くの水は立ち位置を乱す。',
    '- クリスタル: shoot target="#id"（13〜64m、弓を 21 tick 引く。檻なしは 1 発で壊れた）。too_close・too_far は距離を変える。line_blocked は矢の道の固い物で、'
      + '檻の鉄格子は塞ぐ。文に塞ぐ所の座標が出るので、その格子だけ dig で取ってから撃つ（格子 2 つを消して 17.8m から 1 発で壊れた）。'
      + 'attack target="end_crystal" は 3m 以内の 1 撃で、爆発の見込みが体力に足りないと blast_unsafe（数字つき）。爆発圏は 12m: live の行の「壊すと爆発（体力 −N の見込み）」を見る。',
    '- 竜の頭: attack target="ender_dragon"（#id でも）は止まり木の間だけ頭の部位を打つ。歩かない（立ち位置は go）。待ちは剣 13 tick。止まりの code: not_perched・'
      + 'out_of_reach・perch_over（飛び立った）・time_up・target_lost。倒すと ok で「倒した」。live の行の「頭の箱まで N m（剣が届く）」は、サーバーが受ける届き'
      + '（目から頭の箱まで約 6m）より手前の 5m で体が振る印。止まり木の竜に shoot は効かない（perched_immune）。飛んでいる間は shoot target="ender_dragon"。'
      + 'fight は竜に使わない（普通の敵として追ってしまう）。'
      + 'attack ender_dragon は今の手持ちで打ち、体は剣を持ち直さない。壁抜けや水バケツを使った後に手が別の物のことがあるので、打つ前に equip で剣（か斧）を手に持つ。',
    '- クリスタルの撃てる位置: live に、矢の道が通る撃てる位置（13〜64m、最大 3）と、同じ位置から撃てる組が出る。そこへ go して shoot target="#id"。'
      + '檻つきは caged と blockedBy が出て、檻を取った後に撃てる位置も出る。',
    '- 檻を選ぶ場合の柱は vertical pillar up（canDig ["none"]・canPlace）→ dig で格子 → vertical down の縦穴（隔離ラボで 2 基とも成功。跳び降りは落下止めを当てにできない）。',
    '- 止まり木の間は live に、窓の外で待つ位置 stage・頭の下 strike・離陸の後に退く位置 retreat と、窓まで何秒か（窓は約 2.5 秒）が出る。stage から strike までが短いほど窓に間に合う。'
      + '隔離ラボ 8 回では、待機位置が遠い（体の反対側で 40m 歩く）と止まり木 1 回の中に着けないことが多かった: 降りる前に竜の頭の向き（止まり木の向き）を見て、体を頭の側に置く。窓の外で頭の近くに入ると、床の反射が（息・玉の予告で）切る。',
    '- 数（隔離ラボ、剣の場合）: 頭への剣 1 回 7、首・翼・胴は 2.75。止まり木の間に与えた被害が最大体力の 1/4（50）を超えると竜は飛び立つ（バニラの規則）ので、1 回の降下で削れるのは約 50。'
      + '竜の体力 200 には 4 回以上の降下が要る（ベッドは着地の途中なら上限が無いので、この数に縛られない）。',
    '- 息の雲（紫の粒子）は半径 7m 以上として避け、雲の中で立ち止まらない。体の床の逃げは水平だけで、息の雲・火の玉・止まり木の竜の体から離れる。縁の外へ押されると落ちる: 縁から離れて戦う。'
      + '止まり木の周期（隔離ラボで測った）: 着陸の約 10 秒後に 見回し 1.2 秒（phase 6）→ 吠え 2.0 秒（phase 7）→ 息 10 秒（phase 5、雲は頭の 2.5m 先に息の間ずっと）'
      + '→ 見回し → 吠え → 息 → 飛び立ち（phase 4）。1 回の止まりは約 27 秒で、打てる窓は見回しと吠えの前半（約 2.5 秒）、1 回の止まりに 2 つ。息の間は頭の 7m 以内に入らない。',
    '- bedsite の ready と、モデル頭位置・遮蔽から式で求める被害は予測。実HP変化・同一actでの退避・撃破は別に確認する。',
    '- 自然な着地 phase 3 のM2実測は1爆発で竜HP200→180.81（約19.19減）。試行全体の自分の最低HPは8で、爆発だけへの帰属は不明。',
    '- このM2では同じ進入の連続2発・同一actでの退避・撃破は未確認。過去の「約38減」は別条件の隔離測定で、差の原因は未確定。',
    '- ベッド: use at=[ベッドのマス]（ネザー・エンドだけ。寝ずに右クリックで爆発。エンドで使うのは、結果の文の「自分への被害」の見込みが 4 以下の時だけ: 虚空の縁では落下止めが効かず、傷が命取り）。結果の文に 爆発した・自分まで届いた・失った体力・竜の頭の箱まで・竜の体力の前後 が出る。'
      + '自分への被害が体力に足りないと blast_unsafe で断る。体は自分では使わない。隔離ラボ: 竜の頭の箱の 1.5 ブロック先（爆発の中心から 3m）に置いて使うと竜が約 38 減った（剣 5〜6 回分）。'
      + '自分は黒曜石の壁の後ろ（4.4m）で −0.2、壁なしの 5m で −16（文の「見込み」とは ±0.4）。竜の頭が回っている間（見回しの最初の約 5 秒）は置いたベッドが消える: 頭が止まってから置く。',
    '- エンドの食料（仮説。実測はこれから）: 竜の段で受けた傷 100〜150 の回復に、焼いた肉（cooked_beef など）12〜16 個の見込み。持ち込みは焼きステーキ 16 個を見込む。'
      + '24 本の記録で体が自分で食べたのは 12 回だけだった（待つ間の満腹度が 18〜19 で、体の食事反射が動かなかったため）。体の食事反射は、体力が満タンでなく満腹度が 20 未満で、'
      + '8m 内に敵対がおらず、竜の危険・飛ぶ火の玉（40m 内）が無い時に、焼いた食べ物を食べる（生肉・腐った肉は対象外）。act eat（item: cooked_beef）は今までどおり使える。',
    '- 島の中心 (0,y,0) から 40m 超へ押された時は、中心側の待ち場へ戻ると縁との距離を取れる。',
    '- エンドで死んだらリスポーンはベッドか最初の場所で、戻るのは開いたポータルから（座標は live の控え）。',
    '- 荷は戻れば拾える見込み（未確認）。',
    '- 死んで戻っても、壊したクリスタルは戻らない見込み（未確認）。竜の体力は、結晶が残っていれば周回中に回復する（上の順番の行）。',
    '- 討伐の確認は体の記録（boss.verified）。体がこの竜に被害を与え、その後 60 秒以内に同じ竜が死に、同じ接続・同じタスクの時だけ true。再接続すると unknown のまま。'
      + '倒したと思っても自分で完了にせず、確認を待つ。',
  ].join('\n'),
});

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join(' ') : typeof value === 'string' ? value : '';

/**
 * The stages the decision needs, from the live state alone: the kinds of the plan's current node and the next ones (the body's `planFacts`, chapter 7: never
 * the words of `planNow` or the plan's next lines), the dimension, the structure she is in, what she carries, and what is near (a blaze, a spawner, a
 * fortress). Always at least one: the dimension's. A live state without `planFacts` picks no stage by a node.
 */
export function stagesFor(live: Rec): StageId[] {
  const body = rec(live.body) ?? {}, state = rec(body.state) ?? {};
  const dimension = String(state.dimension ?? '');
  const where = { kinds: nearKinds(factsIn(body)), inside: String(state.inside ?? ''), inventory: text(body.inventory),
    near: `${text(body.landmarks)} ${text(body.scan)} ${text(body.threats)}` };
  const found = STAGE_IDS.filter(id => STAGE_WHEN[id](dimension, where));
  return found.length ? found : [dimension === 'the_nether' ? 'nether' : 'prep'];
}
interface Where { kinds: readonly PlanKind[]; inside: string; inventory: string; near: string }
const kindsOf = (...kinds: PlanKind[]): ReadonlySet<PlanKind> => new Set(kinds);
/** The kinds of node each stage's knowledge goes with (chapter 7, table 12). */
const STAGE_KINDS: Readonly<Record<StageId, ReadonlySet<PlanKind>>> = {
  prep: kindsOf('wood', 'stone_tools', 'food', 'bed', 'village', 'prep_descent', 'iron', 'iron_armor', 'diamond', 'obsidian', 'portal', 'chest'),
  nether: kindsOf('nether', 'fortress', 'portal'),
  blaze: kindsOf('blaze'),
  pearl: kindsOf('pearl'),
  stronghold: kindsOf('stronghold'),
  end: kindsOf('end', 'dragon'),
};
/** When each stage is needed: the dimension, the kinds of the plan's nodes, the structure she is in, what she carries and what is near. */
const STAGE_WHEN: Readonly<Record<StageId, (dimension: string, where: Where) => boolean>> = {
  prep: (dimension, where) => dimension === 'overworld' || hasKind(where.kinds, STAGE_KINDS.prep),
  nether: (dimension, where) => dimension === 'the_nether' || hasKind(where.kinds, STAGE_KINDS.nether) || /要塞|砦/u.test(where.inside),
  blaze: (_dimension, where) => hasKind(where.kinds, STAGE_KINDS.blaze) || /blaze|ブレイズ/u.test(where.near),
  pearl: (_dimension, where) => hasKind(where.kinds, STAGE_KINDS.pearl) || /ender_pearl/u.test(where.inventory) || /enderman/u.test(where.near),
  stronghold: (_dimension, where) => hasKind(where.kinds, STAGE_KINDS.stronghold) || /ストロングホールド|エンドポータル/u.test(`${where.inside} ${where.near}`)
    || /ender_eye/u.test(where.inventory),
  end: (dimension, where) => dimension === 'the_end' || hasKind(where.kinds, STAGE_KINDS.end),
};

/** The knowledge of the stage(s) a plan node of this kind is in (the dimension's own when no stage holds the kind), for the plan made again. */
export function stageTextsForKind(kind: PlanKind, dimension: string): string {
  const ids = STAGE_IDS.filter(id => STAGE_KINDS[id].has(kind));
  const own: StageId = dimension === 'the_nether' ? 'nether' : dimension === 'the_end' ? 'end' : 'prep';
  return (ids.length ? ids : [own]).map(id => V2_STAGES[id]).join('\n\n');
}

/** The message before the live state: the stages' knowledge, headed by which stages (null when there is no live body to pick from). */
export function stageKnowledge(live: Rec): string | null {
  if (!rec(live.body)) return null;
  const ids = stagesFor(live);
  return `（この場面の知識: ${ids.join('・')}）\n${ids.map(id => stageText(id, ids)).join('\n\n')}`;
}
