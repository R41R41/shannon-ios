# 範囲を挙げて体に任せる手（2026-10-26、実走 39 の直し）

移動の `go` と、`obsidian`・`fight`・`mine`・`make`・`portal`・`smelt`。ライ氏の決定: 何を、どこで、どこまでやるかは LLM が決め、体は秒より細かい動き・繰り返し・小さな失敗の直しだけをこなす。体は LLM が挙げた範囲の外で目標を探さない・選ばない（ADR-0014 で外した mine-block の形にしない）。

## 1. go（移動）
## 線引き（ライ氏の決定）
- LLM が決める: 行き先（座標、または並べた「済むマス」）、掘ってよい物、置いてよい物、避ける物、時間・回数の上限。
- 体が処理する: 道の細部だけ（どのマスを踏む・掘る・置く、引き直し、詰まった時の直し）。
- 体は目標の物を探さない・選ばない（ADR-0014 で外した mine-block の形にしない）。行き先は必ず LLM が座標で渡す。「最寄りの鉄鉱石へ」のような引数は無い。
- 本当に進めない時だけ、理由を付けて頭へ返す。

## 手の JSON（`ActHand`、フラット。do が `go` の時だけ使える欄）
| 欄 | 型 | 意味 |
|---|---|---|
| `to` | {x,y,z} | 行き先（足を置くマス）。`rel: true` なら手を始める時の足のブロックからの差 |
| `goals` | {x,y,z}[]（2〜8） | 行き先の候補。どれか 1 つに着けば済み（道が一番短い所へ向かう）。`to` と `goals` はどちらか 1 つ（両方・無しは断る）。`rel` は両方に効く |
| `range` | 0〜4（既定 0.5） | 着いたことにする距離（行き先からの m）。既存の walk と同じ |
| `canDig` | string[]（最大 12） | 掘ってよい物。ブロック id（`stone`・`cobbled_deepslate`・`dirt`…）。短縮語: `stone`（stone・cobblestone・andesite・diorite・granite・tuff・deepslate・cobbled_deepslate・blackstone・netherrack・end_stone・basalt・calcite 等の石類）・`dirt`（dirt・grass_block・coarse_dirt・podzol・mycelium・mud・clay・rooted_dirt）・`sand`（sand・red_sand・gravel・soul_sand）・`wood`（原木・板・柵の類。村の物は除く）。無し/空は「掘らない」。bedrock・obsidian・鉱石・箱・かまど・ベッド・扉・村の物（`takeOk` 相当）は、名前を書いても掘らない（鉱石は dig の手で掘る。go は道を作るだけ） |
| `canPlace` | string[]（最大 6） | 置いてよい物（足場・橋・柱・穴埋めに使う）。ブロック id（`cobblestone`・`dirt`・`cobbled_deepslate`・`netherrack`…）。持っていない物は使わない。無し/空は「置かない」 |
| `maxDrop` | 0〜10（既定 3） | 一度に落ちてよい高さ（段）。落ちる先が水なら高くても可 |
| `waterOk` | bool（既定 false） | false なら水のマスとその隣の深い水を避ける。true なら泳いでよい |
| `seconds` | 5〜120（既定 60） | この手の時間の上限。超えたら止めて返す |
| `maxDig` | 0〜200（既定 40） | 掘る数の上限 |
| `maxPlace` | 0〜100（既定 24） | 置く数の上限 |
| `sprint` | bool | 走る（既存） |
| `rel` `note` `onFail` | | 既存。onFail の既定は他の移動と同じ（stop） |
- 溶岩・火・マグマブロック・サボテン・スイートベリーの茂み・ウィザーローズ・マグマの隣、溶岩の隣のマスは、設定にかかわらず**必ず避ける**（避ける物の既定で、外せない）。
- 敵は act の `stopIf.hostileWithin` と反射で守る（go はそれを変えない）。

## 短い書き方（1 行、`minecraftActShortHands.ts`）
`go X,Y,Z [X,Y,Z ...] [dig=a,b] [place=a,b] [range=N] [seconds=N] [maxDrop=N] [maxDig=N] [maxPlace=N] [waterOk] [sprint]`
- 座標が 1 つなら `to`、2〜8 個なら `goals`。`dig=` は canDig、`place=` は canPlace（カンマ区切り）。`rel` は他の手と同じに付けられる。
- 例: `go 120,40,-30 dig=stone,dirt place=cobblestone,dirt seconds=45`

## 動き（体の中）
1. 行き先（または候補）へ、pathfinder で道を引く。掘ってよい物だけ掘る道、置いてよい物だけ置く道（足場・橋・柱・穴埋め）を許す。許していない物は通らない・壊さない。
2. 道が塞がった・地図と違った・詰まった（約 3 秒位置が変わらない）時は、体の中で道を引き直す。進まない時は少し戻る・掘る・置くで直すのを数回（5 回）まで。
3. 縦の移動（上り: 柱 `pillarUp` の部品・階段掘り、下り: 竪穴・階段掘り・水）もこの手の中でやる。柱を作る時は fix 済みの pillarUp（置く高さ 1.05、4fb6e2b）を部品に使う。
4. 本当に進めない時だけ、理由を付けて返す（`failed`）。理由の語（行の本文の先頭に `code` を置く）: `lava`（道の先が溶岩・火）・`no_tool`（掘る道具が無い／ツルハシで掘れない）・`no_blocks`（置く物が無い）・`limit_time`・`limit_dig`・`limit_place`・`dead_end`（許された手では道が無い。行き止まり）・`stuck`（直しを尽くしても進まない）・`unsafe`（行き先が溶岩の中・落下で死ぬ高さ・敵の巣など）・`not_loaded`（行き先が読み込まれていない地図の外で、進める限り進んだが着かなかった）。
5. 結果の行（`ActResult.lines` の本文）: `go 着いた (x,y,z) 道 N 歩・掘 a・置 b・引き直し r 回` ／ 失敗は `go 止まった <code>: <ひとこと> (x,y,z) 道 N 歩・掘 a・置 b・引き直し r 回。<次の手の目安>`。`done`（act の終了条件）が成り立てば手の途中でも済みにする（既存の仕組み）。
6. 手の見積もり（頭が act の最大時間を決める）: 道のりの直線距離 / 4 秒 + 掘る数 × 0.7 秒 + 置く数 × 0.5 秒。上限は `seconds`。頭の `actMilliseconds` が同じ式を持つ（体と頭で同じ数にする）。

## 2. ほかの 6 つ

`go` の契約は go-contract.md。ここはそれと同じ線引きで足す 6 つの手: `obsidian`（黒曜石づくり）・`fight`（戦い）・`mine`（鉱脈を掘る）・`make`（作る連鎖）・`portal`（ポータルの枠）・`smelt`（かまど）。

## 共通の線引き
- LLM が決める: 何を、どこで、どこまでやるか。やめる条件と許す手。
- 体がこなす: 秒より細かい動き、繰り返し、失敗の小さな直し。
- 体は、LLM が挙げた範囲の外で目標を探したり選んだりしない。
- 手ごとに上限（時間・回数）を必ず付ける。何をしたか（数・止まった理由）を必ず結果の行に書く。
- 本当にできない時だけ、理由の語（code）を付けて返す（失敗の行の本文の先頭: `<手> 止まった <code>: <ひとこと>`、成功は `<手> 済 <数など>`）。
- 床の反射（体のコードの反射: 溶岩・溺れ・落下・低 HP の逃走など）が優先。反射が体を握っている間は手は待つか、既存の afterReflex の仕組みで始め直す。手は反射と取り合わない。
- 既存の手（walk/dig/place/pillarUp/use/craft/furnace/chest/attack/…）は壊さない。新しい手は既存の部品を呼んで作ってよい（use の水の汲み・注ぎ、dig、craft、furnace の put/take、attack、pillarUp、go など）。
- act の `stopIf` / `done` / cancel / repeat とは今の手と同じに協調する（abort されたら手を止める）。

## 手の JSON（flat `ActHand`。頭の `contracts/minecraftActContract.ts` と `minecraftActHandRules.ts` が正。体の検証は同じ欄・同じ範囲に合わせる）
新しい欄: `stance`('fight'|'flee')・`retreatHp`(整数 1〜19)・`axis`('x'|'z')・`furnaces`(整数 1〜4)・`enter`(bool)。ほかは既存の欄を使う: `at`(最大 16 マス)・`count`(1〜2304 の整数、手ごとにさらに上限)・`block`・`item`・`items`・`fuel`・`fuelCount`・`target`・`range`・`seconds`(0.5〜120)・`tool`・`collect`・`canDig`・`canPlace`・`maxDig`・`maxPlace`。
欄の表（needs = どれか 1 つが要る組、may = 付けてよい欄。ほかは断る。どの手にも rel・note・onFail）:

| 手 | needs | may |
|---|---|---|
| obsidian | at | count, seconds, canPlace, maxPlace |
| fight | target | stance, item, retreatHp, range, seconds |
| mine | block, at | count, tool, collect, seconds, canDig, maxDig |
| make | item | count |
| portal | at, axis | block, enter, canPlace, maxPlace, seconds |
| smelt | items | fuel, fuelCount, furnaces, at, seconds |

## 1. obsidian — 黒曜石づくり
- LLM が決める: 溶岩の源のマス `at`（1〜8 個。地図の L・live の liquid/obsidian の座標から LLM が選ぶ）、個数 `count`（1〜64、既定 1）。上限 `seconds`（5〜120、既定 90）。立つ足場に置いてよい物 `canPlace`（無ければ置かない）・`maxPlace`。
- 体がこなす: 水バケツ（持ち物の water_bucket。無ければ `no_bucket`）で、`at` の溶岩の源の隣に水を注ぐ → 固まる（黒曜石になる）のを待つ → ダイヤのツルハシで掘る（無ければ `no_tool`）→ 拾う → 水を汲み戻す → 次の溶岩へ。注げない・立てない時は立ち位置を替えて注ぎ直す（置き直す）。溶岩の中・隣へ流れ込む位置には立たない（溶岩を必ず避ける）。`at` の外の溶岩を探して使わない（LLM が挙げた源だけ）。`at` のマスが溶岩の源でなければ `no_lava`。
- 結果: `obsidian 済 黒曜石 N 個・水の注ぎ a 回・立ち直し r 回・水回収済` ／ 失敗 code: `no_bucket`・`no_tool`・`no_lava`・`unreachable`（立てる所へ行けない）・`lava_danger`・`limit_time`・`stuck`。取れた数が `count` に足りなければ failed（取れた数は書く）。
- 根拠: 実走 39 の黒曜石づくり 446 秒・0 個（水の手の not_filled 4・target_unstandable 3・not_arrived 4）。

## 2. fight — 戦い
- LLM が決める: 相手 `target`（体の観測の敵の `#id` か種類名）、`stance`（fight=戦う、flee=逃げる。既定 fight）、武器 `item`（既定は持っている一番強い剣/斧）、`retreatHp`（これ未満で戦いをやめて食べる・逃げる）、追う距離の上限 `range`（m、0〜16、既定 8）、上限 `seconds`（5〜60、既定 20）。
- 体がこなす: 狙い・間合い・盾の構え（持っていれば）・クリティカルの時機（落ちながら打つ、スプリントを切って打つ等）・近づく/下がる・低 HP で食べる/退く。`flee` は相手から `range` m 以上離れるまで逃げる（岩陰・柵の中は選ばない。道は go と同じ避け方）。LLM が挙げた相手以外へ向かわない（ほかの敵が来ても、挙げた相手が死ぬか上限まで）。
- 反射との関係: 床の反射（溶岩・溺れ・落下・低体力 8 以下の逃走）が優先。反射が起きたら fight は止まり（`reflex` で返る）、反射が終わるまで始め直さない。fight が反射の逃走や盾を邪魔しない。
- 結果: `fight 済 相手 死んだ/逃げた/離れた・与えた打撃 n・受けた体力 h・食べた f` ／ failed code: `lost`（相手が見えなくなった）・`unreachable`・`retreat`（retreatHp で退いた）・`reflex`・`limit_time`・`no_weapon`。
- 既存の `attack` は残す（hold など）。fight は attack より上の「戦い方を体に任せる」手。

## 3. mine — 鉱脈を掘る
- LLM が決める: 掘る物の種類 `block`（ブロック id。例 iron_ore。`deepslate_iron_ore` のような別名は別の種類）、始点 `at`（鉱脈のマス 1〜4 個）、最大の数 `count`（1〜64、既定 8）、道具 `tool`（既定は一番速く掘れる物。作らない）、上限 `seconds`（5〜120、既定 60）、`collect`（既定 true=拾う）、鉱脈へ行く道を掘ってよい物 `canDig`・`maxDig`（無ければ道は掘らない＝すでに届く所だけ）。
- 体がこなす: `at` のマスから、**同じ種類 `block` のつながったマス**（面・辺・角で接する）だけをたどって、近い順に掘る。落ちた物を拾う。道具を持ち替える（壊れそうなら次の道具へ）。たどるのは LLM が指定した種類のつながりだけ（ほかの鉱石・ブロックを探さない）。届かないマスへは `canDig` の物だけ掘って道を作る。
- トンネル・階段・柱は既存の repeat や go で足りる: この手では作らない。
- 結果: `mine 済 iron_ore N 個（raw_iron×N を得た）・たどった M マス` ／ failed code: `no_block`（`at` のマスが `block` でない）・`no_tool`・`tool_broke`・`full`（持ち物が満杯）・`unreachable`・`limit_time`・`limit_dig`・`danger`（溶岩・水が出た。必ず避ける）。数が `count` に足りなくても、つながりが尽きたなら `済`（取れた数を書く: `つながりが尽きた`）。

## 4. make — 作る（クラフトの連鎖）
- LLM が決める: 作る物 `item` と数 `count`（1〜64、既定 1）。
- 体がこなす: 途中の物（板・棒・インゴットからの道具の部品など）を持ち物の材料から順に作る。3×3 が要るのに作業台が近く（4.5m 内）に無ければ、持っていれば（持ち物の crafting_table）近くに置く（置いたら拾って戻さなくてよい）。持っていなければ `no_table`。
- 材料が足りない時は、足りない物の一覧を返す: `make 止まった missing: oak_planks×3・stick×2（作る物 wooden_pickaxe の分）`。何も作らずに返す（途中まで作って止めない）。
- 体は材料を集めに行かない。1 つの手で作るのは 1 種類（`item`）とその途中の物だけ。
- 結果: `make 済 wooden_pickaxe×1（oak_planks×3・stick×2 も作った）` ／ failed code: `missing`・`no_table`・`no_recipe`・`full`。

## 5. portal — ポータルの枠
- LLM が決める: 枠の内側の左下のマス `at`（1 つ）と向き `axis`（x: 枠は x 方向に広がる、z: z 方向に広がる）。枠の黒曜石 `block`（既定 obsidian）、点けた後に入るか `enter`（既定 true）、足場に置いてよい物 `canPlace`・`maxPlace`、上限 `seconds`（5〜120、既定 60）。
- 体がこなす: 4×5 の枠（角なし、黒曜石 10 個）を組む（下の段・両脇・上の段。足場を作る・立つ位置を替える・pillarUp を含む）→ 内側の下の面を火打ち金で点ける（持ち物の flint_and_steel）→ `enter` なら、点いたポータルのマスへ walk（range=0）で入って約 4 秒立って待つ（既存の入り方を使う）。
- 黒曜石が 10 個無ければ `no_obsidian`（持っている数を書く）。火打ち金が無ければ `no_flint`。枠の場所が岩や水で組めなければ `blocked`（どのマスか書く）。枠が既に半分あれば足りない所だけ組む。
- 結果: `portal 済 枠 10 個・点火・入った（次元 the_nether）` ／ failed code: `no_obsidian`・`no_flint`・`blocked`・`ignite_failed`・`limit_time`・`stuck`。

## 6. smelt — かまど
- LLM が決める: 入れる物 `items`（[{item,count}]、1〜4 種類。個数は必須）と燃料 `fuel`・`fuelCount`、何基に分けるか `furnaces`（1〜4、既定 1）、使うかまどの場所 `at`（既存のかまど。最大 4。無ければ持ち物の furnace を近くに置く）、上限 `seconds`（5〜60、既定 30。入れるまでの時間）。
- 体がこなす: かまど（`at` のもの、または置いた物）へ行き、入れる物を `furnaces` 基に均等に分けて入れ、燃料を入れる（足りなければ `fuel_short`）。入れたら**手は終わる（焼き上がりは待たない）**。焼き上がる予定を体の `activeFurnaces`（frame の jobs）に記録し、焼き上がった時に頭へ出来事として知らせる（frame の events に `かまど (x,y,z) の焼きが終わった` を 1 回。既存の仕組み: 条件 `furnace:x,y,z` が読む activeFurnaces を使う）。取り出しは既存の `furnace` の手(op=take)を、LLM が列の項目として出す（smelt は取り出さない）。
- 結果: `smelt 済 iron_ore×16 を 2 基に入れた（(x,y,z)・(x,y,z)）・燃料 coal×2・焼き上がり 約 80 秒後` ／ failed code: `no_furnace`・`fuel_short`・`missing`（入れる物が足りない。一覧を書く）・`unreachable`・`limit_time`。

## 見積もり（頭の `minecraftActTime.ts`。体は上限 `seconds` で止める）
天井は `seconds`（既定は上の値）＋2 秒。見込み: obsidian = 20 秒＋8 秒 × count、fight = seconds の半分、mine = 1.5 秒 × count、make = 1 秒＋0.5 秒 × count、portal = 25 秒、smelt = 6 秒＋2 秒 × 種類。
## 頭の側（`services/api`）
- 契約と検証: `contracts/minecraftActContract.ts`（`go` の欄・schema の範囲・`goProblem`）、短い書き方 `minecraftActShortHands.ts`・`minecraftActShortContract.ts`、時間 `minecraftActTime.ts`（天井は `seconds`＋2 秒、見込みは直線距離 / 4.3 m/s の 1.3 倍＋1 秒、`seconds` まで）。
- 守り（`surfaces/minecraft/minecraftLlmcGoGuard.ts`）は 2 つだけ: 行き先が地図で溶岩・火・マグマ・クモの巣のマス（または下が溶岩）でないか、`canDig`・`canPlace` が決まりに反していないか（鉱石・箱・かまど・ベッド・扉・黒曜石・岩盤・液体・村の物は掘らせない。砂・砂利・液体・火・TNT・バケツ・松明などは置かせない）。道の途中のマスは見ない（体の仕事）。go の後の手は、足の場所が分からないので地図で歩かない。
- 線引き（ライ氏の決定、2026-10-26）: 何をするか（行き先・目的・許す手・避ける物）は LLM、体は道の細部だけ。体が目標を探す・選ぶ形にはしない（ADR-0014 で外した mine-block）。
- 列と頭を呼ぶ時機: go は数十秒になる。頭は残りが判断時間の中央値（2〜8 秒）を切った時に呼ばれるので、数十秒の go では呼びが終わる頃に項目が終わる（短い act では間に合わなかった所）。
- 目録の食い違いを防ぐ: 体の実の act 定義は `tests/fixtures/minecraft-body-act-catalog-*.json` で、頭の検査に通す試験がある。体の act の形を変えたら作り直す。
