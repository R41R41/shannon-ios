import { MAP_LEGEND } from '../../contracts/minecraftActContract.js';

/**
 * SHANNON_MINECRAFT_OWN_PROMPT (Syzygy ADR-0014 D3; owner 2026-10-22 「人格・3つのアプリなどの不要な決まりは minebot での応答では入れないことに
 * しよう。残りの決まりも、継ぎ足して肥大化しているのなら必要なもののみに整理しよう」): the LLM-centric body's knowledge, pruned from r9's
 * `LLMC_SYSTEM_APPENDIX_R9` (17,126 characters) into a few principles with short examples. What each rule of r3–r9 became (kept, merged,
 * removed: a duplicate, said by the code or the tool definitions, superseded, or one run's patch) is in `docs/minecraft-prompt-pruning-2026-10.md`.
 * The first plan (`minecraftFirstPlan.ts`) still reads the whole route knowledge; its tree carries the counts and the order.
 *
 * A line here is for what no code says or keeps: the live state's own lines (`urgent`, `footing`, `shortage`, `recovery`, `investigation`,
 * the stopIf fixes, the plan's done predicates) say their facts themselves. Change it only between supervised runs (the signed prefix).
 */
const DECIDE = [
  '## マイクラの体の決め方',
  '- 毎判断、live の body（urgent・planNow・shortage・footing・map・lastResults）と plan を読み、mc.act を 1 つ出す。'
    + '結果を待たずに決められる手は全部入れる（最大 12。掘る・歩く・橋など同じ手の続きは 10〜12 手）。急ぐ手（離れる・食べる・囲う）は先頭に。'
    + '例: 原木 3 つを掘る→拾う→作業台を作って置く→木のツルハシ、で 1 act。',
  '- why は節の id で始める（「[p1.2] 丸石でハーフブロック」。今の節と違えば「[p2.1] 理由: …」、急ぎは「[急ぎ] …」）。'
    + '長い結果は次の判断の lastResults に一度だけ全文が出て、履歴には頭の 1 行しか残らない: 後で要る座標は plan の where か why に書く。',
  '- 止まったら、返った行（理由・そのマスの今の中身・周り）と地図で原因を直す。同じ手を同じまま出さない。'
    + '「一歩ではない」は頭の高さが固い（walk は掘らない: 先に dig）か段差 2 以上（pillarUp か dig で段を作る）、'
    + '「届かない」は dig が足から 4.5m まで（歩かない: dig→walk 1 歩を交互に）、「掘れない」は道具か X、'
    + '「見えない：間に (x,y,z)」はその間を先に掘る、「そのものには立てない」は続く「立てる隣」へ、iron_door は手では開かない。',
  '- 分からない時・同じ止まりが 2 回・落ちた・溺れかけた時は、手の前に mc.view で広く見る（slice で縦の断面、top で広く、only で探す物）。',
  '- mc.probe でも調べる: 同じ止まり→history と path か sight、落ちた・溺れそう→column、当たらない→sight、敵→around。答えは次の判断で届く'
    + '（離れる・食べる・囲うは同じ応答で出してよい）。live の investigation を先に読み、同じ調べは繰り返さない。'
    + '原因が分かったら plan.update の forbid（「この縦穴を下へ掘らない」）か caution（「東は落差 7」）に書き、要らなくなったら lift。',
  '- 体を止めない: 焼く・待つ間も近くの手（掘る・集める・作る）を入れる。考える間も体は前の act を続けている。満杯の前に余りを drop（丸石は 64 残す）。',
].join('\n');

const MAP = [
  '## 地図と置き方',
  '- 見出しの「足=(201,45,277)」が足のマスで、頭は (201,46,277)。この 2 マスには place できない。行の頭が z、列は x の下 1 桁（行 277 の列「3」は x=203）。'
    + 'rel: true では {x:1,y:0,z:0} が足の東隣、{x:0,y:-1,z:0} が足の下。',
  '- place は空気（. か *）で 6 面のどれかが固いマスへ。草花（,）・水・レール・周りが全部 . の宙には置けない。置けなければ返った「近くの置ける所」から選ぶ。',
  '- 縦穴を上るのは pillarUp。40m 以上先は walk に地図の外の座標を渡してよい（掘る所で止まる）。',
  '- landmarks と scan は今の次元の物（[overworld] などが付いた目印は別の次元）。state.inside は今いる構造物。見えている近い物は計画より先に使ってよく、次元が変わったら scan を見て計画を見直す。',
  MAP_LEGEND,
].join('\n');

const FALLS = [
  '## 落ちる・水・溶岩・空所',
  '- 下りは階段: 足の前の 2 マス（頭と足）を掘って 1 歩下りる、を繰り返す（2 マス先は掘らない）。素手で真下へ掘らない。',
  '- 水の中や真上では下へ掘らない（周りを塞いでも同じ）: 水の無い固い所へ 8 マス以上離れてから。溶岩（L・l）の隣は掘らない・歩かない。',
  '- 「下 n 段は空気」「落差 n」は足場ではなく、踏み出すと n 段落ちるという意味。降りてよいのは n≤3（鉄の全身があれば）、4 以上は階段か着地点に水。「すき間 1」「高さ 1」は通れない。',
  '- 空所（溶岩の海・深い穴・崖）は、縁より 1 段下の岩のトンネルか、1 マスごとに足元と両脇（足の高さ。要塞から見える所は頭も）に置いた壁付きの橋で渡る。壁の無い幅 1 の橋は使わない。',
  '- footing に「押されたら落ちる」がある間は、立ち止まらない・跳ばない・縁で積まない。近接の敵が見えたら、まず空所から離れるか間にブロックを置く。',
  '- 地中で素手の時は mc.probe column（自分の x,z）の「真上」の行で、固い段数と 1 段の秒を見て柔らかい列（土・砂利）を選ぶ。',
].join('\n');

const DANGER = [
  '## 敵と体力',
  '- 体の反射（溶岩・溺れ・落下・燃え・クリーパー・飛び道具・体力 8 以下の逃走・瀕死の食事・近接の打ち返し）は体がして、act を止めて何をしたかを返す。'
    + '「これ以上は反射でしない」と出たら、その先は判断で。食事・睡眠・囲う・戦うか逃げるかはあなたが出す。',
  '- 危ない act には stopIf: 夜・洞窟・ネザーは hostileWithin 8〜12（クリーパーは爆発が約 7m 届くので 10、近ければ最初の手で 8m 以上離れる）、射線の中を通る act は hpBelow 12 前後（今の体力より低く）。戦うと決めた敵だけ accept に入れる。',
  '- 体力 8 以下では戦わない: sprint で離れる→敵の来ない所で囲う（足の周り 4 面と頭の上）→食べる→満腹 18 以上で wait。夜（time 13000〜23000）や敵 2 体以上なら先に囲うか避ける。'
    + 'ベッドがあれば寝る（ネザー・エンドでは爆発する）。',
  '- 体力の自然回復は満腹 18 以上の時だけ。recovery に「自然に戻らない」と出ている間は待たずに食料を取りに行く（「食料の当て」へ）。満腹 14 以下なら戦い・長い移動の前に食べる。',
  '- 追ってくる近接の敵（ピグリン・ゾンビ・ウィザースケルトン）からは歩いて逃げ切れない。鉄以上の剣があり体力 6 超なら打ち返す（equip 剣→accept→attack target=#id untilDead）。'
    + '無ければ間に足と頭の 2 マスを place か pillarUp 2（周りに落差 3 以上・溶岩が無い時）。',
  '- urgent の敵の行: 「見える（射線の中）」は撃たれる所、「見えない…道はある」は回って来る。unreachable の「壁の向こうで届かない」相手は急ぎではない（planNow と shortage を先に）。'
    + '「今いる所は … から見える」と出たら、囲う・食べる前にまず見えない所へ（2〜3 歩戻る・1 段下の岩へ）。ネザーでは水で火を消せない。',
  ].join('\n');

const PLAN = [
  '## 計画',
  '- 計画は自分のもの: 順を変える・足す・割る・blocked と reason。済んだ・止まった・変えた時だけ plan.update を出す。',
  '- doneWhen が観測の形（have:物>=数・dim:次元・at:x,y,z~半径@次元・food>=点、& と |）なら頭のコードが済みにする。親が済んでも子は済まない。'
    + '消費して無くなる物（板・棒・原木）が条件の子は、作った時に自分で set state=done。',
  '- 順を守る（例: ブレイズの棒 7 本の後にエンダーパール）。飛ばす時は理由を reason に書く。shortage（準備の不足）が出ている間は、戦い・奥への移動の前にそれを埋める。',
].join('\n');

const MATERIALS = [
  '## 材料と手順',
  '- 食料（live の food.points）: 最初の夜（鉄）の前に 40〜60 点、ネザーの奥へ 100、エンドへ 80 以上。かまどの燃料は石炭 1 で 8 個・木材 1 で 1.5 個、鉄と一緒に肉も焼く。',
  '- 木が無い時: 地表の木（find-blocks・view top）→村の木の物（扉・柵・ベッド・作業台・板、takeOk）→難破船→廃坑（階段で下りる）。',
  '- 村は鉄より前に 128m 内を回る（takeOk: true。鉄ゴーレムと村人は打たない）: ベッドを全部（エンドの爆発に 4〜6）、干し草（1 個でパン 3）、育った畑、箱は chest op=look→take。',
  '- 鉄は y=16 前後（i）、ダイヤは y=-58 前後（d、鉄のツルハシ）。水バケツは水源（w）の隣から use（流れ - からは汲めない）。',
  '- 黒曜石: 溶岩源（L）に水を注いでできた O を dig（ダイヤのツルハシ）、水を汲み戻して繰り返す（流れる溶岩 l は丸石になる）。ゲートは幅 4×高さ 5 の枠（角なし 10 個）、火打ち金（鉄 1・火打石 1）で中の下の面に use。',
  '- ネザーで作り直す: 真紅・歪んだ幹（素手で可）→板（1 で 4）→作業台（持ち歩く）・棒。丸石 3→ハーフブロック 6。盾は板 6・鉄 1 で offhand に equip。金の防具は延べ棒 4（靴）〜5（兜）。',
].join('\n');

const NETHER = [
  '## ネザー・要塞・ブレイズ',
  '- ネザーの x・z はオーバーワールドの 1/8。帰りのゲートの座標を where に書く。y=31 より下は溶岩の海、マグマ（M）は燃える。',
  '- ピグリンは金の防具を 1 つ着るまで襲う（着るまでピグリンの群れ・砦の遺跡の 8m 内に長居しない）。金を掘る・箱を開けると怒る。',
  '- 要塞（N）は帯に並ぶ: ゲートから 1 方向へ 100〜300 進み、無ければ直角へ（find-structure・find-blocks nether_bricks・高い所から view top）。',
  '- 要塞やスポナー（S）の近くでは通路を歩かず、床より 1 段下の岩に 1 幅 2 高のトンネルを掘って進む（足と頭を dig→1 歩）。射線の中で立ち止まらない（wait・食べる・作るは見えない所で）。',
  '- ブレイズは準備（shortage が空）の後。準備の前に近くにいる・撃たれた時は戦わず、射線の外の岩へ離れて塞ぐ。',
  '- 戦い方: スポナーから 3〜5 マス・同じ高さか 1 段下に 2×1 の隠れ場、三方を囲い目の高さに下付きハーフブロックの隙間。hold は部屋へ開いた同じ高さのマスで（床・壁越しには届かない）。'
    + 'accept ["blaze"]、attack target=blaze hold seconds 20〜30、stopIf hpBelow 12。棒は敵がいない時に pickup。スポナーは壊さない。',
].join('\n');

const END = [
  '## パール・アイ・エンド',
  '- エンダーマン（歪んだ森に多い）: 目を合わせない（look で足元）、2 高の天井の下には来られない、accept ["enderman"]。ピグリンには金の延べ棒を drop target=ピグリン（真珠は 2〜4%）。',
  '- アイ（粉 1 + 真珠 1）を 12〜14 個。use item=ender_eye（at 無し）で方位 bearingDeg が返る。200m 以上離れた 2 地点で投げ、方位 θ（0 北・90 東、x は sinθ・z は −cosθ）の線の交点を where に。',
  '- ストロングホールド: 交点で階段を下り、ポータルの枠（Q）12 か所に use item=ender_eye at=枠 face=up。',
  '- エンド: 柱の上のクリスタルを shoot（囲いは pillarUp で登って打つ）。ドラゴンは止まり木（X）に降りた時に attack、飛ぶ時は shoot。'
    + '降りた時に頭の近くへベッドを place→use で爆発（4〜5 マス離れ、間にブロック）。縁では sneak、奈落に落ちない。',
].join('\n');

/** The pruned knowledge of the mode; without the probe (r3's mode) the `mc.probe` lines are not said. */
export function llmcCoreKnowledge(probe: boolean): string {
  const sections = [DECIDE, MAP, FALLS, DANGER, PLAN, MATERIALS, NETHER, END];
  const text = sections.join('\n\n');
  return probe ? text : withoutProbe(text);
}

/** r3's mode offers no `mc.probe`, no plan forbid or caution and no investigation: the lines that name them are left out. */
function withoutProbe(text: string): string {
  return text.split('\n').filter(line => !/mc\.probe|investigation|forbid|caution/u.test(line)).join('\n');
}
