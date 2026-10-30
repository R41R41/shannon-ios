import { MAP_LEGEND_V2 } from '../../contracts/minecraftMapLegendV2.js';
import { milestoneWords } from './minecraftLlmcRoad.js';
import { PREP_DESCENT_RULE, PREP_RULES_WORDS } from './minecraftLlmcPrepRules.js';
import { factsIn, hasKind, nearKinds } from './minecraftPlanFacts.js';
import type { PlanKind } from '@shannon/mind';
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
  '- 目的は課題の goal。持ち主の物差しは速さ: エンドラ討伐なら、ネザーへ入るまでを 30 分以内に（準備を含む）、なめらかに進める。',
  '- 速さと同じだけ、生きていることが大事。死ぬと持ち物と時間を失い、用心より時間がかかる。',
  '- 優先の順: 差し迫った危険を避ける → 準備の必須を満たす → 目的へ早く進める。時間を理由に止めたり、早く完了にしたりしない。目安は物差しで、手を決める物ではない。',
  `- 節目の目安（開始からの秒）: ${milestoneWords()}。live の meter が、今と次の節目を言う。`,
].join('\n');

/** The descent's preparation as a rule for choosing the action (one place; the live state and the results say only the state of it). */
const PREP = PREP_DESCENT_RULE;

const DECIDE = [
  '## 決め方（判断の原則。手の書き方は mc_act の説明）',
  '- 毎判断、live の urgent・planNow・shortage・footing・around・route・threats・lastResults と plan を読んで決める。',
  '- 結果を待たずに決められる手は 1 つの act にまとめる（小分けは 1 判断ごとの待ちで遅い）。後で使う物は act の keep に書く（帳簿に載る）。開いた約束の物は用途のために残す。割るなら why に約束の番号と理由。',
  '- 範囲を挙げて任せる手（go・obsidian・fight・mine・make・portal・smelt）: あなたが決めるのは、目的・対象・行き先・許す掘る/置く・済む条件、食事・睡眠・片づけ、戦うか逃げるか。'
    + '体に任せるのは、歩く道・途中の板や棒・作業台を置く所・戦い方の細部。',
  '- why は節の札で始める（「[p1.2] 丸石でハーフブロック」。別の節は「[p2.1] 理由: …」）。（）の数は見て確かめた値で、これから作る・取る物は「これから」と分ける。',
  '- 履歴に残るのは act の各手の行（止まった手の周り・地図・probe の長い答えは次の lastResults に一度だけ）: 後で要る座標・危険は plan か why に書く。止まったら、返った行と周りで原因を直し、返る理由で範囲と許す物を直す。同じ手を同じまま出さない。',
  '- 分からない時・同じ止まり 2 回・落ちた時・live に look が出た時は、調べる判断で mc_view か mc_probe（同じ止まり→history と path か sight、落ちた→column、敵→around）。'
    + 'investigation に原因が出ていればそれを使う。原因が分かったら plan_update の forbid（してはいけない事）か caution（気をつける事）の op で、今の節に 1 行書く（plan.rules に出る）。',
  '- かまどに入れたら、焼ける間（jobs の残り秒）は別の作業（準備の補い・装備作り・資材集め・移動）を列に足す。wait だけの act は、有用な手を選べない時だけで、why に待つ対象と理由を書く。',
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
  '- 足=(x,y,z) が足のマス、頭は y+1。層は全部同じ範囲。? は未ロード（不明）。',
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

const DANGER = [
  '## 敵と体力',
  '- 体の反射（溶岩・溺れ・落下・燃え・クリーパー・飛び道具・体力 8 以下の逃走・瀕死の食事・打ち返し）は体がして、act を止めて何をしたかを返す。その先はあなたが出す。',
  '- 危ない act には stopIf: 夜・洞窟・ネザーは hostileWithin 8〜12（クリーパーは 10）、射線の中を通る act は hpBelow 12 前後（今の体力より低く）、待ち打ちは hostileWithin。'
    + 'accept に入れた種類は hostileWithin に数えない（fight の相手もその手の間は同じ）。hpBelow と反射は accept でも効く。戦うと決めた敵だけ accept に入れ、ほかの敵で止めたい act には hostileWithin。',
  '- 体力 8 以下では戦わない: sprint で離れる→囲う（足の周り 4 面と頭の上）→食べる→満腹 18 以上で wait（自然回復は満腹 18 以上のみ）。ベッドは夜に寝る（ネザー・エンドのベッドは爆発する: そこでは寝ない）。夜の露出や敵 2 体以上は先に囲うか避ける。',
  '- 体力が戻らない間（満腹 18 未満。recovery が出る）は、下りる・戦う前に食べる。敵が近くても 1 個食べてから（1.6 秒）。戻らないまま下りたり戦ったりすると、落下や矢 2〜3 発で死ぬ。',
  '- 「今いる所は … から見える」と出たら、囲う・食べる前に見えない所へ。壁の向こうの敵は急ぎではない。',
  '- 追ってくる近接の敵（ピグリン・ゾンビ・ウィザースケルトン・溺死ゾンビ）からは歩いて逃げ切れない。体力 8 超でも、戻らない時・夜・敵 2 体以上は、打ち返す前に食べるか、間に 2 マス place か pillarUp 2 で遮る。'
    + '鉄以上の剣があり体力 8 超で遮れない時は打ち返す（equip→accept→attack target=#id untilDead。禁止・shortage に反しない時）。',
].join('\n');

const PLAN = [
  '## 計画',
  '- 計画は自分のもの（順を変える・足す・割る・blocked と reason）。済んだ・止まった・変えた時だけ plan_update。順を守る（ブレイズの棒 7 本の後にエンダーパール）。'
    + '節を飛ばす・後回しにする時は reason に理由を書く。',
  '- 体が別の節の項目を続けて始めると、頭が今の節をその節へ動かすことがある（戻すのは plan_update の current）。今の節が未達の準備の節の間は動かない。',
  '- 済む条件（doneWhen）と、消費して無くなる物の子の閉じ方は plan_update の説明。shortage は戦い・奥への移動の前に埋める。',
].join('\n');

/** The text every decision reads (the knowledge part of the cached system text). */
export const V2_ALWAYS = [GOAL, PREP, DECIDE, URGENT, LIVE, MAP, FALLS, DANGER, PLAN].join('\n\n');

export type StageId = 'prep' | 'nether' | 'blaze' | 'pearl' | 'end';
export const STAGE_IDS: readonly StageId[] = ['prep', 'nether', 'blaze', 'pearl', 'end'];
/** The knowledge of each stage, cut from the own prompt's 材料と手順 / ネザー・要塞・ブレイズ / パール・アイ・エンド. */
export const V2_STAGES: Readonly<Record<StageId, string>> = Object.freeze({
  prep: [
    '## 材料と手順',
    '- 食料は foodPreparation の加工見込みと狩りの時間・危険を比べる。見込みは達成に数えない。炉・作業台・燃料・設置場所と、加工の終了は観測で確かめる。瀕死・飢えは逃走と今ある食事を先に。',
    '- 安全な囲いでは、射線・敵の到達・足場を確かめ、朝待ちと調理・工作を比べる。',
    '- 準備の必須と目標は system の「準備の決まり」。ここは材料と手順の知識。食料の点（live の foodPoints.total。満腹 fullness とは別）は、ネザーの奥へ 100、エンドへ 80 以上。'
      + 'かまどの燃料は石炭 1 で 8 個・木材 1 で 1.5 個、鉄と一緒に肉も焼く。食べ物の当てが近ければ、取るのは数十秒〜2 分。',
    '- 生の鉄が 5 個以上ならかまどを 2〜3 基に分けて焼く（1 個 10 秒）。焼く間は掘る・狩る。',
    '- 木は、足の高さから幹に届く木か、走査の近い原木を選ぶ。崖の上・高い所の木へ土で登る手が 2 回止まったら、その木はやめて別の木へ。',
    '- 木が無い時: 地表の木（mc_probe kind=scan で原木の方角・mc_view mode=top で上から）→村の木の物（扉・柵・ベッド・作業台・板、takeOk）→難破船→廃坑（vertical の stairs で下りる）。',
    '- 村は鉄より前に 128m 内を回る（takeOk: true。鉄ゴーレムと村人は打たない）: ベッド（下の決まり）、干し草（1 個でパン 3）、育った畑、箱は chest op=look→take。',
    PREP_RULES_WORDS,
    '- 鉄は y=16 前後（i）。ダイヤは y=-58 前後（d、鉄のツルハシ）。水バケツは水源（w）の隣から use（流れ - からは汲めない）。',
    '- 地下の資源の多さ・直線距離は、道の有無ではない。go が search_timeout なら、遠い目的地の高さや採掘上限だけを変えて再指定せず、10m 以内の中継点か短い階段・縦穴で近づく。道が確認できた近場も比べる。',
    '- 黒曜石: obsidian の手に溶岩の源（地図の L）か既存の黒曜石（O）のマスを挙げる。既存の O も、水で隣の溶岩を固めながら掘って拾える。10 個には源が 10 以上ある溜まりへ行く（単独の源は 1 個にしかならない）。水入りバケツとダイヤのツルハシを持つ。'
      + '水を注ぐ・待つ・掘る・汲み戻すは体。手で書く時は、足元・立っているマスからは離れたマスを開ける。'
      + '溶岩が 20m 内にあれば、既存の黒曜石へ行くより水で固めて作る方が早い（live の body.obsidian に両方の距離）。バケツの溶岩を枠に流し込んで作ってもよい。'
      + 'ゲートは portal の手（枠の内側の左下と向き。黒曜石 10・火打ち金（鉄 1・火打石 1））が組んで点けて入る。',
    '- すでに点いたポータル（p ネザー・e エンド）の入り方: そのマスの中へ walk（range=0。足と頭がポータルのマスで、下は枠の黒曜石）して、約 4 秒立って待つ。着いた先が次元の変化。'
      + 'ポータルのマスには place できず、その上面は床ではない。',
    '- ネザーで作り直す: 真紅・歪んだ幹（素手で可）→板（1 で 4）→作業台（持ち歩く）・棒。丸石 3→ハーフブロック 6。盾は板 6・鉄 1 で offhand に equip。'
      + '金の防具は延べ棒 4（靴）〜5（兜）。',
  ].join('\n'),
  nether: [
    '## ネザーと要塞',
    '- ネザーの x・z はオーバーワールドの 1/8。帰りのゲートの座標を where に書く（帰りも p のマスの中へ walk して約 4 秒待つ）。y=31 より下は溶岩の海、マグマ（M）は燃える。',
    '- ピグリンは金の防具を 1 つ着るまで襲う（着るまでピグリンの群れ・砦の遺跡の 8m 内に長居しない）。金を掘る・箱を開けると怒る。',
    '- 要塞（N）は帯に並ぶ: ゲートから 1 方向へ 100〜300 進み、無ければ直角へ（mc_probe kind=scan radius=32 で要塞・ネザーレンガの方角、高い所から mc_view mode=top）。',
    '- 要塞やスポナー（S）の近くでは通路を歩かず、床より 1 段下の岩に 1 幅 2 高のトンネルを掘って進む（足と頭を dig→1 歩）。射線の中で立ち止まらない'
      + '（wait・食べる・作るは見えない所で）。',
  ].join('\n'),
  blaze: [
    '## ブレイズ',
    '- ブレイズは準備（shortage が空）の後。準備の前に近くにいる・撃たれた時は戦わず、射線の外の岩へ離れて塞ぐ。',
    '- 戦い方: スポナーから 3〜5 マス・同じ高さか 1 段下に 2×1 の隠れ場、三方を囲い目の高さに下付きハーフブロックの隙間。hold は部屋へ開いた同じ高さのマスで'
      + '（床・壁越しには届かない）。accept ["blaze"]、attack target=blaze hold seconds 20〜30、stopIf hpBelow 12。棒は敵がいない時に pickup。スポナーは壊さない。',
  ].join('\n'),
  pearl: [
    '## パールとアイ',
    '- エンダーマン（歪んだ森に多い）: 目を合わせない（look で足元）、2 高の天井の下には来られない、accept ["enderman"]。離れる時は live の away の隣へ。追って歩き回らない（来るのを待つ）。ピグリンには金の延べ棒を drop target=ピグリン（真珠は 2〜4%）。',
    '- アイ（粉 1 + 真珠 1）を 12〜14 個。use item=ender_eye（at 無し）で方位 bearingDeg が返る。200m 以上離れた 2 地点で投げ、方位 θ（0 北・90 東、x は sinθ・z は −cosθ）の線の交点を where に。',
    '- ストロングホールド: 交点から vertical の stairs で下り、ポータルの枠（Q）12 か所に use item=ender_eye at=枠 face=up。全部 R になったら中の e のマスへ walk（range=0）で入る。',
  ].join('\n'),
  end: [
    '## エンド',
    '- 柱の上のクリスタルを shoot（囲いは pillarUp で登って打つ）。ドラゴンは止まり木（X）に降りた時に attack、飛ぶ時は shoot。'
      + '降りた時に頭の近くへベッドを place→use で爆発（4〜5 マス離れ、間にブロック）。縁では sneak、奈落に落ちない。',
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
    near: `${text(body.landmarks)} ${text(body.scan)}` };
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
  pearl: kindsOf('pearl', 'stronghold'),
  end: kindsOf('end', 'dragon'),
};
/** When each stage is needed: the dimension, the kinds of the plan's nodes, the structure she is in, what she carries and what is near. */
const STAGE_WHEN: Readonly<Record<StageId, (dimension: string, where: Where) => boolean>> = {
  prep: (dimension, where) => dimension === 'overworld' || hasKind(where.kinds, STAGE_KINDS.prep),
  nether: (dimension, where) => dimension === 'the_nether' || hasKind(where.kinds, STAGE_KINDS.nether) || /要塞|砦/u.test(where.inside),
  blaze: (_dimension, where) => hasKind(where.kinds, STAGE_KINDS.blaze) || /blaze|スポナー/u.test(where.near),
  pearl: (_dimension, where) => hasKind(where.kinds, STAGE_KINDS.pearl) || /ender_(pearl|eye)/u.test(where.inventory) || /enderman/u.test(where.near),
  end: (dimension, where) => dimension === 'the_end' || hasKind(where.kinds, STAGE_KINDS.end),
};

/** The message before the live state: the stages' knowledge, headed by which stages (null when there is no live body to pick from). */
export function stageKnowledge(live: Rec): string | null {
  if (!rec(live.body)) return null;
  const ids = stagesFor(live);
  return `（この場面の知識: ${ids.join('・')}）\n${ids.map(id => V2_STAGES[id]).join('\n\n')}`;
}
