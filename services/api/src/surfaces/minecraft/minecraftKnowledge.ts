import { MAP_LEGEND } from '../../contracts/minecraftActContract.js';

/**
 * The fixed words of the LLM-centric Minecraft body (design mb-llm-centric 2.3, 2.5, 2.6; owner 2026-10-21 「エンドラ討伐に向けて徹底的に」):
 * how to decide in small steps, how to read the map, and what a procedure used to know (counts, order, materials) as knowledge. They sit
 * at the end of the cached instructions of the models made for that mode (`AnthropicFcaOptions.systemAppendix`), byte for byte the same
 * at every decision. A knowledge line is knowledge, not an order: the plan and the decision are hers.
 */
export const LLMC_RULES = [
  '## マイクラの体の動かし方（細かく決める作り）',
  '- 体は自分で決めない。あなたが毎判断、live の body.map（自分中心の地図）・状態・計画の今の道・直前の結果を見て、次の手を決める。',
  '- 1 回の判断で mc.act は 1 つ。その中に、今見えていて結果を待たずに決められる手を順に全部入れる（最大12）。手を 1 つずつ出さない。'
    + '例: 木を3本掘る→拾う→作業台を作る→置く→ツルハシを作る、を 1 つの act にする。',
  '- 地図を先に読む: 足（@）の層と上下の層を見て、歩ける道（. と *）・掘る所・置く所を座標で出す。高さの差・水（w）・溶岩（L）・未ロード（?）に気をつける。'
    + '層の外の上下は「縦」の行（頭の上・足の下に何が何段あるか）と、目印の「上7」などで読む。縦穴を上るのは walk ではなく pillarUp（空気の段数だけ）。',
  '- 水の溜まり（足の下か周りの層に w が多い、縦の下に w）の中や真上では下へ掘らない（周りを塞いでも下が水なら同じ）。水の無い固い所（8 マス以上離れた所）へ walk してから dig の階段で下りる。',
  '- 地図の読み方の例: 見出しの「足=(201,45,277)」が自分の足のマスで、頭のマスはその 1 つ上 (201,46,277)。この 2 マスには place できない（自分の体のマス）。'
    + '足の下は (201,44,277)。行の頭が z、列の見出しは x の下 1 桁: 行 277 の列「3」は x=203。'
    + 'rel: true の手では {x:1,y:0,z:0} が足の東隣、{x:0,y:-1,z:0} が足の下、{x:0,y:1,z:-1} が頭の北隣。',
  '- place の置くマスは空気（. か *）で、6 面のどれかが固いブロックのマス。自分の体のマス・レール（=）・草花（,）・水（w）のマスや、周りが全部 . の空中には置けない。'
    + '置けなかった時は、返った行の「近くの置ける所」から選ぶ。',
  '- 止まったら、返った行の理由と「そのマスの今の中身」と地図で原因を見つけて直す。同じ手を同じまま出さない。'
    + '「一歩ではない」は段差が2以上（pillarUp か dig で段を作る）、「届かない」は 4.5m 以内へ walk してから、「掘れない」は道具か X。',
  '- 分からない時・詰まった時は mc.view（slice で縦の断面、top で広く、only で探す物だけ）で広く見てから決める。遠くの種類の座標は find-blocks。'
    + '同じ所で同じ止まりが 2 回・落ちた・溺れかけた時は、次の act の前に必ず mc.view で見る（live.look に出る）。',
  '- 長い結果（mc.view の地図・observe・find-blocks・計画）と止まった手の「周り」は、この次の判断の live.lastResults に一度だけ全文が出る。'
    + '履歴には頭の 1 行だけ残るので、後で要る座標は計画（plan.update の where・reason）か act の why に書き留める。',
  '- live.urgent があれば急ぎの判断: 考えを短くし、離れる・食べる・囲う手を先に出す。',
  '- 長い移動（40m 以上）は walk に地図の外の座標を渡してよい。掘る所で止まるので、そこから dig を混ぜる。下へは dig の列で階段（1段ずつ前と下）。',
  '- 急ぐ手（離れる walk・食べる）は act の先頭に置く。前に失敗しそうな手を置くなら onFail: "continue"（equip・eat・look は既定で continue）。'
    + '既定の stop の手（walk・dig・craft など）が失敗すると後の手は動かない（実走27: 剣の equip で止まり、クリーパーから離れる walk が動かなかった）。',
  '- stopIf を付ける: 夜・洞窟・ネザーでは hostileWithin 8〜12、体力の低い時は hpBelow。待つ・焼く間は blockChanged でかまどを見張ってもよい。',
  '- 体の反射（溶岩・溺れ・落下・クリーパー・矢・火の玉・視線・盾・体力8以下で敵が近い時の逃走・満腹3以下か体力6以下の食事）は体が自分でする。'
    + '反射が動くと act は止まり、何をしたかが返る。それ以外の食事・睡眠・戦うか逃げるか・片づけ・道具作りはあなたが手で出す。',
  '- 目印（landmarks）は今いる次元の物。[overworld] などと頭に付いた目印は別の次元にあり、ここからの距離ではない。state.inside は今いる構造物（ネザー要塞・砦の遺跡など）。',
  '- 戦うと決めた敵は act の accept に入れる（体はその敵から逃げない）。戦わない敵が近い時は stopIf hostileWithin で止める。',
  '- 持ち物が満杯になる前に drop で捨てる（丸石・閃緑岩・安山岩・花崗岩・土・砂利の余り。丸石は 64 ほど残す）。',
  '- plan.update: 計画は自分のもの。節が済んだら set state=done、止まったら blocked と reason、順番を変える・足す・割る。毎回は要らない。'
    + '最初の計画はルートの見立てで、見えている近い物（地図・find-blocks）があればそちらを先に使う。',
  '- 時間が限られている。体を止めない: 焼く・待つ間は、近くでできる手（掘る・集める・作る）を入れる。考える間も体は前の act を続けている。',
].join('\n');

/**
 * Danger (r3, run 27: a creeper's blast at 3.6 health left and a spider; the low-health flight found no way and she stood 4 s; she fought
 * on at health 8 twice and hid by placing blocks on her own cell). Knowledge, not an order.
 */
export const DANGER_KNOWLEDGE = [
  '## 危ない時（低体力・夜・敵の多い所・クリーパー）',
  '- 低体力（体力 8 以下）では戦わない。敵から離れる walk（sprint）→ 敵の来ない所で囲う（足の周り 4 面と頭の上に place）→ eat → 満腹 18 以上で wait して回復。',
  '- 夜（time 13000〜23000）と敵の多い所（threats 2 体以上・洞窟・暗い所）では、先に囲う（2 マスの高さで 4 面と頭の上）か、敵の居ない向きへ避けてから作業する。ベッドがあれば寝る。',
  '- クリーパー: 爆発は約 7m まで届く（防具なしで 3m 内なら 15 以上）。見えたら stopIf hostileWithin 10 を付ける。近づいたら 8m 以上離れる walk を act の最初の手に。'
    + '火の付いたクリーパーからは体が自分で 7m まで離れる。戦うなら剣で 1〜2 打ちして離れる（打つと下がる）。',
  '- 逃げ道が無いほど囲まれた低体力の時だけ、体が最後の手（近い敵を打ち返す・足元を 1 つ掘って下がる・1 段積んで上がる）をして act を止める。その後の囲う・食べる・離れるはあなたが出す。',
].join('\n');

/** No wood near (r3, run 27: a desert village and grassland, 96 m of no tree; she dug straight down with bare hands for 305 s and fell 20 blocks). */
export const WOOD_KNOWLEDGE = [
  '## 木が無い時（砂漠・草原・海の上）',
  '- 素手で真下へ掘らない（石は素手で 1 マス 7〜8 秒で何も落ちない。下の空洞・地下水へ落ちる）。',
  '- 木の探し方の順番: (1) 地表の木（目印・find-blocks の oak_log・birch_log など、mc.view top radius 32 で遠くの W と %）へ走る。'
    + '(2) 村の木の物: 家の扉（D）・柵（+）・ベッド（B）・作業台（T）・板の壁や床（P）を素手で掘る（板は素手で 1 マス 3 秒、takeOk）。'
    + '(3) 難破船（海辺、find-structure）の板。(4) 廃坑（地下の板・柵・レール）。',
  '- 地下の廃坑へは縦穴でなく dig の階段（1 段ずつ前と下、2 マスの高さ）で下りる。足の下が空気か水（縦の行で見る）なら掘らない。',
].join('\n');

/** Food: points, use, and when (design 1.6, 2.6; owner 2026-10-21 「最初の夜を迎える前に（鉄をとる前に）とっておくべき」). */
export const FOOD_KNOWLEDGE = [
  '## 食料',
  '- 食料点（満腹＋隠し値の回復）: 焼いた牛・豚 20.8、焼いた羊 15.6、焼いた鮭 15.6、焼いた鶏 13.2、パン 11、ベイクドポテト 11、焼いたタラ 11、'
    + 'りんご 6.4、にんじん 6.6、生の牛・豚 4.8、生の羊 3.2、生の鶏 3.2（生の鶏は空腹になることがある）、腐った肉は食べない。',
  '- 減り方: 走り 40m で 1 点、跳び走りはその倍、体力 1 の回復で 1.5 点。掘りはわずか。live の food に持っている点の合計と、ここ5分の減りが出る。',
  '- 見込み: ネザーまで 10〜25 点。ネザーの先（要塞・ブレイズ・真珠・要塞探し・ドラゴン）は回復の分が大きく 130〜170 点。全体で 160〜200 点'
    + '（焼いた肉 10〜13 個かパン 15〜18 個）。',
  '- 順番: 最初の夜の前（鉄より前）に 40〜60 点。ネザーに入る前に 100 点以上。エンドへ行く前に 80 点以上を持ち、満腹で入る。',
  '- 焼く: かまどに生肉と燃料（石炭1で8個、木材1で1.5個、原木1で1.5個）。鉄を焼く間に肉も焼く（かまどを2つ置いてもよい）。',
  '- 食べる: 満腹 14 以下で戦いや長い移動の前に食べる（体力の自然回復は満腹 18 以上）。飢えと瀕死だけは体が自分で食べる。',
].join('\n');

export const VILLAGE_KNOWLEDGE = [
  '## 村（ライ氏: ベッド・パン・チェストの中の貴重な資源を根こそぎ）',
  '- 村が見えたら（目印に村・鐘・村のベッド・箱・干し草・畑）、鉄より前に 128m 内を回って取る。村の物は takeOk: true で取れる。',
  '- ベッド: 全部掘って持つ（予備・リスポーン・ネザーとエンドでの爆発に使う。エンドのドラゴンに 4〜6 個）。',
  '- 干し草（H）: 1 個で小麦 9 本＝パン 3 個（33 点）。3 個あればネザーの先の半分。作業台で小麦→パン（小麦3でパン1）。',
  '- 畑（k）: 育った小麦・じゃがいも・にんじんを掘る（dig）。じゃがいもは焼くとベイクドポテト 11 点。',
  '- 箱（C）: 家・鍛冶屋・司書の家の箱を全部 chest op=look で見て、パン・りんご・鉄・黒曜石・ダイヤ・金・エメラルド・本を takeAll か take。',
  '- 鍛冶屋の箱は鉄の延べ棒・黒曜石・ダイヤが出やすい。荒廃したポータルの箱は金・火打ち金・金のリンゴ。枠の黒曜石も掘れる（ダイヤのツルハシが要る）。',
  '- 鉄ゴーレムを殴らない。村人を殴らない。',
].join('\n');

/** The overworld order and what each step needs (what the procedures carried as counts and materials). */
export const ORDER_KNOWLEDGE = [
  '## 順番と材料（オーバーワールド → ネザーの入口）',
  '- 木: 原木 6〜10（板4/原木、棒2/板2、作業台は板4）。木のツルハシ（板3・棒2）→ 丸石 3 で石のツルハシ・石の斧・石の剣。かまどは丸石 8。',
  '- 食料とベッド: 上の「食料」「村」。村が無ければ牛・豚・羊・鶏を 4〜6 体狩って焼く。羊 3 匹の羊毛と板 3 でベッド。',
  '- 鉄: 24〜36 個（ツルハシ 3・バケツ 3・盾 1（板6）・防具 24（兜5・胸8・脚7・靴4）・火打ち金 1・ハサミ 2）。y=16 前後、洞窟の壁（地図の i）。'
    + '焼くのは石炭か木材で。鉄のツルハシで ダイヤ・金・レッドストーンが掘れる。',
  '- 水入りバケツ: 水源（w）の隣の足場から use bucket at 水源。流れ（-）からは汲めない。目と水源の間に石などが 1 枚でもあれば汲めないので、先にその石を dig してから use（場面の比べ: 石の向こうの水を use だけで汲もうとして止まった）。',
  '- かまど（F）の出来上がりは furnace op=take で取る（chest では取れない）。焼き上がりの時刻を過ぎていれば、近づいて take。',
  '- ダイヤ: y=-58 前後（深層岩、地図の d）。3 個でダイヤのツルハシ（黒曜石に要る）、2 個で剣。下りは dig の階段、溶岩（L）の隣は掘らない。',
  '- 黒曜石 10（角を入れれば 14）: 溶岩源（L）に水を注ぐと黒曜石。溜まりの縁の溶岩源へ use water_bucket し、できた O を dig（ダイヤのツルハシ、9秒）、'
    + 'バケツで水を汲み戻す、を繰り返す。流れる溶岩（l）からは丸石しかできない。足元が溶岩にならない所から。',
  '- ゲート: 黒曜石で 幅4×高さ5 の枠（中 2×3）。下の段に 2、両側に 3 ずつ、上に 2（角は無くてよい: 10 個）。火打ち金（鉄1・火打石1。火打石は砂利を掘る）で中の下の面に use。',
  '- 持って入る: 鉄の全身・盾・鉄かダイヤの剣とツルハシ・弓と矢（あれば）・ブロック 64（丸石）・食料 100 点以上・水バケツ・ベッド（爆発用）。',
].join('\n');

/** The Nether, the fortress and the check before going deeper (the first part of `DRAGON_KNOWLEDGE`). */
const NETHER_KNOWLEDGE = [
  '## ネザー',
  '- ネザーの x・z はオーバーワールドの 1/8。ネザーで 100 歩くとオーバーワールドの 800。帰りのゲートの座標を計画の where に書いておく。',
  '- 地面: ネザーラック（n）・ソウルサンド（u、遅い）・マグマ（M、乗ると燃える）・溶岩の海（L）。y=31 より下は溶岩の海。崖の縁と溶岩の隣は歩かない。',
  '- 敵: ガスト（火の玉は盾か遮蔽で防ぐ。弓で落とす）、ピグリン（金の防具を 1 つ着ていれば襲わない。金を掘る・箱を開けると怒る）、'
    + 'ホグリン、ウィザースケルトン（衰弱。石の剣以上で）、ブレイズ。',
  '- ネザーで寝ない（ベッドは爆発する。ドラゴンには使える）。',
  '## ネザー要塞',
  '- 要塞（N: ネザーレンガ）は南北か東西の帯に並ぶことが多い。ゲートを出たら東西か南北へ真っすぐ 100〜300 進み、見えなければ直角の向きへ。'
    + 'find-structure・find-blocks（nether_bricks）・mc.view top で広く探す。高い所から見る（pillarUp）と遠くまで見える。',
  '- 要塞の中は細い廊下と橋。ブレイズのスポナー（S）は柵の付いた小部屋か階段の上。ウィザースケルトンに気をつける。',
  '## 出発の点検（ネザーの奥へ・要塞へ・エンドへ行く前。実走26: 作り直しをせずに要塞へ行き、ブレイズの所で詰まった）',
  '- 行く前に持ち物を数える: 食料点（ネザーの奥へは 100 以上、エンドへは 80 以上）、道具の傷み（耐久の残り。ツルハシの予備）、作業台（持ち歩く）、盾、'
    + '剣、足場のブロック 64 以上、ハーフブロック 12、ベッド（エンドへは 4 以上）、弓と矢 30（エンドへ）、金の防具 1（ピグリン）、水バケツ。',
  '- ネザーでの作り直し: 歪んだ森・真紅の森の幹（warped_stem・crimson_stem）→ 板 → 作業台と棒。深層岩の丸石か丸石 3 → ハーフブロック 6'
    + '（2 回で 12）。丸石 8 → かまど → 原鉄を焼く → 盾（板 6・鉄 1）。金塊 9 → 金の延べ棒 1。',
  '- 食料が 100 点に足りなければ、ゲートからオーバーワールドへ戻って狩る（+300〜500 秒）。真紅の森のホグリン（焼いた豚と同じ 20.8 点）でもよい。',
].join('\n');
/** The blaze as r3–r6 said it (the fight's hands first). */
const BLAZE_KNOWLEDGE = [
  '## ブレイズ',
  '- ブレイズロッド 7 本以上（アイ 12〜14 個分は 6〜7 本。粉はロッド1で2つ）。ドロップは 1 体で平均 0.5 本: 14 体ほど、300〜500 秒。',
  '- 待ち場: スポナー（S）から 3〜5 マス、同じ高さか 1 段下に 2×1 の隠れ場を作る。三方を囲い、目の高さに下付きのハーフブロックを置いて隙間にする。'
    + '火の玉の多くは隙間で止まる。ブレイズは近寄って来るので、隙間ごしに剣で打つ（鉄の剣で 4 打）。',
  '- hold は届く所で: 部屋の床と同じ高さで、部屋へ開いたマス（地図の上の層で部屋と続いている . ）に立って待つ。床・天井・壁の向こうでは届かない'
    + '（実走26: 部屋の床の下でその場の hold をして 61 秒届かなかった）。今の所が部屋の下や横なら、開いた所へ walk か pillarUp で寄せ、高さを合わせてから hold。',
  '- 戦う act には accept: ["blaze"] を付け、attack(target=blaze, hold=true, seconds=20〜30) で待ち打つ。盾は offhand に equip（体が構える）。'
    + 'stopIf hpBelow 12 で引き、隙間をふさいで満腹 18 以上で回復を待つ。棒はブレイズがいない時に pickup（溶岩・柵に注意）。',
  '- スポナーは壊さない（掘らない）。',
  '- 雪玉は 1 個 3 ダメージ（7 個で 1 体）、遠くから打てる。雪のバイオームで取れる時だけ（食料で戻る時のついでに）。',
].join('\n');
const PEARL_TO_END_KNOWLEDGE = [
  '## エンダーパール 12 個前後',
  '- エンダーマン: 歪んだ森（青い森、ネザー）に多く、夜のオーバーワールドにも出る。目を合わせない（look で足元）。2 マスの高さの天井の下に立つと入って来られない。'
    + '剣と盾で、accept: ["enderman"]。体力 40。水に入れない。',
  '- ピグリンとの交換: 金の延べ棒を drop target=ピグリン（金の防具を 1 つ着ておく）。1 個ごとに 6 秒ほどで何かを投げ返す。真珠は 2〜4%（金 20〜30 個で 1〜2 個）。'
    + '投げ返された物は pickup。金はネザーの金鉱石（g、掘ると金塊）・金鉱石・荒廃ポータルや砦の遺跡（bastion）の箱から。',
  '- 砦の遺跡（bastion: 黒い石の大きな建物、マグマキューブのスポナーや箱）にはピグリンと金・真珠のある箱がある。金を掘ると怒る。',
  '## エンダーアイ',
  '- ブレイズパウダー（ロッド1で粉2）＋ エンダーパール 1 → アイ 1。12〜14 個作る（枠は 12 か所、投げると割れることがある）。',
  '- 投げる: use item=ender_eye（at 無し）で、飛んだ方位 bearingDeg と距離が返る。オーバーワールドで投げる。',
  '- 三角測量: 2 地点（200m 以上離す、方位に直角な向き）で投げ、2 本の方位の線の交わる所がストロングホールド。'
    + '方位 θ（0 北・90 東）は x 方向 sinθ・z 方向 −cosθ。交点を計画の where に書く。近づいたら（50m 内）もう 1 回投げて下へ向くか見る。',
  '## ストロングホールド',
  '- 交点で地下へ dig の階段で下りる（y=30〜0 前後）。石レンガ（#）の廊下に出たら、mc.view で部屋を探す。図書室・牢屋は寄らない。',
  '- ポータルの部屋: 溶岩の上に枠（Q）が 12 個、階段の上。シルバーフィッシュのスポナーがあれば壊す（掘る）。',
  '- 枠にはめる: use item=ender_eye at=枠 face=up を 12 か所。全部 R になると中が e（エンドポータル）になる。入る前に食料・体力・ブロック・ベッドを確かめる。',
  '## エンド',
  '- 着いたら黒曜石の柱（O の塔）の上にエンドクリスタルがある。弓で shoot して壊す（矢 30 本以上）。鉄格子に囲まれたものは柱を登る（pillarUp）か、'
    + '足場を積んで近づき殴る。クリスタルが残るとドラゴンが回復する。',
  '- ドラゴン: 真ん中の岩盤の止まり木（X）に降りた時に剣で attack（頭を狙う）。飛んでいる時は shoot。ドラゴンの息（紫）は避ける。',
  '- ベッドの爆発: ドラゴンが止まり木に降りた時、頭の近くにベッドを place して use（寝ようとすると爆発）。自分は爆発の外（4〜5 マス離れて、間にブロック）。体力に気をつける。',
  '- 奈落（島の外の空気）に落ちない。縁の近くでは sneak。ドラゴンの体当たりで飛ばされることがある。',
  '- エンダーマンは目を合わせない（look で足元）。ブロックを置いて 2 マスの天井を作ると守れる。',
  '- 倒したら真ん中のポータルで帰れる。',
].join('\n');
/** Owner 2026-10-21 「エンドラ討伐に向けて徹底的に」: the Nether, the fortress, the blaze, the pearls, the eyes, the stronghold, the End. */
export const DRAGON_KNOWLEDGE = [NETHER_KNOWLEDGE, BLAZE_KNOWLEDGE, PEARL_TO_END_KNOWLEDGE].join('\n');

/**
 * r7 (runs 29–31, 2026-10-22: Sonnet twice and Opus once, from the same start under the spawner, went for the blazes at 10–13 s, before
 * the check; the section handed them the fight's hands first, ready to use): the blaze with 「準備が済んでから」 before the fight's hands,
 * and what to do when it starts under the spawner. The hands themselves as before.
 */
export const BLAZE_KNOWLEDGE_R7 = [
  '## ブレイズ（準備が済んでから戦う）',
  '- 戦うのは「出発の点検」（作業台・ハーフブロック 12・盾・食料 100 点）が済んでから。点検の前にブレイズが近くにいる時（湧き場の下・横で始まった時も）は戦わない: '
    + '射線の外（ブレイズから見えない岩の中）へ離れて塞ぎ、計画の準備の節へ。準備の前に火の玉を受けた時も、打ち返さずに離れて塞ぐ'
    + '（実走29〜31: 3 本とも準備の前に湧き場の下で戦い、体力と食料を失った。棒は 0〜1 本）。',
  '- ブレイズロッド 7 本以上（アイ 12〜14 個分は 6〜7 本。粉はロッド1で2つ）。ドロップは 1 体で平均 0.5 本: 14 体ほど、300〜500 秒。',
  '- 準備が済んだら、待ち場: スポナー（S）から 3〜5 マス、同じ高さか 1 段下に 2×1 の隠れ場を作る。三方を囲い、目の高さに下付きのハーフブロックを置いて隙間にする。'
    + '火の玉の多くは隙間で止まる。ブレイズは近寄って来るので、隙間ごしに剣で打つ（鉄の剣で 4 打）。',
  '- hold は届く所で: 部屋の床と同じ高さで、部屋へ開いたマス（地図の上の層で部屋と続いている . ）に立って待つ。床・天井・壁の向こうでは届かない'
    + '（実走26: 部屋の床の下でその場の hold をして 61 秒届かなかった）。今の所が部屋の下や横なら、開いた所へ walk か pillarUp で寄せ、高さを合わせてから hold。',
  '- 戦う act には accept: ["blaze"] を付け、attack(target=blaze, hold=true, seconds=20〜30) で待ち打つ。盾は offhand に equip（体が構える）。'
    + 'stopIf hpBelow 12 で引き、隙間をふさいで満腹 18 以上で回復を待つ。棒はブレイズがいない時に pickup（溶岩・柵に注意）。',
  '- スポナーは壊さない（掘らない）。',
  '- 雪玉は 1 個 3 ダメージ（7 個で 1 体）、遠くから打てる。雪のバイオームで取れる時だけ（食料で戻る時のついでに）。',
].join('\n');
/** r7: `DRAGON_KNOWLEDGE` with the blaze of r7 (`BLAZE_KNOWLEDGE_R7`). */
export const DRAGON_KNOWLEDGE_R7 = [NETHER_KNOWLEDGE, BLAZE_KNOWLEDGE_R7, PEARL_TO_END_KNOWLEDGE].join('\n');

/** The whole appendix of the mode's instructions: rules, the map legend, the knowledge. */
export const LLMC_SYSTEM_APPENDIX = [LLMC_RULES, MAP_LEGEND, DANGER_KNOWLEDGE, WOOD_KNOWLEDGE, FOOD_KNOWLEDGE, VILLAGE_KNOWLEDGE, ORDER_KNOWLEDGE,
  DRAGON_KNOWLEDGE].join('\n\n');

/**
 * r4 (SHANNON_MINECRAFT_LLMC_PROBE; owner 2026-10-22 「判断のループの sonnet が自力でも調べられるようにしたいので、調査系の道具や詰まった場合には
 * こう調べると良いという指示を加えたい」): how to look when stuck (the head's investigation, `mc.probe`), the forbid and caution of the plan, and
 * how to read a dangerous fact. Arch-check 6: a probe that showed the fact did not mend the hand without the knowledge of what to do with
 * it (S1: seven blocks of air read as a foothold; S2: a lake's section, and she dug down into it).
 */
export const INVESTIGATE_KNOWLEDGE = [
  '## 詰まった時の調べ方（mc.probe: 読むだけ・速い・体は動かない）',
  '- 驚き（1 判断で体力 −5 以上か 10 未満・落下 5 段以上・酸素 10 未満・同じ止まりの 2 回目・攻撃の当たり 0・同じ掘りの中止 3 回）の後は、'
    + '頭が先に決まった調べをして、live の body.investigation の先頭に「驚き: …」「調べ …: …」を出す。手を決める前にまずそれを読む。',
  '- 自分でも調べられる（mc.probe）: 同じ止まりが 2 回 → まず history（その場所の前の手と止まり）と、path（行き先へ掘らず置かずに歩けるか、切れ目、道の点）'
    + 'か sight（的が見えるか・4.5m で届くか・間のブロック）。落ちた・溺れそう → column（足の列の上下）。当たらない・届かない → sight。'
    + '周りの敵・危ないブロック → around。何があるか分からない → scan か mc.view。',
  '- 調べた事実で前提（道・高さ・届く所・材料のある所）を見直してから手を変える。同じ手を同じまま出さない。'
    + 'mc.probe の答えは次の判断で届く: 答えで変わる手は次の判断で出し、答えに関わらない手（離れる・食べる・囲う）は同じ応答で出してよい。'
    + 'live の investigation に答えが出ている時は、もう一度同じ調べをしない。',
  '- 原因が分かったら plan.update で、その節に forbid（してはいけない事: 「この縦穴を下へ掘らない」）か caution（気をつける事: 「東は落差 7」）を書く。'
    + 'live の plan.rules に、今の節と親の道の禁止・注意が出る。前提が変わって要らなくなったら lift で消す。',
  '## 危ない事実の読み方',
  '- 調べの答えは危ない事実を先にそのまま書く。「下 n 段は空気」「落差 n」は、そこを掘る・踏み出すと n 段落ちるという意味で、足がかりではない。',
  '- 「下 n 段は空気」なら飛び降りない。n が 3 段以下で、鉄の防具（全身）があれば降りてよい。4 段以上は、dig の階段（1 段ずつ前と下）で下りるか、'
    + '着地の所に水バケツを use してから。',
  '- 「水深 n」「水」: 水の中や真上で下へ掘らない（周りを塞いでも下が水なら同じ）。「溶岩」: その隣のマスを掘らない・歩かない。'
    + '「すき間 1」「高さ 1」は通れない（2 マスの高さが要る）。',
  '- 「見えない」「間に stone (x,y,z)」は、その間のブロックを dig してから、か、見える所（立てる所の候補）へ walk してから。',
  '- 道の点（path の points）は、そのまま walk の path に入れてよい（泳ぎの点も含む）。行けない時の「切れ目」の座標は、そこから先へ踏み出さない所。',
  '## 走査（live の body.scan）',
  '- スポーン・次元の変化・死の後に、体が読み込み済みの範囲（約 160m）を数えて body.scan に一度出す: 原木・村・水・溶岩・構造物・ネザーの幹・要塞・スポナー・ポータルの方角と距離。',
  '- 走査にある物を、目印と同じく計画の where と次の手に使う。次元が変わった時は、走査を見て計画の次の節（材料・場所・順番）を plan.update で見直す。',
].join('\n');

/** r4: the check on entering the Nether (the decision's and the first plan's). */
export const NETHER_ENTRY_KNOWLEDGE = [
  '## ネザーに入ってすぐの点検（実走26: 作業台・ハーフブロック・盾なしで要塞へ行き、ブレイズの所で詰まった。4m にネザーの幹があった）',
  '- 入ったらまず: 帰りのゲートの座標を計画の where に書く。body.scan でネザーの幹・要塞（ネザーレンガ）・溶岩の溜まりの方角を見る。around で近くの敵（ガスト・ピグリン）を見る。',
  '- 持ち物を数える: 作業台・ハーフブロック 12・盾・食料 100 点・足場のブロック 64・金の防具 1。足りない物は、奥へ行く前にゲートのそばで作る。',
  '- 作業台をネザーで作る: 真紅の幹（crimson_stem）か歪んだ幹（warped_stem）を dig（素手でも取れる）→ craft crimson_planks か warped_planks（幹 1 で板 4）→ '
    + 'craft crafting_table（板 4）。置いて使い、終わったら dig して持ち歩く。棒も板 2 で 4 本。',
  '- ハーフブロック: craft cobblestone_slab（丸石 3 で 6）か cobbled_deepslate_slab・blackstone_slab。作業台が要る。ブレイズの待ち場の目の高さの隙間に使う。',
  '- 盾: craft shield（板 6・鉄の延べ棒 1）を作業台で。equip slot=offhand（体が構える）。ネザーには鉄の鉱石が無い（砦の遺跡の箱くらい）ので、鉄はオーバーワールドで持って来る。',
].join('\n');

/** r4: the appendix with `INVESTIGATE_KNOWLEDGE` (the same bytes at every decision). */
export const LLMC_SYSTEM_APPENDIX_R4 = [LLMC_SYSTEM_APPENDIX, INVESTIGATE_KNOWLEDGE, NETHER_ENTRY_KNOWLEDGE].join('\n\n');

/**
 * r5 (run 28, owner 2026-10-22 「止めて直す」): when a completion is one (Sonnet asked to complete five times, "not reached in this run", and
 * the task stopped 263 s early), how a stair goes down (31 digs stopped at a block not yet in sight, two ahead), and what the head's code now
 * does to the plan by itself (a node done when its doneWhen is seen; a fact noted as a caution at the second same surprise).
 */
export const R5_KNOWLEDGE = [
  '## 完了・階段・計画の自動の進み',
  '- 完了（fca_complete）は、依頼の目的を観測した時だけ（エンドラ討伐なら、ドラゴンの死を見た時だけ）。時間や遠さで区切らない。'
    + '届かないと思ったら、計画を見直して続ける。時間と費用の上限は運用者が止める。目的の前の完了は「完了の誤り」として返る。',
  '- 階段は 1 段ずつ。足の前の 2 マス（頭と足）を掘ってから 1 歩下りる。2 マス先は掘らない。'
    + '見えない（sight が「見えない」「間に stone (x,y,z)」と言った）時は、間のブロックを先に掘る。',
  '- 計画の節の doneWhen が観測の形（have:物>=数・dim:次元・at:x,y,z~半径・food>=点、& と |）なら、頭のコードが毎判断に観測で確かめて'
    + '節を済みにし、今の節を次へ進める（plan.update は要らない）。',
  '- 同じ驚きの 2 回目は、頭のコードが今の節の caution に事実を書く（例「(174,54,197) の stone の向こうは見えない」）。'
    + '判断ではなく事実のメモ: 次の手の前提にする。前提が変わったら lift で消す。',
  '- 体の止まりの文: 「一歩ではない」は段差 2 以上のほか、「着いていない」（今の足・的までの距離・通れない所が続く）、「そのものには立てない」'
    + '（立てる隣が続く）、「iron_door」（手では開かない）。walk は木の扉・ゲート・トラップドアを開け、道の足と頭の高さの葉を壊して進む。'
    + '「掘れない」の「見えない：間に (x,y,z)」は、その間のブロックを先に掘る。pickup の「無い」には落とし物の座標と間のブロックが続く。',
].join('\n');
/** r5: r4's appendix and `R5_KNOWLEDGE` (the same bytes at every decision). */
export const LLMC_SYSTEM_APPENDIX_R5 = [LLMC_SYSTEM_APPENDIX_R4, R5_KNOWLEDGE].join('\n\n');

/**
 * r6 (run 29, owner 2026-10-22 「r6 を作り 2 モデルで比べる」): begun in a Nether fortress, Sonnet went for the blazes at 10 s past the plan's
 * "now" (a table), fell to 3.7 health with no food at hunger 17, waited 325 s for health that never came, and stopped the task with
 * fca_wait. The code now says the facts first (the current node, what the place's check lacks, health that does not come back and where
 * food is); this says what they are, how an act names its node, and what a wait is in this mode. Read the same by Sonnet and Opus.
 */
export const R6_KNOWLEDGE = [
  '## 計画の今・準備の不足・回復・待ち',
  '- live の body.planNow が計画の今の節。act の why は、その手がどの節のためかを [節の id] で始める（例「[p1.2] 丸石でハーフブロックを作る」）。'
    + '今の節と違う節の手なら「[p2.1] 理由: …」と、今の節を後にする理由を 1 行書く。急ぎの手（離れる・食べる・囲う）は「[急ぎ] …」。',
  '- live の body.shortage（準備の不足）は、今の節と次元の「出発の点検」と持ち物をコードが比べた事実（作業台・ハーフブロック・盾・金の防具・足場のブロック・食料）。'
    + 'ネザーの中から始まった時も、入った時と同じ点検。戦い・奥への移動の前に何を先にするかを決める材料にする。',
  '- 体力の自然回復は満腹 18 以上の時だけ。live の body.recovery（と wait の結果の「頭:」の行）に「自然に戻らない」と出ている間は、'
    + 'wait や fca_wait で待っても体力は戻らない。食料が 0 で回復が要る時は、待たずに食料を取りに行く（recovery の「食料の当て」: 近い動物・村・畑、ネザーならホグリン・帰りのゲート）。',
  '- fca_wait: 返事を待つ相手のいない依頼（運用者の依頼）では、このモードの待ちでタスクは止まらない。待つ物（焼き上がり・満腹 18 以上での回復）の事実か、'
    + '「待つ物が無い」が 1 行で返る。その場で待つなら mc.act の wait の手で（体が待つ）。止めるのは運用者。',
].join('\n');
/** r6: r5's appendix and `R6_KNOWLEDGE` (the same bytes at every decision). */
export const LLMC_SYSTEM_APPENDIX_R6 = [LLMC_SYSTEM_APPENDIX_R5, R6_KNOWLEDGE].join('\n\n');

/**
 * r7 (runs 29–31, owner 2026-10-22 「作って走らせる」): the urgent line now says whether a near hostile reaches (the body's sight), the walled
 * off are said after the plan's now; how to move in a fortress (run 31: the corridor to the gate opened on the blaze room, dead in 10 s;
 * run 30's tunnel in the rock at y=58 took no fireball); and what a stopIf stop in a blaze's line asks first (run 31: the health stop at
 * 8.7 left her standing there, burning).
 */
export const R7_KNOWLEDGE = [
  '## 急ぎの行・届かない敵（r7）',
  '- live の body.urgent の敵の行は、体の sight で調べた届くかの事実を言う: 「見える（射線の中）」は撃たれる・打てる所、「見えない…道はある」は回って来る。'
    + '急ぎの手（離れる・食べる・囲う）は「[急ぎ] …」で出す。急ぎを理由にブレイズを打ちに行かない。',
  '- live の body.unreachable の「壁の向こうで届かない（間に …）」相手は、こちらを撃てず、こちらも打てない。急ぎではない: 計画の今の節（planNow）と準備の不足（shortage）を先にする。',
  '## ネザーの移動（要塞の中・ブレイズの部屋の近く。実走31: ゲートへ戻る通路がブレイズの部屋とつながっていて、火の玉と燃えで 10 秒で死に、持ち物を全部失った。'
    + '実走30: 同じ西行きを y=58 の岩の中のトンネルで進み、火の玉を一度も受けなかった）',
  '- 要塞の中やブレイズの部屋（スポナー S）の近くを移動する時は、要塞の通路（ネザーレンガの床・橋・階段）を歩かない。'
    + '通路の床より 1 段以上下のネザーラック（岩）に、1 幅・2 マスの高さのトンネルを掘って進む（足と頭の 2 マスを dig → 1 歩 walk、を繰り返す。1m 約 2 秒）。',
  '- トンネルは横と上が岩のまま残るので、ブレイズ・ガストから見えない。開いた所（通路・部屋・溶岩の海の上の崖）に出たら、そこで止まらずに岩へ戻るか塞ぐ。',
  '- 射線の中（ブレイズから見える所）では立ち止まらない: wait・hold・食べる・作る手は、見えない所（岩の中・塞いだ所）に入ってから。',
  '- ネザーでは水バケツで火を消せない。燃えている間は 1 秒に 1 ずつ減る: 見えない所へ入る・塞ぐのが先。',
  '## stopIf で止まった時（実走31: 体力の止め 8.7 で手が止まり、体は射線の中に立ったまま燃え続けた。次の判断は 8 秒後で、間に合わなかった）',
  '- stopIf（hpBelow・hostileWithin）で止まった次の判断は急ぎ（要約・想起を飛ばす）。live の body.urgent の先頭に「今いる所は blaze #n から見える（射線の中）」と出たら、'
    + 'その場で囲う・食べる・待つ前に、まず見えない所へ（来た道を 2〜3 歩戻る・1 段下の岩へ掘る）。そこで塞いでから食べる。',
  '- 射線の中を通る act の hpBelow は高め（12 以上）にする。体力が低い時は、射線の中の道を使わない（岩の中を掘る）。',
].join('\n');
/**
 * r7: r6's appendix with the blaze of r7 (`DRAGON_KNOWLEDGE_R7`: 「準備が済んでから」 before the fight's hands) and `R7_KNOWLEDGE` (the same
 * bytes at every decision).
 */
export const LLMC_SYSTEM_APPENDIX_R7 = [LLMC_SYSTEM_APPENDIX_R6.replace(DRAGON_KNOWLEDGE, () => DRAGON_KNOWLEDGE_R7), R7_KNOWLEDGE].join('\n\n');

/**
 * r8 (run 32, owner 2026-10-22): in the Nether she stopped at the edge of the rock and put a one-wide bridge without walls over the lava sea
 * (24–30 blocks of air under it) in sight of a fortress corridor; a wither skeleton there hit her three times in 2.3 s, the third knock threw
 * her off, and the lava killed her (the pack lost, 1,100 s to rebuild). The footing is now a line of the live state (`footing`); this says
 * how to cross a gap, what to do when the footing says she would fall, and how an urgent decision is asked (a short state, a short answer).
 */
export const R8_KNOWLEDGE = [
  '## 空所を渡る・足場（r8。実走32: 要塞の外の溶岩の海の上に壁の無い幅 1 の橋を 30m 伸ばし、通路のウィザースケルトンに 2.3 秒で 3 回打たれ、'
    + '押されて橋から落ちて溶岩で死んだ。持ち物を全部失い、立て直しに 1,100 秒かかった）',
  '- ネザーで空所（溶岩の海・深い穴・崖）を渡る時は、(1) 岩の中のトンネル（空所の縁から 1 段下の岩を掘る・岩のある回り道）か、'
    + '(2) 両脇（足の高さ）に壁のブロックを置いた橋、のどちらかにする。橋は 1 マス進むごとに、足元の床と、その両脇の足の高さに壁を置く'
    + '（要塞の通路から見える所は、頭の高さにも）。',
  '- 壁の無い幅 1 の橋は使わない: 落差 4 以上の所、敵のいる構造物（要塞・砦の遺跡）の近く、ウィザースケルトン・ブレイズ・ガストの見える所。'
    + '落ちると溶岩で死に、持ち物を全部失う。',
  '- live の body.footing は足の周りの床の事実（体の地図と column の調べから、コードが書く）: 「幅 1 の橋・両脇（北・南）とも空所（落差 28、下は溶岩）。押されたら落ちる」。'
    + '「押されたら落ちる」が出ている間は、立ち止まらない・その場で跳ばない・縁で積まない。近接の敵（wither_skeleton・zombified_piglin・piglin_brute・'
    + 'hoglin・zombie など）が見えたら、まず空所から離れる（来た道を戻る・壁のある所・岩の中へ）か、敵との間にブロックを置く。',
  '- 落差 3 以下で床のある空所は降りてよい。足場の事実に落差が出ない時（footing が無い）は、周りに空所は無い。',
  '- 近接の敵が見えたら、体の反射が 0.25 秒ごとに見て、空所の縁なら空所から離れる 1 歩か間のブロックを出す（最大 3 手）。台帳に「これ以上は反射でしない」と'
    + '出たら、その先の逃げ方・戦うかどうかは判断で。',
  '- 地中で素手の時: mc.probe column（自分の列）の「真上」の行が、地表までの固い段数と 1 段の秒（素手の石は約 7.7 秒・土は約 0.8 秒）を言う。柔らかい列を選ぶ。',
  '- 急ぎの判断（live に urgent がある時）の live は短い状態: urgent・footing・planNow（題だけ）・map・state・threats・inventory・events・lastResults だけ。'
    + '最後の answer の行に従う: 考えは 2〜3 文、mc.act は 1 つ、手は 3 つまで。landmarks などは次の急ぎでない判断で戻る。',
  '- 判断は次の 1 手を決める: 長い計画は plan.update に任せ、毎回の考えは短くする（迷う間も敵は来る）。',
  '- live の plan は、body.planNow と重なる「道」と「今」を省いて出る（done・next・blocked・rules）。今の節とその道は body.planNow を読む。',
].join('\n');
/** r8: r7's appendix and `R8_KNOWLEDGE` (the same bytes at every decision). */
export const LLMC_SYSTEM_APPENDIX_R8 = [LLMC_SYSTEM_APPENDIX_R7, R8_KNOWLEDGE].join('\n\n');

/**
 * r9 (run 33, owner 2026-10-22): with no food, shield or golden armour she followed an enderman for 280 s, a plain piglin followed her and
 * hit her five times in 5.5 s while she stepped away, the urgent act's `stopIf hpBelow 9` (her health was 6.6) stopped it with 0 hands, and
 * she died (the pack lost, 750 s to rebuild with bare hands). The calls were 6.6 a minute on acts of 3 hands and 3.5 s. This says what
 * a piglin is without golden armour, the order of the pearls, what a chasing melee enemy is answered with, how a stopIf is put, how
 * the plan's done is kept, and how long an act may be.
 */
export const R9_KNOWLEDGE = [
  '## ネザーのピグリン・追ってくる近接の敵・パールの順（r9。実走33: 食料・盾・金の防具なしでエンダーマンを約 280 秒追い、通常のピグリンに追われて'
    + '5.5 秒で 5 回打たれ、体力 20 から死んだ。持ち物を全部失い、立て直しに 750 秒かかった）',
  '- ピグリン（通常・ブルート）は、金の防具を 1 つ着けるまで襲う。ネザーでは、金の防具を 1 つ着けるまでピグリンの近く（8m）に長居しない。'
    + '金の防具は「出発の点検」の項目: 金の延べ棒 4（靴）〜5（兜）、金塊 9 で延べ棒 1、ネザーの金鉱石（g）は掘ると金塊が出てかまどで延べ棒になる。着るまでは、砦の遺跡・ピグリンの群れの近くを避ける。',
  '- エンダーパールはブレイズの棒（7 本）の後。計画の順を守る。順を飛ばす時（棒を先に取れない理由がある時）は、plan.update の理由に書く。'
    + '食料・盾・金の防具が無いまま遠出して敵を追うのは、実走33 の死の形。',
  '- 追ってくる地上の近接の敵（ピグリン・ゾンビ・ウィザースケルトンなど）は、離れても同じ速さで追われ、1 秒ちょっとごとに打たれる。離れる 1 歩では逃げ切れない。選ぶ手:'
    + ' (1) 鉄以上の剣を持っていれば打ち返す（equip で剣を持つ→ accept にその種類 → attack target=#id, untilDead。ピグリンは体力 16、鉄の剣で 3 打前後）。'
    + ' (2) 剣が無い・体力 6 以下なら、敵との間に place（足と頭の高さの 2 マス）か、pillarUp n=2 で 2 段上がる（足の周りに落差 3 以上・溶岩が無い時だけ）。'
    + '体の反射も同じ順で動く: 剣か斧を持っていて体力が 6 より上なら体が打ち返し（見える・3m 内の一番近い相手、1 手に最大 2 回）、持っていない・体力 6 以下なら'
    + '間のブロックか 2 段積んで上がる。台帳に「打ち返した 2 回・当たった 2・相手の残り体力 …」と出る。「これ以上は反射でしない」と出たら、その先は判断で（上の (1)(2)）。',
  '## 石の中・素手で地表へ出る時（r9。実走33: 死後に石の中から素手で 750 秒かけて階段を掘った）',
  '- 自分の x,z で mc.probe column を聞く（隣の列や足から下だけでなく、自分の列）。答えの「真上」の行（above）が、頭の上の固い段数・開く高さ・1 段の秒（素手の石は約 7.7 秒・土は約 0.8 秒）を言う。'
    + 'それで真上へ掘るか、柔らかい列（土・砂利）へ寄るか、階段にするかを決める。',
  '- walk が「そこまで進まなかった」で止まった時の文は、足のマスの下・次のマス（足・頭・下）・そのマスにいる物を言う: 塞いでいる物を掘る・避ける手を、その事実から選ぶ。'
    + '「そのものには立てない（下 n マスが空気）」は、続く「立てる隣」へ walk する。',
  '## 計画の済み（r9）',
  '- 親の節が済みになっても子は済みにならない。子は自分の doneWhen の条件か、あなたの plan.update（set state=done）で済む。'
    + '場所・次元（dim:・at:）だけの条件の親は、子が済むまで済みにならない（ログに held と出る）。at: は次元ごとの場所（@nether・@overworld）。',
  '- 消費して無くなる物（板・棒・原木）を条件にした子は、親の物ができても自動では済みにならない: できた時に自分で done にする。',
  '## stopIf の置き方（r9）',
  '- hpBelow は今の体力より低い値にする。今の体力以上の値だと act は 1 手も動かずに止まる（実走33: 体力 6.6 の時の hpBelow 9）。'
    + '頭が外して結果の先頭で知らせるが、その act に体力の守りが無くなる: 体力が低い時は戦う act を出さず、離れる・塞ぐ・食べるを先にする。',
  '- 待つ・待ち打ちの手（wait・attack の hold・目を合わせて待つ）の act には stopIf hostileWithin 4〜8 を付ける（付けなければ頭が 4 を足す。accept の種類は除かれる）。',
  '## 手を長く（r9。実走33: 呼び出しが 1 分に 6.6 回。act は平均 3 手・3.5 秒で、判断の費用の多くは短い act の数だった）',
  '- 同じ種類の手が続く場面（トンネルを掘る・階段を下りる・橋を掛ける・採掘・歩きながら掘る）は、1 回の act に 10〜12 手（上限 12）入れる。'
    + 'dig の at は 1 手に 8〜16 マス、walk の path は 1 手に 8〜32 点まで書ける。地図で見えている先まで一度に出す。',
  '- 安全は act の中で保たれる: 反射（溶岩・落下・溺れ・燃え・逃走）はいつも効き、stopIf（hostileWithin・hpBelow・blockChanged）と onFail が、'
    + '予想と違った所で act を止めて返す。止まった行とその周りで次の act を直す。短く刻むほど、1 手ごとに判断の費用と待ち（5〜8 秒）がかかる。',
].join('\n');
/** r9: r8's appendix and `R9_KNOWLEDGE` (the same bytes at every decision). */
export const LLMC_SYSTEM_APPENDIX_R9 = [LLMC_SYSTEM_APPENDIX_R8, R9_KNOWLEDGE].join('\n\n');
/** The appendix of the mode's models: r9's when SHANNON_MINECRAFT_LLMC_PROBE is on, else r3's as it was. */
export function llmcSystemAppendix(probe: boolean): string { return probe ? LLMC_SYSTEM_APPENDIX_R9 : LLMC_SYSTEM_APPENDIX; }
