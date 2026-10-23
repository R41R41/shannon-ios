import { MAP_LEGEND_V2 } from '../../contracts/minecraftMapLegendV2.js';
/**
 * SHANNON_MINECRAFT_LLMC_V2 (改修案 2.1): the mode's instructions and knowledge, cut once more from `minecraftKnowledgeCore.ts` (own prompt):
 * - `V2_ALWAYS`: what every decision needs (how to decide, how to read the live state, the map, falls, enemies, the plan). With the header,
 *   the decision protocol and the reading (`anthropicFcaMinecraftSystem.ts`) it is the cached system text, aimed at three thousand tokens.
 * - `V2_STAGES`: the knowledge of a stage of the route (materials, the Nether, the blazes, the pearls and eyes, the End), which the code picks
 *   from the plan's current node, the dimension and what has happened (`stagesFor`) and puts after the cache's last mark, before the live state
 *   (`stageKnowledge`). The own-prompt text had all of them in the cached text (1.8k tokens) for every decision.
 * What each rule of `minecraftKnowledgeCore.ts` became is in `docs/minecraft-llmc-v2-2026-10.md`. A line is for what no code says or keeps:
 * the walk's rules are `around` and `route`, the stops of the map are the act preflight's. Change these words only between supervised runs.
 */
const DECIDE = [
  '## 決め方（判断の原則。手の書き方は mc.act の説明）',
  '- 毎判断、live の urgent・planNow・shortage・footing・around・route・threats・lastResults と plan を読み、mc.act を 1 つ出す。',
  '- 結果を待たずに決められる手は 1 つの act にまとめる（最大 12。掘る・歩く・橋など同じ手の続きは 10〜12 手）。1 判断に数秒かかり、小分けにすると進みが遅い。',
  '- 急ぐ手（離れる・食べる・囲う）は先頭に。座標は live の完全な座標をそのまま使う（略すと読み違える）。',
  '- why は節の札で始める（「[p1.2] 丸石でハーフブロック」。別の節なら「[p2.1] 理由: …」、急ぎは「[急ぎ] …」）。どの節の手かが履歴で分かる。',
  '- 長い結果の続きは次の判断の lastResults に一度だけ出て、履歴には 1 行しか残らない: 後で要る座標は plan の where か why に書く。',
  '- 止まったら、返った行（理由・そのマスの今の中身）と lastResults の周り・around で原因を直す。同じ手を同じまま出さない（同じ止まりが続く）。'
    + '置けなかった橋・床が無い道を onFail continue で出し直すのも同じ: 支えのある（隣が固い）マスから順に置き、壁付きの橋かトンネルにする。',
  '- 分からない時・同じ止まりが 2 回・落ちた時・live に look が出た時は、手の前に mc.view か mc.probe（同じ止まり→history と path か sight、落ちた→column、敵→around）。'
    + '手を重ねる前に事実を確かめる。原因が分かったら plan.update の forbid か caution に書く。',
  '- 体を止めない: かまどに入れたら焼ける間（live の jobs の残り秒）は立って待たず、掘る・集める・作る手を入れる。満杯の前に余りを drop（丸石は 64 残す）。',
  '- 「見られる」で止まったマスを、exposeOk を付けて掘り直さない。見られない別のマス（敵と反対側・下の岩）を掘る。敵のいる側へ近づく向きに掘らない・歩かない。',
  '- attack が「届かない」で 2 回止まった的は追わない（エンダーマン・ブレイズ・遠いピグリンを追って歩き回らない）。hold で来るのを待つか離れる。'
    + '食料・盾・金の防具が無いまま遠出して敵を追わない（戦えずに倒れやすい）。',
  '- 自分で書いた注意（plan.rules・forbid・caution）に反して節を飛ばさない。次元が変わったら scan と landmarks を見て計画を見直す。',
].join('\n');

/** The dictionary of the live state (D3): every field the model may see, one line each: what it is, its units, what its absence means. */
const LIVE = [
  '## live の項目辞典（コードが作った事実で、手は決めない。出ていない項目は、その事実が今は無いという意味）',
  '- plan: revision（版）・done（済んだ節/全体）・next（今の節の次から最大 3 節。「p2.4 題＠座標（済む条件: …）」）・blocked（止めた節と理由。最大 3）・'
    + 'rules（今の節と親の禁止・注意。最大 8）。今の節と道は planNow と同じなので plan には出ない。',
  '- 済む条件: 節の doneWhen。観測でこれが満たされると、コードがその節を済みにする。今済んでいるという印ではない。',
  '- urgent: 急ぎの理由（敵が近い・体力が低く敵がいる・前の act が反射か stopIf で止まった）。出ている時の live は短い版で、answer の指示に従う。',
  '- answer: 急ぎの時の答え方（考えは 2〜3 文・手は 3 つまで）。',
  '- investigation: 驚き（急な落下など）の後に、頭が act の前に調べた probe の答え。',
  '- planNow: 計画の今の節。「[p6.4] 題＠座標（済む条件: …）（道: 親›子）」。',
  '- shortage: 今の段階に足りない準備（作業台・ハーフ・金の防具・食料）。出ていない = 足りている。',
  '- recovery: 体力が自然に戻らない事実と食料の当て。出ていない = 戻る。',
  '- footing: 足元の空所の数と「押されたら落ちる」。出ていない = 痛い空所は無い。',
  '- around: 足の周りの歩ける所。最初の 10 行は足の 8 方向の 1 歩・頭の上・足の下（掘らず置かず、上り 1・下り 3 まで、斜めは角のどちらかの列が空いている時だけ）。'
    + 'その後は水平 6 マスの足・頭・床を高さ別に、歩ける / 頭か足を掘れば歩ける / 床が無い（落差 n）/ 溶岩・火 / 不明（未ロード）を、`z=63 x=224..228` の完全な座標で。',
  '  書いていない所は 2 通り: 足も頭も固い岩（掘って通る所）と、足・頭・床のどれかが地図に無い所（地図の端。不明）。未ロードのマスは「不明」の行に書く。',
  '- route: 今の節の＠座標への道（掘らずに行ける最も近い立ち位置・道の点・掘り k マスを許した時の所）。敵の目と体力は含まない。出ていない = 今の節に座標が無い。',
  '- liquid: 水・溶岩・黒曜石（地図から）。源の数、近い順に目から何 m・届くか（5m まで）・間のブロック。出ていない = 地図に無い。',
  '- obsidian: 黒曜石の節の時だけ。近い溶岩の源と既存の黒曜石までの距離。',
  '- pack: 持ち物の空きマスと、拾い続けた石や土が占める所（満杯だと dig・pickup が止まる）。',
  '- repeat: 同じ的・同じ止まりが 2 回以上あった事実（コードが数えた）。',
  '- look: 同じ止まりが続く・落ちた・溺れかけた・大きく打たれた時の「調べる」促し。',
  '- map: 層ごとの地図（予備。around と route はここから作られる）。記号は下の凡例。',
  '- landmarks: 目印。今の次元の物（[overworld] 付きは別の次元）。東西南北・上下は今の足から（上35 は 35 ブロック上）。',
  '- scan: 体の走査（ログイン・リスポーン・次元変化の後に 1 回）。',
  '- stops: 最近の止まり（マス・理由・何秒前）。',
  '- state: at 位置・dimension・inside（今いる構造物。出ていない = 構造物の中ではない）・biome・time（時刻の言葉）・weather・heldItem・worn（防具の耐久 残り/最大）・'
    + 'health（0〜20。ハート 1 個 = 2）・food（満腹 0〜20）・saturation（隠れた満腹の余り）・oxygen（息 n/20）・minutes（課題の経過分）。',
  '- food: points（食料の合計点）・items（品目×数（点））・lostIn5min（5 分で減った点。null = まだ測れていない）。',
  '- inventory: 持ち物（品目×数。耐久つきは別の行）。「ほか N 件は略」は省いた分。',
  '- threats: 敵。1 体 1 行（#id 名前 距離 (座標) 今の足からの東西南北上下・見え方）。行になるのは、24m 内、クリーパーは 32m 内、飛び道具の種類（スケルトン・ブレイズ・ガスト'
    + 'など）は 48m 内、急ぎで名指しされた敵、見える敵。見え方: 見える（射線の中）= 撃たれる所 / 見えない・道はある = 回って来る / 壁の向こうで届かない = 急ぎではない / '
    + '飛び道具 = 遠くから撃つ種類。それより遠い敵は最後の「ほか N 体（種類ごとの数。いちばん近い: …）」の 1 行。'
    + '見え方が書いていない = 体がまだ測っていない（24m まで測る。壁の向こうだけ 32m まで。遠い敵は書かれない）。',
  '- near: 近くの敵でない生き物と落ちている物。落ちている物は 16m 内を「#id item 名前×数」で（自分が投げたと分かっている物（屑・予備のつるはし）は出ない）。'
    + '村人は 12m 内（計画に交易・村がある時は 24m）。食べられる動物は 24m 内で、計画に食料がある・満腹 14 以下・食料の点が 40 未満・shortage に食料がある・recovery が出ている時だけ。'
    + '羊はそれに加えて、計画か shortage にベッド・羊毛がある時。',
  '- jobs: かまどなど外の仕事と残り秒の見積。出ていない = 仕事は無い。',
  '- events: 前の判断の後の出来事（着いた・死んだ・次元が変わった・反射が止めた）。',
  '- lastResults: 前の判断の結果のうち、履歴の行にまだ無い部分を 1 回だけ（止まった手の周りの 3×3×3、view の地図、probe の答えの続き）。履歴の行と同じ行は繰り返さない。',
  '- 急ぎの時の live は、urgent・investigation・planNow・footing・around・liquid・map・state・threats・inventory・events・lastResults・answer だけ。',
].join('\n');

const MAP = [
  '## 地図（予備）',
  '- 見出しの足=(x,y,z) が足のマス、頭は y+1。層は全部同じ範囲で、行の頭が z、列の見出しが x の下 1 桁、^ の列が足の x。? は未ロード（不明）。',
  // The body's legend, word for word (mb-llmc-cand 2): its symbol lines and the surface form's. The layers' ranges are the v2 map's own (above).
  ...MAP_LEGEND_V2.split('\n').slice(0, 10),
  '縦: 足の列の上下を同じ記号の続きで（「上: y=46〜51 .×6 / y=52 #」は頭から空気が 6 段、その上が石）。',
].join('\n');

const FALLS = [
  '## 落ちる・水・溶岩・空所',
  '- 下りは階段（足の前の 2 マスを掘って 1 歩）。素手で真下へ掘らない。水の中や真上では下へ掘らない。溶岩（L・l）の隣は掘らない・歩かない（落ちる・燃える）。',
  '- 「落差 n」は踏み出すと n 段落ちる意味。降りてよいのは n≤3、4 以上は階段か着地点に水。',
  '- 空所（溶岩の海・深い穴・崖）は、縁より 1 段下の岩のトンネルか、1 マスごとに足元と両脇に置いた壁付きの橋で渡る。壁の無い幅 1 の橋は使わない（押されると落ちる）。'
    + 'footing に「押されたら落ちる」がある間は、立ち止まらない・跳ばない・縁で積まない。',
].join('\n');

const DANGER = [
  '## 敵と体力',
  '- 体の反射（溶岩・溺れ・落下・燃え・クリーパー・飛び道具・体力 8 以下の逃走・瀕死の食事・打ち返し）は体がして、act を止めて何をしたかを返す。'
    + 'その先（食事・睡眠・囲う・戦うか逃げるか）はあなたが出す。',
  '- 危ない act には stopIf: 夜・洞窟・ネザーは hostileWithin 8〜12（クリーパーは 10）、射線の中を通る act は hpBelow 12 前後（今の体力より低く）、待ち打ちは hostileWithin。'
    + '戦うと決めた敵だけ accept に入れる。',
  '- 体力 8 以下では戦わない: sprint で離れる→囲う（足の周り 4 面と頭の上）→食べる→満腹 18 以上で wait（自然回復は満腹 18 以上のみ）。夜や敵 2 体以上は先に囲うか避ける。'
    + 'ベッドで寝る（ネザー・エンドでは爆発する）。',
  '- 「今いる所は … から見える」と出たら、囲う・食べる前に見えない所へ。壁の向こうの敵は急ぎではない（planNow と shortage を先に）。',
  '- 追ってくる近接の敵（ピグリン・ゾンビ・ウィザースケルトン）からは歩いて逃げ切れない。鉄以上の剣があり体力 6 超なら打ち返す（equip→accept→attack target=#id untilDead）。'
    + '無ければ間に 2 マス place か pillarUp 2。',
].join('\n');

const PLAN = [
  '## 計画',
  '- 計画は自分のもの（順を変える・足す・割る・blocked と reason）。済んだ・止まった・変えた時だけ plan.update。順を守る（ブレイズの棒 7 本の後にエンダーパール）。飛ばす時は reason に。',
  '- doneWhen が観測の形（have:物>=数・dim:次元・at:x,y,z~半径@次元・food>=点、& と |）なら、条件が満たされた時に頭が済みにする。'
    + '消費して無くなる物（板・棒・原木）の子は、作った時に自分で set state=done。shortage が出ている間は、戦い・奥への移動の前に埋める。',
].join('\n');

/** The text every decision reads (the knowledge part of the cached system text). */
export const V2_ALWAYS = [DECIDE, LIVE, MAP, FALLS, DANGER, PLAN].join('\n\n');

export type StageId = 'prep' | 'nether' | 'blaze' | 'pearl' | 'end';
export const STAGE_IDS: readonly StageId[] = ['prep', 'nether', 'blaze', 'pearl', 'end'];
/** The knowledge of each stage, cut from the own prompt's 材料と手順 / ネザー・要塞・ブレイズ / パール・アイ・エンド. */
export const V2_STAGES: Readonly<Record<StageId, string>> = Object.freeze({
  prep: [
    '## 材料と手順',
    '- 食料（live の food.points）: 最初の夜（鉄）の前に 40〜60 点、ネザーの奥へ 100、エンドへ 80 以上。かまどの燃料は石炭 1 で 8 個・木材 1 で 1.5 個、鉄と一緒に肉も焼く。',
    '- 木が無い時: 地表の木（mc.probe kind=scan で原木の方角・mc.view mode=top で上から）→村の木の物（扉・柵・ベッド・作業台・板、takeOk）→難破船→廃坑（階段で下りる）。',
    '- 村は鉄より前に 128m 内を回る（takeOk: true。鉄ゴーレムと村人は打たない）: ベッドは 1〜2 つで足りる（エンドの前に羊毛 3＋板 3 で 4〜6 に増やす。余分に取りに行かない）、干し草（1 個でパン 3）、育った畑、箱は chest op=look→take。',
    '- 鉄は y=16 前後（i）。ネザーの前に要る鉄は約 10（ツルハシ 3・バケツ 3・盾 1・火打ち金 1。防具は箱で見つけた物か余裕がある時だけ）。ダイヤは y=-58 前後（d、鉄のツルハシ）。水バケツは水源（w）の隣から use（流れ - からは汲めない）。',
    '- 黒曜石: 溶岩源（L）に水を注いでできた O を dig（ダイヤのツルハシ）、水を汲み戻して繰り返す（流れる溶岩 l は丸石になる）。水は通路の外、溶岩の上か横の囲まれたマスに置く'
      + '（自分の足元へ流れる所に置かない）。バケツの溶岩を枠に流し込んで作ってもよい。溶岩が 20m 内にあれば、既存の黒曜石へ行くより水で固めて作る方が早い（live の body.obsidian に両方の距離）。ゲートは幅 4×高さ 5 の枠（角なし 10 個）、'
      + '火打ち金（鉄 1・火打石 1）で中の下の面に use。',
    '- ポータル（p ネザー・e エンド）の入り方: そのマスの中へ walk（range=0。足と頭がポータルのマスで、下は枠の黒曜石）して、約 4 秒立って待つ。着いた先が次元の変化。'
      + 'ポータルのマスには place できず、その上面は床ではない。',
    '- ネザーで作り直す: 真紅・歪んだ幹（素手で可）→板（1 で 4）→作業台（持ち歩く）・棒。丸石 3→ハーフブロック 6。盾は板 6・鉄 1 で offhand に equip。'
      + '金の防具は延べ棒 4（靴）〜5（兜）。',
  ].join('\n'),
  nether: [
    '## ネザーと要塞',
    '- ネザーの x・z はオーバーワールドの 1/8。帰りのゲートの座標を where に書く（帰りも p のマスの中へ walk して約 4 秒待つ）。y=31 より下は溶岩の海、マグマ（M）は燃える。',
    '- ピグリンは金の防具を 1 つ着るまで襲う（着るまでピグリンの群れ・砦の遺跡の 8m 内に長居しない）。金を掘る・箱を開けると怒る。',
    '- 要塞（N）は帯に並ぶ: ゲートから 1 方向へ 100〜300 進み、無ければ直角へ（mc.probe kind=scan radius=32 で要塞・ネザーレンガの方角、高い所から mc.view mode=top）。',
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
    '- エンダーマン（歪んだ森に多い）: 目を合わせない（look で足元）、2 高の天井の下には来られない、accept ["enderman"]。追って歩き回らない（来るのを待つ）。ピグリンには金の延べ棒を drop target=ピグリン（真珠は 2〜4%）。',
    '- アイ（粉 1 + 真珠 1）を 12〜14 個。use item=ender_eye（at 無し）で方位 bearingDeg が返る。200m 以上離れた 2 地点で投げ、方位 θ（0 北・90 東、x は sinθ・z は −cosθ）の線の交点を where に。',
    '- ストロングホールド: 交点で階段を下り、ポータルの枠（Q）12 か所に use item=ender_eye at=枠 face=up。全部 R になったら中の e のマスへ walk（range=0）で入る。',
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
 * The stages the decision needs, from the live state alone: the plan's current node and the next one, the dimension, the structure she is in,
 * what she carries, and what is near (a blaze, a spawner, a fortress). Always at least one: the dimension's.
 */
export function stagesFor(live: Rec): StageId[] {
  const body = rec(live.body) ?? {}, state = rec(body.state) ?? {};
  const dimension = String(state.dimension ?? '');
  const where = { node: `${text(body.planNow)} ${text(rec(live.plan)?.next)}`, inside: String(state.inside ?? ''), inventory: text(body.inventory),
    near: `${text(body.landmarks)} ${text(body.scan)}` };
  const found = STAGE_IDS.filter(id => STAGE_WHEN[id](dimension, where));
  return found.length ? found : [dimension === 'the_nether' ? 'nether' : 'prep'];
}
interface Where { node: string; inside: string; inventory: string; near: string }
/** When each stage is needed: the dimension, the plan's node, the structure she is in, what she carries and what is near. */
const STAGE_WHEN: Readonly<Record<StageId, (dimension: string, where: Where) => boolean>> = {
  prep: (dimension, where) => dimension === 'overworld' || /作業台|ハーフブロック|盾|食料|鉄|ダイヤ|黒曜石|ゲート|ベッド|村|原木|木|かまど|ツルハシ|金/u.test(where.node),
  nether: (dimension, where) => dimension === 'the_nether' || /ネザー|要塞|ポータル|ピグリン|砦/u.test(where.node) || /要塞|砦/u.test(where.inside),
  blaze: (_dimension, where) => /ブレイズ|ロッド|スポナー/u.test(where.node) || /blaze|スポナー/u.test(where.near),
  pearl: (_dimension, where) => /パール|アイ|エンダー|ストロング/u.test(where.node) || /ender_(pearl|eye)/u.test(where.inventory) || /enderman/u.test(where.near),
  end: (dimension, where) => dimension === 'the_end' || /ドラゴン|エンドへ|エンドの/u.test(where.node),
};

/** The message before the live state: the stages' knowledge, headed by which stages (null when there is no live body to pick from). */
export function stageKnowledge(live: Rec): string | null {
  if (!rec(live.body)) return null;
  const ids = stagesFor(live);
  return `（この場面の知識: ${ids.join('・')}）\n${ids.map(id => V2_STAGES[id]).join('\n\n')}`;
}
