import { MAP_LEGEND_V2 } from '../../contracts/minecraftMapLegendV2.js';
import { milestoneWords } from './minecraftLlmcRoad.js';
import { PREP_DESCENT_RULE, PREP_RULES_WORDS, SAFETY_FIRST } from './minecraftLlmcPrepRules.js';
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
  '- 目的は課題の goal。持ち主の物差しは速さ: エンドラ討伐なら、ネザーへ入るまでを 30 分以内に（準備を含む）、なめらかに進める。',
  '- 速さと同じだけ、生きていることが大事。死ぬと持ち物と時間を失い、用心より時間がかかる。',
  '- 優先の順: 差し迫った危険を避ける → 準備の必須を満たす → 目的へ早く進める。時間を理由に止めたり、早く完了にしたりしない。目安は物差しで、手を決める物ではない。',
  `- 節目の目安（開始からの秒）: ${milestoneWords()}。live の meter が、今と次の節目を言う。`,
].join('\n');

/** The descent's preparation as a rule for choosing the action (one place; the live state and the results say only the state of it). */
const PREP = PREP_DESCENT_RULE;

const DECIDE = [
  '## 決め方（手の書き方は mc_act）',
  '- 毎判断、live の urgent・planNow・shortage・footing・around・route・threats・lastResults と plan を読んで決める。',
  '- 結果を待たずに決められる手は 1 つの act にまとめる。'
    + '動く対象・未知経路・採取は短く区切り、結果と持ち物を読み直す。途中失敗で後の退路や回収も未実行。'
    + '後続の前提は dependsOn。進行中の手は危険・失敗・目的変更時だけ replace。後で使う物は act の keep に書く（帳簿に載る）。約束の物は残し、割るなら why に番号と理由。',
  '- 範囲スキルでは目的・対象・行き先・掘る/置く許可・済む条件を選ぶ。食事・睡眠・片づけ・戦うか逃げるかもあなたが決める。'
    + '経路・工作・設置・戦闘の細部は体に任せる。',
  '- why は節の札で始める（「[p1.2] 丸石でハーフブロック」）。別の節なら番号と理由を書く。数は観測済みと「これから」を分ける。',
  '- 履歴は act の各手の行（周り・地図・probe の長い答えは lastResults に一度だけ）。後で要る座標・危険は plan か why に書く。'
    + '止まったら未成立の前提を直す。同じ手を同じまま出さない。座標・向き・上限だけ変えても、同じ障害や許可不足が残る場合がある。',
  '- 分からない時・同じ止まり 2 回・落ちた時・live に look が出た時は、調べる判断で mc_view か mc_probe（同じ止まり→history と path か sight、落ちた→column、敵→around）。'
    + 'investigation に原因が出ていればそれを使う。原因が分かったら plan_update の forbid（してはいけない事）か caution（気をつける事）の op で、今の節に 1 行書く（plan.rules に出る）。',
  '- jobs は見込み。保留・再接続後は残り秒で待ち直さず furnace op=take で現物確認。夜待ち・焼き待ちより、安全な前提作業・帰路を先に進める。wait だけの act は、有用な手を選べない時だけで、why に待つ対象と理由を書く。',
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

/** The coordinator, 2026-11-03 (leg 2's plan 5.10: the sea and the night on the 1.4 km walk, the phantoms for a body that has not slept). */
const LONG_WALK = '- 地上の長い歩き（1 km 超）は朝に出る。夜は先にベッドで寝る（寝ないと夜にファントムが空から撃ってくる）。';

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

export type StageId = 'prep' | 'nether' | 'blaze' | 'pearl' | 'stronghold' | 'end';
export const STAGE_IDS: readonly StageId[] = ['prep', 'nether', 'blaze', 'pearl', 'stronghold', 'end'];
/** The knowledge of each stage, cut from the own prompt's 材料と手順 / ネザー・要塞・ブレイズ / パール・アイ・エンド. */
export const V2_STAGES: Readonly<Record<StageId, string>> = Object.freeze({
  prep: [
    '## 材料と手順',
    LONG_WALK,
    '- waterOkは入水の許可で、呼吸できる道の保証ではない。地下水や天井下へ入る前に、column・地図で頭を空気へ出せる地点と戻る通路を確認し、移動・採掘・回収・戻りの時間を残りの息と比べる。'
      + '空気の地点や往復が不明なら入らず、乾いた通路の迂回か乾いた足場からの採掘を選ぶ。上が水や岩なら真上へのgoだけでは逃げられない。'
      + '水中で息が減ったら採掘や後続の手を止め、確認した空気へ戻る。浮上反射の開始は呼吸回復ではない。水中で地図の読取りや掘る探索を重ねる時間も息を使う。'
      + '退路をactの末尾に書いても、先の失敗・期限切れでは動かない。水中作業の失敗後は、待つ列を足さず単独の帰還へreplaceし、呼吸回復後に次を決める。',
    '- 掘る経路は地図・columnで通路と頭上の材質を調べ、今の道具で掘れる岩・鉱石・土砂を用途に合わせてcanDigに選ぶ。'
      + 'stoneの許可に鉱石は含まれない。cannot_digは具体的な材質と道具・重力・液体を確認して許可か経路を直し、短く進んで再観測する。秒数や向きだけ変えない。',
    '- 高所から下りる前は column で通過空間と着地の床・水を確かめる。つたの途中は着地ではない。階段・足場と実在する着地点へのgoを比べ、水に入るならwaterOk・許す落差maxDrop、葉等を通るならdigを指定。つたが切れた所から着地までの落差も数える。',
    FOOD_ACQUISITION_KNOWLEDGE,
    '- foodPreparation は加工の見込み。炉・作業台・燃料・設置場所と加工後の持ち物を観測で確かめる。',
    '- 安全な囲いでは、射線・敵の到達・足場を確かめ、朝待ちと調理・工作・近くの夜の狩り（食料源の選び方の条件）を比べる。',
    '- 死んだ後は最新の持ち物・着ている物・敵から計画を組み直す。危険な死亡地点へ裸で直行しない。まず安全な所で道具・食料・盾や防具を作り直す選択と回収を比べる。'
      + '済んだ道具取得の節は履歴であり、今使える道具ではない。回収するなら最新nearの対象と実際の高さ・道・敵を確かめ、現装備での回収と再調達を比べる。'
      + '移動が時間切れでも距離が縮まらない時、秒数を増す・goをwalkへ替えるだけでは道はできない。乾いた側から通路を整えるか、回収を打ち切り準備へ計画を組み直す。'
      + '対象が消えpickupでも見つからなければ、過去の個体を当てに再入水しない。最後に通過した地表は落とし物の位置とは限らない。',
    '- 射手に撃たれている間は、分かっている敵の向きと足場から射線を切る・離れる手を先に選ぶ。'
      + '同じsight・around・columnを何度も読む間も攻撃される。追加の読取りは逃げる手を決めるために必要な不明だけに絞り、工作・回収・食事は安全な位置で行う。',
    '- 食料が少ない時は、今見えている動物・作物・箱と、手持ちの調理見込みを先に使う。鶏しか見えなくても食料源であり、地下へ行けば補えるという根拠にはならない。'
      + '周りに無ければ食料探索の過去観測と比べ、地表の未探索方向を短い中継点で探す。到着後にscanかaroundで現在の個体を確かめてから狩る。'
      + '未確認のcow→pig→sheep等をfightに並べると、最初の対象なしで後ろも未実行になる。過去の個体は移動・消失していることがある。',
    '- 食料の所在と到達・加工を分ける。未知の場所の食料を当てに準備を省かない。省略を選ぶなら、今の携帯食料・防具・実在する補給先・戻り方を比べてprepの理由と計画に残す。'
      + '「探索に時間がかかった」「既に地下」「skippedを書いた」だけでは、食料や防具は補えない。箱は食料入りとは限らず、建物と周囲の敵を確かめる。射手のいる建物へ無防備で食料を取りに行かない。',
    '- 地下で食料を補えない時は、帰還の観測記録と以前の通過点から戻る道を比べ、pathやcolumnで短い区間ずつ確認する。'
      + '通過記録は逆向きの安全を保証しない。新しい穴を掘り続ける前に既存の階段・通路を調べる。水や鉱石の座標は地上の出口ではない。'
      + '魚は見えた個体と岸・水面の出入口を確かめて狙う。魚を探すためだけに地下から水の天井を開けない。',
    '- 補助の魚を取ると選んだ時だけ、岸から届くかsightで調べ、狙う個体を選んでfightへ追従と武器の持替えを任せる。attackを選ぶなら先に手の武器を確認する（食後は食べ物や空手のことがある）。動く魚の過去座標へgoしてから複数個体を攻撃する列にはしない。'
      + '潜るなら先に氷などの出入口を開け、水へ入れたことと戻る穴・息を確認する。goの水中の上下移動は、体の幅と高さが通る既知の静水の通路だけで、氷や壁を越えない。'
      + '1個体の結果後に持ち物と落ちた食料を確かめ、回収・加工・補給の成果で続行を決める。呼吸の反射後は水面への復帰を先にし、深い魚の追跡と届く別個体・地上の食料を比べる。',
    '- 準備の必須と目標は system の「準備の決まり」。ここは材料と手順の知識。食料の点（live の foodPoints.total。満腹 fullness とは別）は、ネザーの奥へ 100、エンドへ 80 以上。'
      + 'かまどの燃料は石炭 1 で 8 個・木材 1 で 1.5 個、鉄と一緒に肉も焼く。食べ物の当てが近ければ、取るのは数十秒〜2 分。',
    '- 生の鉄が 5 個以上ならかまどを 2〜3 基に分けて焼く（1 個 10 秒）。焼く間は掘る・狩る。',
    '- 木は、足の高さから幹に届く木か、走査の近い原木を選ぶ。崖の上・高い所の木へ土で登る手が 2 回止まったら、その木はやめて別の木へ。',
    '- 木が無い時: 地表の木（mc_probe kind=scan で原木の方角・mc_view mode=top で上から）→村の木の物（扉・柵・ベッド・作業台・板、takeOk）→難破船→廃坑（vertical の stairs で下りる）。',
    '- 村は鉄より前に 128m 内を回る（takeOk: true。鉄ゴーレムと村人は打たない）: ベッド（下の決まり）、干し草（1 個でパン 3）、育った畑、箱は chest op=look→take。',
    PREP_RULES_WORDS,
    SAFETY_FIRST,
    '- 鉄は y=16 前後（i）。ダイヤは y=-58 前後（d、鉄のツルハシ）。水バケツは水源（w）の隣から use（流れ - からは汲めない）。',
    '- 資源のマスと作業の立ち位置は別。距離や数より、通れる道・高低差・掘る/置く許可・視線と足場を比べる。'
      + '今届く操作に移動は不要。不明な経路は path、操作の届き方は sight、上下は column で確かめる。'
      + 'search_timeout 後は、観測した10m以内の立てる中継点か短い階段へ区切る。遠い資源の高さだけ変えて繰り返さない。',
    '- 頭上の砂・砂利で止まったら、落下する列の外に床と頭の空間がある作業位置を取る。水の隣・流れる先・退路も先に確認する。'
      + 'そこから届く支えは横から dig し、不要な pillarUp を先に挟まない。届かない時だけ sight・column で作業高さを決める。'
      + '掘った後は落下と水流が落ち着くのを待ち、地形を読み直してから進む。支えを掘れたことと、通路ができたことは別。waterOk だけで水中を真上に登れるとは限らない。',
    '- 黒曜石は現在数と不足分を数え、到達できる溶岩源 L と既存の O を組み合わせて集める。同じ作業位置から続けて取れる源も比べる。多い溜まりでも道が未確認なら早いとは限らない。'
      + '水入りバケツ・ダイヤpick・作業位置を先に確保し、obsidian に対象・足場に使う物・採掘の上限を渡す。注水・待機・採掘・回収・水の汲み戻しはこの手が行う。'
      + '手動で水を置くなら、先に乾いた作業位置・流れる先・源を回収できる視線を確かめる。水を置いてから流れに逆らう移動を前提にしない。'
      + '手で掘る時は足元・立っているマスからは離れたマスを開ける。'
      + '失敗後は実在庫と世界を読む。置いた水は持ち物の water_bucket ではない。源を汲み戻してから水バケツが必要な手を再開する。',
    '- ゲートは portal の手（枠の内側の左下と向き。黒曜石10・火打ち金（鉄1・火打石1））が組んで点けて入る。',
    '- すでに点いたポータル（p ネザー・e エンド）の入り方: そのマスの中へ walk（range=0。足と頭がポータルのマスで、下は枠の黒曜石）して、約 4 秒立って待つ。着いた先が次元の変化。'
      + 'ポータルのマスには place できず、その上面は床ではない。',
    '- ネザーで作り直す: 真紅・歪んだ幹（素手で可）→板（1 で 4）→作業台（持ち歩く）・棒。丸石 3→ハーフブロック 6。盾は板 6・鉄 1 で offhand に equip。'
      + '金の防具は延べ棒 4（靴）〜5（兜）。',
  ].join('\n'),
  nether: [
    '## ネザーと要塞',
    SAFETY_FIRST,
    '- ネザーの x・z はオーバーワールドの 1/8。帰りのゲートの座標を where に書く（帰りも p のマスの中へ walk して約 4 秒待つ）。y=31 より下は溶岩の海、マグマ（M）は燃える。',
    '- ピグリンは金の防具を 1 つ着るまで襲う（着るまでピグリンの群れ・砦の遺跡の 8m 内に長居しない）。金を掘る・箱を開けると怒る。',
    '- 要塞（N）は帯に並ぶ: ゲートから 1 方向へ 100〜300 進み、無ければ直角へ（mc_probe kind=scan radius=32 で要塞・ネザーレンガの方角、高い所から mc_view mode=top）。',
    '- 要塞やスポナー（S）の近くでは通路を歩かず、床より 1 段下の岩に 1 幅 2 高のトンネルを掘って進む（足と頭を dig→1 歩）。射線の中で立ち止まらない'
      + '（wait・食べる・作るは見えない所で）。',
    '- ガストの火の玉は体が打ち返す。溶岩の縁・橋の上で撃たれたら岩の側へ寄って受ける（押されて落ちるのが多い死に方）。ウィザースケルトンは近づかれる前に離れる。',
    '- ポータルの対は live の「控え」の行（ネザー側の座標 ↔ 向こう側の座標）。ネザーで死ぬと持ち物はそこに約 5 分残る（近くにいる間だけ減る）。'
      + 'リスポーンはベッドか最初の場所（オーバーワールド）。取りに戻るか装備を作り直すかは、最後の死の行の残り時間と比べて決める。',
    '- ソウルサンドの上は歩幅が 4 割（時間 2.5 倍）。go の経路探索は、回り道が少し長いだけなら避けて回り、他に道が無ければ渡る。',
    '- 遠い go（要塞へなど）は最初から canDig=[netherrack,basalt,blackstone]（要塞の床・壁へ入るなら nether_bricks も）・canPlace=[cobblestone,netherrack]'
      + '（掘った netherrack が荷にたまり、約 100 回掘って 99 個。橋の材料が尽きない）・maxDig 120〜200・maxPlace 40〜100・seconds 100〜120 を渡す。'
      + '既定の 40・20 では limit_dig・limit_place で止まり、体の言葉に従って上げ直すと判断が 3 回要る。',
    '- ポータルの手（enter）で入ると、その act は「次元が変わった…（手の途中）」と止まって返る（入れた印で、失敗ではない）。入った直後の 60 秒は、scan と landmarks で足元と溶岩を確かめてから動く。'
      + 'ゲートの出口の高さは、地上の枠の高さとは限らない（出口が溶岩の岸のことがある）。着いたら、足元と溶岩を確かめる。',
    '- go は 1 手 90m 以内に分ける。limit_time は、同じ行き先をそのまま出し直せば着く。'
      + 'ただし search_timeout（道探しが終わらない）が続く所は、出し直しても同じ所で止まる: 同じ go を繰り返さず、10m 以内の立てる中継点を行き先にして区切る。'
      + 'limit_place は置く物の上限（置く所が maxPlace の残りを超える）なので、1 手を短くするか maxPlace を上げる。',
    '- ブレイズの湧き場（要塞）から出る前に体力を戻す（要塞の生き物を残して出ると、ウィザースケルトンとブレイズに囲まれて体力が短い間に尽きかねない）。足場の外へ出てからは、出口側へ短い go を重ねる。',
    '- 道のバイオームで危険が変わる: 玄武岩の三角州・荒地は静かで、真紅の森（crimson_forest）にはピグリンとホグリンが湧く。'
      + '金の防具を 1 つ着ていないとピグリンは敵になるので、真紅の森を避ける道を選ぶか、金のブーツを先に作る（金 4 がそろう時）。',
    '- 速さの目安は 1 ブロック 1.5〜2.3 秒（道が岩や溶岩の岸なら遅い）。丸石 64 だけの橋は 64 ブロックで尽きる。',
    '- go が止まったら、体の行の言う通りに直して同じ先へもう一度 go する: limit_dig・limit_place は上限を増やす（「maxDig を増やす」）、dead_end の「が nether_bricks で登れない」は'
      + '「canDig に足す」、no_blocks は行が名指しする物（「荷の netherrack×99 を canPlace に足す」）を足す、「置く物 cobblestone を N 個置いて使い切った」は置く物を足すか補う。'
      + 'low_floor と「置いたブロックが世界に現れない」、マグマの上で反射が手を止めた時は、同じ go をもう一度で進んだ。火のマスは dig で消せる（unsafe の行が「火 (x,y,z) は dig で消せる」と言う）。',
    '- 要塞を探す: mc_probe kind=scan が「ネザー要塞」の向きを言う。近づいたら mc_probe kind=camp が湧き場と足場を言う。',
    '- ツルハシ: ネザーに入る前に石のツルハシを 2〜3 本作って持つ（丸石 3・棒 2 で 1 本）。体は安い道具から使うので、石とネザーラックは石のツルハシで掘る。'
      + 'ダイヤのツルハシの耐久（持ち物の行）が 300 を切ったら、黒石か丸石と棒で石のツルハシを作って使う。',
    '- 道具が壊れて止まった時（行が「同じ種類以上の予備が荷に無い」と言う）は、作るか拾って持ってから同じ手をもう一度。鉄はネザーに無い。鉄のツルハシは 1 本が耐久 250 で、'
      + 'ネザーの岩を掘り続けると壊れる。予備が荷にあれば go は持ち替えて続ける作りだが、実機では未確認。',
  ].join('\n'),
  blaze: [
    '## ブレイズ',
    SAFETY_FIRST,
    '- ブレイズは準備（shortage が空）の後。準備の前に近くにいる・撃たれた時は戦わず、射線の外の岩へ離れて塞ぐ。',
    '- 戦い方: mc_probe kind=camp が、湧き場と、その 3m 以内の縁・火の無い立てる足場を教える。その足場へ go で着いてから fight target=blaze（種類名か #id）。'
      + '体は追わず、キーも押さず、盾の下で待つ（盾が荷にあれば左手に移す）。目より 3 マス以上上に浮いた相手は降りるまで待ち、届く所に来た相手を打つ。'
      + '撃つ直前と火の玉が 10 tick 内に着く間は打たずに見送る。手に剣を持つ。必ず stopIf hpBelow 12 を付け、1 回の act は短く（seconds 30 まで）。スポナーは壊さない。',
    '- 湧き場の足場にいる間は、全部の act に accept: ["blaze"] を付ける（dig で火を消す・go・eat・pickup・place だけの act にも）。fight・attack の手の間は体が自動で同じ扱いにするが、'
      + '戦いの手が無い act には accept が無く、燃えていて blaze に見られているだけで床の反射が体を取り、足元を掘って下がる（火を消す dig だけの act の間に足場の床を掘り、'
      + '足場が無くなって落ち、camp を見失うことがある）。1 段の穴は上に浮く blaze から隠れない。accept があれば、反射が体を取るのは体力が低くなった時だけ。'
      + '足場を失ったら、荷の丸石で go（canPlace=[cobblestone]）か place で床を戻す（go の no_blocks の行が荷の丸石を名指しする）。',
    '- fight で傷が大きい時: fight は 1 回の act で体力が大きく減ることがある（撃破の割に傷が深い）。同じ足場の attack target=blaze hold=true'
      + '（動かず盾で待つ）は傷が少なめだが、標本は小さい。'
      + '体力が 12 を割ったら fight をやめて足場の岩の陰で回復し、続けるなら hold に替えられるが、hold も傷が少ないとは限らないので、12 を割る前に退く。',
    '- 倒すと「落とし物 blaze_rod×1」が行の先頭に出る。拾うのは次の手（pickup、敵がいない時）。行に「湧き場 (x,y,z) まで Nm」「盾 −N（残り M）」「見送り N」が出る。',
    '- 待ち打ち: ブレイズは 10〜40 秒おきに湧き（あなたが 16m 内の間）、1 体で棒は 0〜1 本（平均 0.5）。7 本には 14 体前後: 数分から十数分を見込む。'
      + '粉にするのは 7 本そろってから。',
    '- 盾は止めた火の玉 1 個で耐久が 6 減る（盾 1 枚 336）。6 体が撃つと盾 1 枚が約 25 秒で壊れる。体は防げない: 湧き場に長く立たない・撃つ体を減らす・盾の予備と火炎耐性を持つ。'
      + '7 本には 7 分前後と盾 2〜3 枚を見込み、傷が 12 を超えたら退く。',
  ].join('\n'),
  pearl: [
    '## パールとアイ',
    SAFETY_FIRST,
    '- パールの当て: ①歪んだ森（青い森）のエンダーマン ②ピグリンに金の延べ棒を渡す（当たりは約 2.1%、当たると 2〜4 個。金 16 個で平均 1 個、12 個には 190 個前後。ばらつきが大きい）'
      + '③夜のオーバーワールドのエンダーマン（少ない）。近い当て・金がある当てを並べて選ぶ。金が 190 個前後に届かない時は、物々交換を選ばず、エンダーマンを選ぶ。',
    '- ピグリンとの交換: use item=gold_ingot target=piglin が金 1 個の交換をまるごと行う（渡す→6 秒見る→投げ返した物を拾う）。先に金の防具を 1 つ着ける'
      + '（equip item=golden_boots。着けた後に読み戻し、違えば equip_failed）。code: not_adult（子ども）・piglin_hostile（怒っている）・out_of_reach・not_accepted・nothing_returned。',
    '- エンダーマン（HP 40・背が 3 マス）: 目を合わせると怒る。準備なしに合わせない（look で足元）。弓は使わない（テレポートでよける）。'
      + 'fight target=enderman は体が屋根の穴を作って戦う: 平らな床で 3×3×2 の空きがある所に立って呼ぶ。建築用ブロック 11 個（丸石・土・ネザーラック等）が要り、'
      + '足りないと missing_item、場所が悪いと no_site、くり抜きかぼちゃを被っていると pumpkin で、何もせず返る。穴の中から目（足の 2.55 上）を見て怒らせ、'
      + '屋根の縁で打つ（練習場で確かめた形。本物のエンダーマンでは未確認）。怒った後は目を見ない。離れる時は live の away の隣へ。',
    '- アイは粉 1 + 真珠 1（ロッド 1 本で粉 2）。craft item=blaze_powder count=N（ロッド N/2 本）→ craft item=ender_eye count=N（粉 N + 真珠 N）で、作業台は要らない'
      + '（count=6 を 1 回で呼んで 2.0 秒）。枠は最初から平均 1 つ入っているので 11〜12 個が要り、投げの損耗に 2〜3 個を足して 14 個を目標にする（パールも 14）。',
  ].join('\n'),
  stronghold: [
    '## ストロングホールド',
    SAFETY_FIRST,
    LONG_WALK,
    '- ストロングホールドへの道は 2 つ。地上の長い歩き（距離に比例して時間と丸石がかかる。海は迂回になる）は、'
      + '丸石を多めに持つ（歩きながら石を掘って足してもよい）・maxPlace 100・1 手は 110m 前後に分ける。夜は先に寝て、朝に出る。'
      + 'ネザー経由（ゲートの近くで 50〜100m 離れた 2 か所でアイを投げて交点を出す → ネザーで (x/8, z/8) へ歩く → 黒曜石 10 で 2 つ目のゲートを建てて出る）は、距離が 1/8 になるが、'
      + 'ネザーの歩きが通らないことがある（出口が溶岩の岸で、search_timeout が続く）。どちらの道にするかは、アイの交点が出た時に、ゲートから交点までの距離（地上で歩く長さ）を測って、頭が決める。',
    '- アイは use item=ender_eye（at 無し）で投げる。体が目玉の飛びを最大 10 秒追い、結果の eye に 向き（bearingDeg 0 北・90 東）・飛んだ距離・終わり方'
      + '（落ちた＝pickup で拾える／割れた）を返す。頭が帳簿に書き、live の「目玉の帳簿」に 交点・誤差の見積り・次に投げる場所の案 を出す。'
      + '交点が出るまでは、最後の線の横へ 200m 以上動いて投げる（2 本の線が離れて交わるほど誤差が小さい）。',
    '- 最初の 3 つの要塞は原点 (0,0) から 1,280〜2,816m の輪の上にあり、アイは一番近い要塞へ飛ぶ。交点がこの輪から大きく外れたら向きや帳簿を疑う。',
    '- 交点が出たら、その 100m 手前まで歩いて投げ直す（線の誤差はごく小さい）。目玉が真下へ沈んだ（down）所、または 12m 足らずで止まった（arrived）所が'
      + '要塞の入口。ポータルの部屋はそこから 7〜72 ブロック離れていた（測った世界では）。落ちたアイは約 5 分、pickup で拾える（割れるのは 5 回に 1 回ほど）。',
    '- 枠は mc_probe kind=frames（x z=探す中心、省くと足。radius=16〜128、既定 64）が、要塞のエンドポータルの枠を近い順に最大 12 個教える。入口で radius 128 を使う'
      + '（読み込みの外なら 16 ブロック刻みの輪の次に歩く点を返すので、歩いて着いたらもう一度）。感染した石レンガは要塞が近い印で、枠ではない。枠が見えたら live の印（Q）にも出る。',
    '- 下り: go to=立てる所 maxDig=120 canDig=[stone,dirt,gravel ほか 12 種まで] canPlace=[cobblestone]。真下を素手で掘らず、溶岩に注意。'
      + '石レンガの廊下に出たら歩く。ひび割れ・苔の石レンガに紛れた感染石を掘るとシルバーフィッシュが出る。図書室・牢屋・泉の部屋は寄らない。',
    '- 枠（Q）の部屋: 溶岩の溜まりの上の台に枠 12 か所（最初から入っている枠もある）。目の無い枠ごとに 1 回の act で [{do:go, to:枠の座標, range:3}, {do:use, item:ender_eye, at:[枠の座標]}]'
      + '（at は配列で 1 つ）。1 枠 0.7〜2.0 秒で、はまった数 N/12 が毎回行に出て、最後の枠で「エンドポータルが開いた」と出る。足りないアイは live の「ポータルの枠」の行に出る。',
    '- 入る前に、近くで place した bed を use してリスポーン地点にしておく（昼でも設定できる）。エンドで死んでも、この近くで復活して戻れる（ベッドで寝るのはここまで。エンドの中のベッドは爆発する）。',
    '- 開いたら中の e のマスへ walk（to=ポータルのマス、range=0）で入る。go ではなく walk（go は「ポータルは walk の的にして入る」と断る）。ポータルは溶岩の上のシートなので、'
      + '枠の輪（足が枠の上）から歩き込む。行に「エンドへ移った (100,49,0)」と出れば着いた。',
    '- エンドに入る前に、丸石か黒曜石を 3 個以上（できれば 64 以上）荷に持つ。着く足場（虚空の黒曜石 5×5）に竜の火の玉が落ちると、体の反射が足元へ 1 個積んで 1 段上がって避ける'
      + '（0.4 秒・被害 0、ラボ実測）。積む物が無いと雲で 4 秒ほどで死ぬ（台帳の cover_none:「足元に積めるブロックが無い。次: 黒曜石か丸石を手に入れる」）。',
  ].join('\n'),
  end: [
    '## エンド',
    SAFETY_FIRST,
    '- 着くのは黒曜石の台（100,49,0）。主島までは虚空のことが多い: 足元に橋を置いて渡る（go の canPlace は足元の床だけで、壁は作らない。幅 1 の橋は押されると落ちるので、玉や敵が来る間は渡らない）。縁では sneak（歩いて落ちるのは防ぐが、押されるのは止めない）。落ちたら戻れない。'
      + '足場から島へは go to=島の上のマス canPlace=["cobblestone"] maxPlace=100 seconds=120（ラボで 30 ブロックを 30 秒・置 14・被害 0。竜は島の上に止めて測定）。',
    '- 島への橋（幅 1）の先端は、竜の玉が落ちる向きによっては、体の避けが「道なし」になる（S1 の実測）。先端で長居せず、玉が来る向きを見て渡り、足場の石を積める数（3 個以上）を持つ。',
    '- 息の雲が地面に残る間、go は雲の中を通る道を引かない。他に道が無いと「go 止まった dead_end: 道の先が竜の息の雲の中で、避けると道が無い（雲は約 30 秒で消える）」を返す。'
      + 'この文が出たら、雲が消える（観測の dragonBreath が空になる）まで高い足場で待つか、別の側から行く。雲を受けて反射が 1 段上がった後に同じ go をすぐ出し直すと、雲の中へ戻って傷を受ける。',
    '- 止まり木に竜が降りている間（phase 2〜3）に、表彰台から 5〜12m に立っていても被害は無かった（座った瞬間に頭の向く側の 5m だけ 3）。',
    '- 鉄格子の檻つきのクリスタルの柱を登る時は、水の入ったバケツ（鉄 3）を hotbar（最初の 9 スロット）に持つ。ただし体の自動の落下止め（水バケツで落下を止める床の反射）は、今は働かない前提にする。'
      + '柱の上から落ちる（翼の押し・爆発・踏み外し）と、20 ブロックで被害 17、それ以上で死ぬ（ラボ。防具は落下を減らさない）。水バケツは手で使う物: 高い所から降りる前に、着地点に水を置く。'
      + '落ちないことを第一に、足元と両脇を積める物で囲い、柱の上に居る時間を短くする。',
    '- 柱の上は歩いて離れる道が無い。ラボ: 幅 1・30 ブロックの柱の上に、積める物も水バケツも持たずに居た体は 144 秒で死んだ（玉が 8 つ線を通り、最後の雲が柱の上に載って 1 秒ごとに 6 を 3 回）。'
      + 'ブロック 12 個と水バケツを持つ体は、玉を 3 つ落とされても 3 回積んで上がり（96→99）被害 0、2 × 153 秒の待ちも被害 0（積む度に 1 個減る）。'
      + '登る時は、積める物（黒曜石かエンドストーンが先、丸石も可）を 3 個以上残し、柱の上に居る時間を短くする（地面の約 2 倍、玉が来る）。島の地面でじっと立つ体は 2 × 150 秒で被害 0 だった。',
    '- live の「竜」「エンドクリスタル」「竜の息の雲」「火の玉」「止まり木」の行は体の観測そのもの。体が決めないのは、どこに立つか・いつ振るか・いつ逃げるか'
      + '（床の逃げ以外）・どのクリスタルを先に壊すか・ベッドを使うか。',
    '- 順番（隔離ラボで確かめた）: ①クリスタルを先に壊す。止まり木の竜はクリスタルが残る間 +2 体力/秒で回復する。②竜が止まり木に降りたら頭を剣で打つ。',
    '- クリスタル: shoot target="#id"（13〜64m、弓を 21 tick 引く。檻なしは 1 発で壊れた）。too_close・too_far は距離を変える。line_blocked は矢の道の固い物で、'
      + '檻の鉄格子は塞ぐ。文に塞ぐ所の座標が出るので、その格子だけ dig で取ってから撃つ（格子 2 つを消して 17.8m から 1 発で壊れた）。'
      + 'attack target="end_crystal" は 3m 以内の 1 撃で、爆発の見込みが体力に足りないと blast_unsafe（数字つき）。爆発圏は 12m: live の行の「壊すと爆発（体力 −N の見込み）」を見る。',
    '- 竜の頭: attack target="ender_dragon"（#id でも）は止まり木の間だけ頭の部位を打つ。歩かない（立ち位置は go）。待ちは剣 13 tick。止まりの code: not_perched・'
      + 'out_of_reach・perch_over（飛び立った）・time_up・target_lost。倒すと ok で「倒した」。live の行の「頭の箱まで N m（剣が届く）」は、サーバーが受ける届き'
      + '（目から頭の箱まで約 6m）より手前の 5m で体が振る印。止まり木の竜に shoot は効かない（perched_immune）。飛んでいる間は shoot target="ender_dragon"。'
      + 'fight は竜に使わない（普通の敵として追ってしまう）。'
      + 'attack ender_dragon は今の手持ちで打ち、体は剣を持ち直さない。壁抜けや水バケツを使った後に手が別の物のことがあるので、打つ前に equip で剣（か斧）を手に持つ。',
    '- 数（隔離ラボ）: 頭への剣 1 回 7、首・翼・胴は 2.75。止まり木の間に与えた被害が最大体力の 1/4（50）を超えると竜は飛び立つ（バニラの規則）ので、1 回の降下で削れるのは約 50。'
      + '竜の体力 200 には 4 回以上の降下が要る。',
    '- 息の雲（紫の粒子）は半径 7m 以上として避け、雲の中で立ち止まらない。体の床の逃げは水平だけで、息の雲・火の玉・止まり木の竜の体から離れる。縁の外へ押されると落ちる: 縁から離れて戦う。'
      + '止まり木の周期（隔離ラボで測った）: 着陸の約 10 秒後に 見回し 1.2 秒（phase 6）→ 吠え 2.0 秒（phase 7）→ 息 10 秒（phase 5、雲は頭の 2.5m 先に息の間ずっと）'
      + '→ 見回し → 吠え → 息 → 飛び立ち（phase 4）。1 回の止まりは約 27 秒で、打てる窓は見回しと吠えの前半（約 2.5 秒）、1 回の止まりに 2 つ。息の間は頭の 7m 以内に入らない。',
    '- ベッド: use at=[ベッドのマス]（ネザー・エンドだけ。寝ずに右クリックで爆発）。結果の文に 爆発した・自分まで届いた・失った体力・竜の頭の箱まで・竜の体力の前後 が出る。'
      + '自分への被害が体力に足りないと blast_unsafe で断る。体は自分では使わない。隔離ラボ: 竜の頭の箱の 1.5 ブロック先（爆発の中心から 3m）に置いて使うと竜が約 38 減った（剣 5〜6 回分）。'
      + '自分は黒曜石の壁の後ろ（4.4m）で −0.2、壁なしの 5m で −16（文の「見込み」とは ±0.4）。竜の頭が回っている間（見回しの最初の約 5 秒）は置いたベッドが消える: 頭が止まってから置く。',
    '- エンドで死んだら: リスポーンはベッドか最初の場所。落とし物は約 5 分で消え、エンドは遠い。戻るのは開いたポータルから（座標は live の控え）。竜の体力と壊したクリスタルは戻らない見込み（未確認）。',
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
  pearl: kindsOf('pearl'),
  stronghold: kindsOf('stronghold'),
  end: kindsOf('end', 'dragon'),
};
/** When each stage is needed: the dimension, the kinds of the plan's nodes, the structure she is in, what she carries and what is near. */
const STAGE_WHEN: Readonly<Record<StageId, (dimension: string, where: Where) => boolean>> = {
  prep: (dimension, where) => dimension === 'overworld' || hasKind(where.kinds, STAGE_KINDS.prep),
  nether: (dimension, where) => dimension === 'the_nether' || hasKind(where.kinds, STAGE_KINDS.nether) || /要塞|砦/u.test(where.inside),
  blaze: (_dimension, where) => hasKind(where.kinds, STAGE_KINDS.blaze) || /blaze|スポナー/u.test(where.near),
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
  return `（この場面の知識: ${ids.join('・')}）\n${ids.map(id => V2_STAGES[id]).join('\n\n')}`;
}
