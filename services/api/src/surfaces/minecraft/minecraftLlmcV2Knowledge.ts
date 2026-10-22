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
  '## 決め方',
  '- 毎判断、live の urgent・planNow・shortage・footing・around・route・lastResults と plan を読み、mc.act を 1 つ出す。結果を待たずに決められる手は全部入れる'
    + '（最大 12。掘る・歩く・橋など同じ手の続きは 10〜12 手）。急ぐ手（離れる・食べる・囲う）は先頭に。座標は live の完全な座標をそのまま使う。',
  '- why は節の札で始める（「[p1.2] 丸石でハーフブロック」。別の節なら「[p2.1] 理由: …」、急ぎは「[急ぎ] …」）。長い結果は次の判断の lastResults に一度だけ全文が出て、'
    + '履歴には 1 行しか残らない: 後で要る座標は plan の where か why に書く。',
  '- 止まったら、返った行（理由・そのマスの今の中身・周り）と around で原因を直す。同じ手を同じまま出さない。「一歩ではない」は段差 2 以上か着いていない、'
    + '「届かない」は 4.5m 内へ寄る、「掘れない」は道具か X、「見えない：間に (x,y,z)」はその間を先に掘る、「そのものには立てない」は続く「立てる隣」へ。素手の dig は tool:"hand"。',
  '- 分からない時・同じ止まりが 2 回・落ちた時は、手の前に mc.view か mc.probe（同じ止まり→history と path か sight、落ちた→column、敵→around）。'
    + '原因が分かったら plan.update の forbid か caution に書く。体を止めない: 焼く・待つ間も近くの手を入れる。満杯の前に余りを drop（丸石は 64 残す）。',
].join('\n');

const LIVE = [
  '## live の読み方（コードが作った事実。手は決めない）',
  '- body.around: 最初の 10 行は足の 8 方向の 1 歩・頭の上・足の下（歩きの決まりどおり: 掘らず置かず、上り 1・下り 3 まで、斜めは角のどちらかの列が空いている時だけ）。'
    + 'その後は水平 6 マスの足・頭・床を高さ別に「歩ける」（足と頭が空き床がある）「頭／足を掘れば歩ける」「床が無い（落差 n）」「溶岩・火」を `z=63 x=224..228` の'
    + '完全な座標で。書いていない所は足も頭も固い岩か、地図に無い（不明）。',
  '- body.route: 計画の今の節の ＠x,y,z への道。掘らずに行ける所までと、掘り k マスを許した時の最も近い立ち位置・道の点（walk の path に使える）・掘るマス。敵の目と体力は含まない。',
  '- 敵は 1 体 1 行。「見える（射線の中）」は撃たれる所、「見えない…道はある」は回って来る、「壁の向こうで届かない」は急ぎではない（planNow と shortage を先に）。'
    + '相対位置は今の足から。「今いる所は … から見える」と出たら、囲う・食べる前に見えない所へ。',
  '- landmarks と scan は今の次元の物（[overworld] 付きは別の次元）。state.inside は今いる構造物。次元が変わったら scan を見て計画を見直す。',
].join('\n');

const MAP = [
  '## 地図（予備）と置き方',
  '- 見出しの足=(x,y,z) が足のマス、頭は y+1。この 2 マスには place できない。層は全部同じ範囲、行の頭が z、列の見出しが x の下 1 桁、^ の列が足の x、? は範囲の外。'
    + 'rel: true では {x:1,y:0,z:0} が足の東隣、{x:0,y:-1,z:0} が足の下。',
  '- place は空気（. か *）で 6 面のどれかが固いマスへ。草花（,）・水・レール・周りが全部 . の宙には置けない。縦穴を上るのは pillarUp。40m 以上先は walk に地図の外の座標を渡してよい。',
  '- 記号: @ 自分の足 / ! 敵の足 / m 動物の足 / * 60秒以内に歩いた空気 / . 空気 / , 草花 / X 岩盤 / # 石の類 / : 土 / s 砂 / I 氷 / w 水源 / - 流れる水 / L 溶岩源 / l 流れる溶岩 / f 火 / x クモの巣'
    + ' / i 鉄 c 石炭 d ダイヤ g 金 r レッドストーン o 他の鉱石 / W 原木 % 葉 P 板 D 扉 + 柵・ガラス h はしご t 松明 = レール / F かまど T 作業台 C チェスト B ベッド H 干し草 k 作物 S スポナー'
    + ' / O 黒曜石 p ポータル n ネザーラック u ソウルサンド N ネザーレンガ M マグマ G グロウストーン E エンドストーン Q R 枠 e エンドポータル $ 他の固い物。'
    + 'surface 形は「記号＋高さ」（0〜9 上、+ 10以上上、a〜i 下、v 10以上下）。縦: 足の列を同じ記号の続きで（「上: y=46〜51 .×6 / y=52 #」）。',
].join('\n');

const FALLS = [
  '## 落ちる・水・溶岩・空所',
  '- 下りは階段（足の前の 2 マスを掘って 1 歩）。素手で真下へ掘らない。水の中や真上では下へ掘らない。溶岩（L・l）の隣は掘らない・歩かない。',
  '- 「落差 n」は踏み出すと n 段落ちる意味。降りてよいのは n≤3、4 以上は階段か着地点に水。',
  '- 空所（溶岩の海・深い穴・崖）は、縁より 1 段下の岩のトンネルか、1 マスごとに足元と両脇に置いた壁付きの橋で渡る。壁の無い幅 1 の橋は使わない。'
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
  '- 追ってくる近接の敵（ピグリン・ゾンビ・ウィザースケルトン）からは歩いて逃げ切れない。鉄以上の剣があり体力 6 超なら打ち返す（equip→accept→attack target=#id untilDead）。'
    + '無ければ間に 2 マス place か pillarUp 2。',
].join('\n');

const PLAN = [
  '## 計画',
  '- 計画は自分のもの（順を変える・足す・割る・blocked と reason）。済んだ・止まった・変えた時だけ plan.update。順を守る（ブレイズの棒 7 本の後にエンダーパール）。飛ばす時は reason に。',
  '- doneWhen が観測の形（have:物>=数・dim:次元・at:x,y,z~半径@次元・food>=点、& と |）なら頭が済みにする。消費して無くなる物（板・棒・原木）の子は作った時に自分で set state=done。'
    + 'shortage が出ている間は、戦い・奥への移動の前に埋める。',
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
    '- 木が無い時: 地表の木（find-blocks・view top）→村の木の物（扉・柵・ベッド・作業台・板、takeOk）→難破船→廃坑（階段で下りる）。',
    '- 村は鉄より前に 128m 内を回る（takeOk: true。鉄ゴーレムと村人は打たない）: ベッドを全部（エンドの爆発に 4〜6）、干し草（1 個でパン 3）、育った畑、箱は chest op=look→take。',
    '- 鉄は y=16 前後（i）、ダイヤは y=-58 前後（d、鉄のツルハシ）。水バケツは水源（w）の隣から use（流れ - からは汲めない）。',
    '- 黒曜石: 溶岩源（L）に水を注いでできた O を dig（ダイヤのツルハシ）、水を汲み戻して繰り返す（流れる溶岩 l は丸石になる）。ゲートは幅 4×高さ 5 の枠（角なし 10 個）、'
      + '火打ち金（鉄 1・火打石 1）で中の下の面に use。',
    '- ネザーで作り直す: 真紅・歪んだ幹（素手で可）→板（1 で 4）→作業台（持ち歩く）・棒。丸石 3→ハーフブロック 6。盾は板 6・鉄 1 で offhand に equip。'
      + '金の防具は延べ棒 4（靴）〜5（兜）。',
  ].join('\n'),
  nether: [
    '## ネザーと要塞',
    '- ネザーの x・z はオーバーワールドの 1/8。帰りのゲートの座標を where に書く。y=31 より下は溶岩の海、マグマ（M）は燃える。',
    '- ピグリンは金の防具を 1 つ着るまで襲う（着るまでピグリンの群れ・砦の遺跡の 8m 内に長居しない）。金を掘る・箱を開けると怒る。',
    '- 要塞（N）は帯に並ぶ: ゲートから 1 方向へ 100〜300 進み、無ければ直角へ（find-structure・find-blocks nether_bricks・高い所から view top）。',
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
    '- エンダーマン（歪んだ森に多い）: 目を合わせない（look で足元）、2 高の天井の下には来られない、accept ["enderman"]。ピグリンには金の延べ棒を drop target=ピグリン（真珠は 2〜4%）。',
    '- アイ（粉 1 + 真珠 1）を 12〜14 個。use item=ender_eye（at 無し）で方位 bearingDeg が返る。200m 以上離れた 2 地点で投げ、方位 θ（0 北・90 東、x は sinθ・z は −cosθ）の線の交点を where に。',
    '- ストロングホールド: 交点で階段を下り、ポータルの枠（Q）12 か所に use item=ender_eye at=枠 face=up。',
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
    near: `${text(body.threats)} ${text(body.urgent)} ${text(body.landmarks)} ${text(body.scan)}` };
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
