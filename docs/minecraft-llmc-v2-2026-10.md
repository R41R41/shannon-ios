# Minecraft 候補の版（2026-10-23、`SHANNON_MINECRAFT_LLMC_V2`）

- 決定: ライ氏 2026-10-23「改修案のとおり候補の版を作り、再現台で確かめて。本番にはまだ入れない」。改修案は Syzygy `notes/minebot-improvement-plan-2026-10-23.md`、根拠は ADR-0014 と再現台の結果（shannon-ios `codex/shannon/decision-replay` の `results/`）。
- 土台: `codex/shannon/act-preflight` 4f98156（3008876 ＋ `fix/llmc-probe-cancel-unknown` ＋ `feat/minecraft-own-prompt` ＋ r10 の頭 ＋ 送る前の守り）。この上に branch `codex/shannon/mb-llmc-cand`。
- 切り替え: `SHANNON_MINECRAFT_LLMC_V2`。既定 off。**`SHANNON_MINECRAFT_OWN_PROMPT`・`SHANNON_MINECRAFT_LLMC_PROBE`・`SHANNON_MINECRAFT_ACT_PREFLIGHT` が全部 on の時だけ on になる**（足りない時は log に理由を出して off）。off の時の要求は 4f98156 と 1 バイトも違わない（`tests/minecraftLlmcV2Request.test.ts` の digest は 4f98156 で取った）。
- 体の側の直し（目印・持ち物・biome・undefined）は Shannon の `codex/shannon/mb-llmc-cand`。頭と体の分担は r4-contract.md の「2026-10-23 03:50 頭（mb-llmc-cand）」。

## 何を足し、何を外したか

| 改修案 | 中身 | 場所 |
|---|---|---|
| 2.1 道具 | `mc.act`・`mc.probe`・`mc.view`・`plan.update`・`fca_wait`・`fca_complete` の 6 つを、この順で先頭に固定。`tool_open`・`fca_context`・目録・読む道具・goal/task/memory は出さない | `anthropicFcaCoreTools.ts`（`transientFcaTools` の `fixed`）、`minecraftLlmcWiring.ts`（`llmcMenuTool`）、`minecraftLlmc.ts`（`llmcBodyDefinitions`） |
| 2.1 system | Minecraft 専用の方針だけ（header・決まり・読み方・いつも要る知識）。下の表 | `anthropicFcaMinecraftSystem.ts`（`minecraftV2System`）、`minecraftLlmcV2Knowledge.ts`（`V2_ALWAYS`） |
| 2.1 段の知識 | 材料／ネザー／ブレイズ／パールとアイ／エンドの 5 段を、計画の今の節・次元・いる構造物・持ち物・近くの物からコードが選び、**保存される状態の 1 つの部（`stageKnowledge`）として、段が変わった時だけ**入れる（履歴に残りキャッシュされる。毎回の live には入れない） | `minecraftLlmcV2Knowledge.ts`（`stagesFor`・`stageKnowledge`） |
| 2.2 外す | `ownerClock`・`waiting`・`observations`・`recall`（想起も頼まない）・`plan.now/path`（`planNow` と同じ時）・重なった注意・今の地図で立てるマスの古い注意・次元に無い biome・`（undefined マス）` | `minecraftLlmcLiveRewrite.ts` |
| 2.2 直す | 敵 1 体 1 行、持ち物の合算、省略しない（枠を広げ、持ち物 80・敵 24）、目印の東西南北を今の足から、止まった手の周りをマスごとの座標で | `minecraftLlmcLiveEnemies.ts`・`minecraftLlmcLiveRewrite.ts`・`minecraftLlmcLiveMap.ts`・`minecraftLlmcLive.ts` |
| 2.2 繰り返し（ADR-0014 D7） | 同じ的・同じ止まりが 2 回以上の物を `body.repeat` に 1〜3 行（「同じやり直しはしない: (308,66,73) の dig は「見られる」で 2 回止まった」）。body の stops の回数・直前の act の止まった行・調べの「同じ止まりの N 回目」から。事実だけ | `minecraftLlmcRepeat.ts` |
| 2.2 足す | `around`（足の 10 マス＋水平 6 の足・頭・床）、`route`（計画の今の節の `＠x,y,z` への道） | `minecraftLlmcAround.ts`・`minecraftLlmcRoute.ts`・`minecraftLlmcWalkRules.ts` |
| 2.2 地図 | 予備として残し、全層を同じ範囲にして足の列に `^`、層の名前に足からの高さ | `minecraftLlmcLiveMap.ts` |
| 2.3 出力 | act の手を 1 手 1 行（`walk 225,57,63`）。頭が体へ送る前に今の JSON に直す。why は節の札と短い理由 | `contracts/minecraftActShortContract.ts`・`minecraftActShortHands.ts`、`anthropicFcaModel.ts`（`callInput`） |
| 2.4 部分送り | 守りが手 k を止める時、手 1..k-1 を体へ送り、k から先を事実つきで返す（手は直さず足さない） | `minecraftLlmcPartial.ts`、`fcaMinecraftTools.ts` |
| 2.4 規則の守り | 敵が見えている時に、落差 4 以上の空所の上へ壁の無い幅 1 の橋を伸ばす手を止めて事実を返す | `minecraftLlmcRuleGuard.ts`・`minecraftLlmcSurfaceLook.ts` |
| 戻した決まり（2 回目） | 再現台の A（事実はあったのに Opus が反した）と s33 から、own-prompt/基準の知識にあって候補で落ちた決まりを短い行で戻した。下の表 | `minecraftLlmcV2Knowledge.ts` |
| 外した（v2 の時だけ） | r10 の H3（止まりの補足 `stopFacts`）、H5（urgent の射手の「線上のマス」）、知識の 1 行（v2 の知識は新しく書いた）。H2（反射の最中は急ぎの act を送らない・`facts.reflexHeld`）は残した | `minecraftLlmc.ts`・`minecraftLlmcBody.ts` の `v2` |

## 再現台から呼ぶ入口（純粋な関数）

`services/api/src/surfaces/minecraft/minecraftLlmcV2.ts`。

| 関数 | 入力 → 出力 |
|---|---|
| `candidateLive(live)` | 記録の live（`liveObject` が作る物。`system` の `clear_at` の中身を JSON に読んだ物）→ `{ live, notes, stage }`。`live` は整形した live（`body.around`・`route`・`repeat` つき。段の知識は入れない）、`stage` は段の知識の文字列（保存される状態の部 `stageKnowledge` に入れる物。台では `candidateStageState(stage)` の文を履歴に置く） |
| `candidateMenuTools(core)` | 道具の定義の一覧（記録の core）→ 候補の 4 つ（`mc.act` は短い書き方）。制御の 2 つ（`fca_wait`・`fca_complete`）はモデルが足す |
| `candidateInput(name, input)` | モデルの呼び出しの入力 → 体の道具が読む入力（`mc.act` の手の行を手にする。読めない行は `書き方の誤り` 欄に入れる） |
| `candidateAct(raw, frame, taskId?)` | モデルの `mc.act` の入力と最新の frame（`state.world` の `localMap`・`position`・`health`・`nearbyThreats`）→ `{ input, fixes, problem, guard? }`。順は本番と同じ（手を直す → 形を整える → stopIf の点検 → 守り）。`guard.stopped` が true なら体に何も送らず、false で `sentHands` があれば手 1..sentHands だけ送る。`guard.text` が聞き直しの文 |
| `candidateInstructions()` / `minecraftV2System(knowledge)` | 指示文の知識 / header・決まり・読み方を前に付けた system の本文 |
| `minecraftV2Hooks()` | モデルの options（`createAnthropicFcaModel({ minecraftOwnPrompt: true, minecraftV2: … })`）に渡す物。送る要求と台の要求が同じ部品になる |

## system の大きさ（`llmcTokens`）

| | 道具 | system | 備考 |
|---|---:|---:|---|
| 本番 rel38（3008876） | 13.2k（23 個） | 30.9k | 既定 |
| 専用の指示文（4f98156、own-prompt） | 13.2k（23 個） | 8.1k | 土台 |
| 候補 | 6.2k（6 個） | 5.3k（transport 0.36k を含む。戻した決まりで最初の版の 4.65k から増えた） | 目安 3k には届かなかった |

候補の system の中身: transport 0.36k・header と決まり約 0.6k・いつも要る知識約 3.3k（決め方 0.75k・live の読み方 0.67k・地図 0.69k・落ちる 0.32k・敵と体力 0.55k・計画 0.28k）。段の知識は system の外に出た（材料 0.67k・ネザー 0.39k・ブレイズ 0.28k・パールとアイ 0.32k・エンド 0.16k。1 判断で平均 1.2k）。

## 対応表（own-prompt の知識の行 → 候補）

| own-prompt の区画 | 候補 |
|---|---|
| マイクラの体の決め方（5 行） | 決め方（4 行）。「一歩ではない／届かない」は r9 の言い方に戻した（r10 の 2 句は外す）。mc.view と mc.probe の使い分けを 1 行に。drop・体を止めない・forbid/caution は残した |
| 地図と置き方（MAP_LEGEND 込み） | 地図（予備）と置き方。記号は 1 行に詰めた。layers/surface の範囲の説明は、全層を同じ範囲にしたので外した |
| ― | **live の読み方（新）**: around・route・敵 1 行・landmarks の次元 |
| 落ちる・水・溶岩・空所 | 同じ内容を短く。footing の「押されたら落ちる」・壁付きの橋・落差 n≤3 は残した。「素手で地中は column で柔らかい列を選ぶ」は外した（probe の説明にある） |
| 敵と体力 | 同じ内容を短く。urgent の行の読み方は live の読み方へ移した |
| 計画 | 同じ内容を短く |
| 材料と手順／ネザー・要塞・ブレイズ／パール・アイ・エンド | system から出して 5 段に分けた（上） |

## 確かめたこと・確かめていないこと

- 確かめた: 型（tsc）、コードの形（code shape）、architecture、env の例、entry closures、関係する試験（下）、off の要求が 4f98156 と同じ digest。記録の live（再現台の 60 場面）に整形をかけて、落ちずに動き、1 場面あたり live が 3.7k → 5.2k（＋段の知識 1.2k）になること。
- 確かめていない: **モデルがこの形で正しく動くか**（再現台の係が測る）。短い書き方は再現台で書き方の誤り 0/42 だった。本番の API に 2 つの clear_at が続く要求は送っていない（1 つにまとめた）。体の最新の frame と記録の live の差（記録は判断の始めの frame）。

## 2 回目の直し（再現台 candidate-check-20261023.md を受けて）

承認: 2026-10-23「候補を直して台でもう一度」。

### 戻した決まり

| 行 | 置き場 | 効かせたい場面（再現台の仕分け） | 元 |
|---|---|---|---|
| `live.look` が出たら次の act の前に mc.view か mc.probe | いつも（くり返さない・追わない） | s08（look の行を飛ばして掘り、頭上に穴） | LLMC_RULES |
| 「見られる」で止まったマスを exposeOk で掘り直さない。見られない別のマスを掘る。敵のいる側へ近づく向きに掘らない・歩かない | 同上 | s02・s20（見られたマスを再び掘る、敵へ近づく掘り） | ― （ACT 説明の exposeOk の使い方から） |
| attack が「届かない」で 2 回止まった的は追わない（エンダーマン・ブレイズ・遠いピグリン）。食料・盾・金の防具が無いまま遠出して敵を追わない | 同上 | s33（エンダーマンの attack を 4 回続けた。○○○→×××） | R9 の節 |
| 置けなかった橋・床が無い道を onFail continue のまま出し直さない。支えのあるマスから順に。壁付きの橋かトンネル | 同上 | s09（置けなかった橋の再挑戦 3 回） | R8・LLMC_RULES |
| 自分で書いた注意（plan.rules・forbid・caution）に反して節を飛ばさない | 同上 | s31（p3 へ飛ばす） | R9・PLAN |
| around の「掘る (x,y,z)」は全部 dig してから walk（頭のマスだけ掘り残さない） | live の読み方 | s58 | ― |
| `body.repeat` の読み方 | live の読み方 | ― | ― |
| エンダーマンは追って歩き回らない（来るのを待つ） | パールとアイの段 | s33 | R9 |

待つ act に hostileWithin は、候補の敵と体力の節に既にある（s20 の 1 件は、再現台の変換 `checkedStopIf` が本番では足す型）。

### 新規（キャッシュされない）入力

- 段の知識を live から外し、保存される状態の部にした（`anthropicFcaStoredState.ts` の `stageKnowledge`）。段の集合が変わった時と、epoch の最初の状態でだけ書かれ、あとは履歴（キャッシュ）に残る。記録 8 本の全 560 判断で、段が変わった（epoch の最初を含む）のは 77 回（13.8%）。1 判断あたりに直すと約 150 トークン（段の文は平均 1.17k）。
- `around` の 8 方向の行から、歩ける・斜め不可の根拠（足・頭・床の 3 つ）を外し、閉じた斜めを 1 行にまとめ、足の周りの 1 マスは行の重なりを避けた。高さ別の行は 14 行 → 8 行まで、見出しは短く、落差の「以上」は 1 組に。
- 地図は全層が持つ範囲（11×11）に切り、「?」の詰め物と層ごとの目盛りの繰り返しをやめた。
- 60 場面の平均（llmcTokens）: 候補の最初の版 live 5.2k + 段の知識 1.2k = **6.4k** → 今 live **4.1k**（本番の記録 3.7k）+ 段の知識 約 0.15k = **約 4.3k**（−33%）。`body.repeat` は 12/60 場面で出て 1〜3 行。

### 聞き直し

部分送り（手 1..k-1 を送った）の後ろの文に、「手 1〜k-1 は体へ送った（結果は上の行。動いた手は書き直さない）。送った手のあと、足は (x,y,z)（地図での見積もり。体の「今」の行が正）」を足した。足の見積もりは preflight と同じ歩き込み（`standAfterHands`）で、dig の拾いなど動き先が確かでない時は「(x,y,z) の近く」。

## 3 回目: 送る前の守りを 2 つ足した（再現台 candidate-fix-20261023.md を受けて）

承認: 2026-10-23「守り 2 つを足して実走 1 本」。v2 の時だけ。部分送りと同じ形（止める手の前までは送り、止めた手から先は事実つきで返す。手は直さず足さない）。実装は `minecraftLlmcHandGuards.ts`、束ねるのは `minecraftLlmcPartial.ts` の `heldOfFrame`（手の番号が小さい方が先。同じ手なら 4f98156 の守り、規則の守り、見られた所、急ぎの順）。

| 守り | 決まり | 文の例 |
|---|---|---|
| 急ぎの手は 3 つまで（s12・s34） | 急ぎの判断（live の答え方の行が「手は 3 つまで」と言った判断）の act が 4 手以上なら、手 4 から先は送らない。急ぎかどうかは、live を作る `withLlmcBody` が task ごとに覚え（`urgentDecision(taskId)`）、tools が送る時に読む。台は `isUrgentLive(live)` で同じ判定をして `candidateAct(raw, frame, taskId, { urgent })` に渡す | 「手 1〜3 は体へ送った（…）。手 4 から先 2 手（全 5 手のうち）は体へ送っていない（送る前に止めた。手は 1 つも動いていない）: 手 4 dig: 急ぎの判断は 3 手まで（live の答え方の行）。4 手目（dig）から先は送っていない。続きは次の判断で出せる。」 |
| 「見られる」で止まったマスの掘り直し（s30・s02） | 体の `recentStops`（frame の `state.world.recentStops`）に、90 秒以内の「(x,y,z) 見られる N秒前」があるマスを、exposeOk なしで dig する手（相対の手は見ない）を送らない。exposeOk 付きは送る。見える敵は frame の `nearbyThreats` の `canSee` から | 「(308,66,73) は直前に「見られる」で止まった（12秒前。今も見える敵: blaze #7 6.0m）。開けるなら exposeOk を付ける。ほかのマスを掘るなら、見られない別のマス（敵と反対側・下の岩）を」 |

実走27〜34 の mc.act 499 に当てた数（体の実際の結果の行と照合。スクリプトは使い捨て）:
- 急ぎの手 3 つまで: 急ぎの act 47、4 手以上の act 0 → **止めた 0・誤って止めた 0**。記録の Opus は急ぎの行を守っていた（違反は候補の答えで出た物）。
- 見られた所の掘り直し: 「見られる」で止まった dig 13、同じマスをもう一度掘った手 4（age 11〜79 秒）、4 つとも exposeOk 付き → **止めた 0・誤って止めた 0**。
- どちらも記録に止める手が無いので「誤り 0」は止める場面の少なさの裏返しで、守りの有効さの証拠ではない。止める型は試験（作った frame・本物の tools）で確かめた。

## 4 回目: 守りの穴・onFail continue・立てない目的地・計画の済みの順（実走35 を受けて）

承認: 2026-10-23「直してゼロから実走」。v2 の時だけ。切（既定）の request・動きは 4f98156 のまま（`minecraftLlmcV2Request.test.ts` の digest `4ccbbf42e3d25fbb`・`8645adfd7571750b`）。実走35: 死 0・止 0、体が動いている割合 27→49%。

| 直し | 原因（実走35 の記録から） | 直し方 |
|---|---|---|
| 1. 地図の記号を体の歩きの規則どおりに読む | 守り（preflight・rule guard）・`around`・`route` は、`p` `e`（ポータル）・`Q` `R`（枠）・ネザーの `%`（イボブロック・シュルームライト）を別の物として読んでいた。体の `walkRules.ts` は、ポータルは入らない・床にしない、枠は壁、ネザーの `%` は壁 | `minecraftLlmcPreflightMap.ts` の `readLayers(map, rules)` が `bodySymbol` で読み替える（`p` `e` → 内部記号 `¤`、`Q` `R` → `$`、ネザーの `%` → `$`）。守り（`bodyRules`）・rule guard・`standAfterHands`・`around`・`route` が使う。`rules` を渡さない時は従来どおり（切の動きは同じ）。凡例に「% 葉（ネザーではイボブロック・シュルームライト。固い）」 |
| 2. onFail continue の place は止めない | 実走35 の守りの止め 25 件のうち place が 5 件（seq 1562・1613・1624・1629・1630）。どれも止めた手が `onFail=continue`（埋まったマス・支えの無いマスは体が飛ばして続ける）なのに、act ごと止めて 1 判断を無駄にした | `PreflightOptions.continuePlace`：place が `onFail: 'continue'` で守りに引っかかったら止めず、結果に「手 N place: …。onFail continue なので体は飛ばして続ける」と事実を足して全部送る（以降の手は見ない）。止めるのは onFail が stop の place と walk・dig の手だけ。`candidateAct().note` にも出る |
| 3. 立てない目的地 | `route` の目的地を節の `＠x,y,z`（幹・岩のマス）そのままにしていた。walk は「そのものには立てない」（一歩ではない）で止まる（実走35 で 23 回） | `routeLines`：目的地のマスが地図で固い・入れないなら、隣の立てるマス（掘りが少ない・近い順）を行き先にし、「目的地のマス (x,y,z) は固い（# 石の類）。隣の立てるマス (x,y,z) を行き先にする」の 1 行を足す。立てるマスが無ければ「隣の立てるマスは地図に無い」。守りは、固い目的地の walk を止める文に「（隣の立てるマス (x,y,z)）」を足す（v2 の時だけ） |
| 4. 計画の済みの順 | 計画の木（task 425dd006）で p2 `at:310,66,74~10@nether` が開始直後（p1 が未了）に、p5 `dim:overworld` が食料の往復の最中（p3 が未了）に済みにされた。場所・次元の述語は、通り道で真になるだけで、前の仕事が済んだ印ではない | `nodesSeenDone(tree, facts, inOrder)`：v2 では、場所・次元だけで済みと見える節は、自分の祖先を除く前の節がすべて済み・ブロック・この回で済みになった時だけ閉じる。持ち物で見える節（`have:`・`food>=`）は今までどおり |

### 実走35 の記録に当てた数（体の結果の行と照合）

- 守りの止め 25 件（部分送り 22・全部止め 3）→ **20 件**（place 5 件が止めでなくなる。部分送り 22 → 19、全部止め 3 → 1）。
- 疑いの 5 件（seq 1562・1613・1624・1629・1630）は **5 件とも止めでなくなる**（5 件とも止めた手が `onFail=continue` の place）。体の結果では、同じ手を後から出し直した act（1563・1614・1625・1627・1631）の place の手を体は済ませている（飛ばして続ける、が体の決まり）。
- 残る止めは walk の「一歩ではない」18 件と急ぎの 3 手まで 2 件。walk の 18 件は、体の結果でも同じ所で止まった物が多い（体の止めは 23 件）が、frame（地図）は記録に無いので、1 件ずつの再判定はしていない。seq 1631 の walk（`warped_wart_block` に頭が当たる）は、ネザーの `%` を壁と読むので、送る前に止まる。

### 体の側に渡すもの

- 地図の記号が分けられていない物：`%`（葉／ネザーの `*_wart_block`・`shroomlight`）、`P`（板・トラップドア／看板・感圧板）、`D`（開く扉／鉄の扉）、`+`（柵・板ガラス／フェンスゲート）。頭は `%` をネザーでだけ壁と読み替えているが、地上の葉は壊して進める物として残した。体の `symbolFor` で分けてもらえれば、頭は読み替えを外せる。

## 5 回目: 黒曜石づくり・出発の点検の順・計画の子の節・持ち物の満杯（実走36 を受けて）

承認: 2026-10-23「直して、ゼロからもう一度」。v2 の時だけ。切（既定）の request・動きは 4f98156 のまま。実走36（rel40・ad92f5f）: 死 0・停止 0、序盤の節目は今までで一番早い（ベッド 68・鉄のツルハシ 209・ダイヤのツルハシ約 895・水バケツ 1,103 秒）が、ネザーには届かず（1,683 秒で取り消し）。損の大半は黒曜石づくりの約 470 秒。

| 直し | 原因（実走36 の記録 task 40bd0b3e から） | 直し方 |
|---|---|---|
| 1. 黒曜石づくり | 置いた水 (251,-24,208) が自分の階段の通路へ流れ（流れ 5）、水中の dig は 1 マス 6〜7 秒、汲み戻しの use が 7 回「目との間が deepslate」「視線が届かない」で通らず、溶岩の隣の dig は「溶岩が流れ込む」と「届かない」が交互。頭の live は水の源・流れ・届くかを持たず、守りは use の届きを見なかった | `minecraftLlmcLiquid.ts`：`body.liquid`（水の源・流れの数、近い源ごとに目から何 m・届くか・間のブロック、溶岩、黒曜石、水中の dig の実測 6 秒）を地図から作る。守り `useReachStop`：バケツの use が目から 5.0m より遠い、または目との間に固いブロックがある時は、そこまでの手を送り、その手から先は事実を返す（前の手が dig・place・ゆるい walk なら見ない。正確な walk は着く先から判断）。知識は 1〜2 行（水は通路の外・溶岩の上か横の囲まれたマスに置く／バケツの溶岩を枠に流し込んでもよい） |
| 2. 出発の点検の順 | ゲートの前の「準備の不足」が食料 100 点・鉄の防具 4・水入りバケツを求め（`nether_entry`）、既定の計画のゲートの節にも食料 100 点の子があった。合格の物差しは「30 分以内にネザー」 | v2：`nether_entry` を盾・剣・鉄以上のツルハシ・足場 64、食料 40 点に（`ENTRY_V2`）。既定の計画（`gateFirst`）からゲートの食料 100 点の子を外し、村のベッドは 1〜2 つに。最初の計画の知識（`GATE_FIRST_KNOWLEDGE`）：ゲートの前は鉄のツルハシ・盾・剣・水入りバケツ・黒曜石・火打ち金・足場・食料 40 点まで、点検（作業台・ハーフブロック・金の防具・食料 100 点）はネザーに入った後の節。奥（要塞）へ行く前に済ませる順（`nether_deep`）は変えない |
| 3. 計画の子の節 | p1 `have:bed>=3`（104 秒）・p4 `have:iron_chestplate`（鉄が箱で足りた）が持ち物の述語で親だけ済みになり、子（p1.3・p1.4・p4.1・p4.2）は `continue` のまま。計画の木のコード（`doneAbove`）は子を次に選ばないが、状態は「やることが残っている」と見え、app の一覧にも出る | `closedUnder`：v2 では、済みの親（今回済みにした物を含む）の下に開いたまま残る子を、`state: done`・note「不要になった（p1 が済んだ: have:bed>=3）」で閉じる（blocked は触らない）。ログに `closed=p1.3←p1,…` |
| 4. 持ち物の満杯 | 階段掘りで丸石 121・閃緑岩 65・深層岩の丸石 154 を拾い続け、満杯の止め 3・drop だけの act 4・形式違反の drop 1（約 100 秒）。dig には `collect: false`（拾いに歩かない）が既にあった | `minecraftLlmcPack.ts`：`body.pack`（持ち物の空き n マス＝36−使用スタック（ほか N 件を足す）、石や土が 3 マス以上を占めるなら合計と上位の内訳）。act の説明の dig に「collect=false: 掘るだけで拾いに歩かない。丸石・土を掘り進む時に付ける」。手の型は足していない |

### 足した事実の行（実走36 の座標で作った場面）

```
水: 源 1 マス・流れ 4 マス（足の周り 7 マス内）。水中のマスの dig は 1 マス 6 秒ほど（空気中は約 1 秒）、流れの中の walk は同じマスで進めないことがある
水の源（汲み戻せる）: (251,-24,208) 目から 5.1m・届かない（4.5m まで）
溶岩: 源 2 マス・流れ 0 マス。近い源: (252,-24,209) 目から 6.5m・届かない（4.5m まで） / (253,-24,209) 目から 7.2m・届かない（4.5m まで）
持ち物の空き 9 マス（使用 27/36。満杯だと dig・pickup が「満杯」で止まる）
掘って拾い続けた石や土 379 個（cobbled_deepslate×154・cobblestone×121・diorite×64・dirt×40）が約 6 マスを占める。dig は拾いに歩く (collect 既定 true)。使わない掘りは collect=false
```

守りの止めの文: 「bucket の use: (251,-24,208)（w 水） は目から 5.1m（use・sight・place は 4.5m まで）。(251,-24,208) の 4.5m 内に立ってから use する（先に walk）」「bucket の use: 目から (251,-24,208)（w 水） への線の間に (249,-23,206) # 石の類 がある（use は目からそのマスの面が見える所で。間のブロックを先に dig するか、見通せる立ち位置へ）」。

### 計画の順の前後（実走36 の木 rev 21）

- 前：p1・p4 が済みで、p1.3・p1.4・p4.1・p4.2 が `continue`（済み 15/41）。
- 後（v2）：その 4 節が「不要になった（親 …）」で閉じる（済み 19/41。親が済んだ時点で閉じるので、実走中は p1 の済み（104 秒）で p1.3・p1.4 が、p4 の済みで p4.1・p4.2 が閉じる）。
- 地図の記号・測定の限界：実走36 の live（地図の全文）は記録に無いので、黒曜石の場面は act と結果の座標から作った地図（`minecraftLlmcV2Round5.test.ts`）。守りの「間のブロック」は直線を 0.1m 刻みで見た近似で、体の `solidBetween` と同じ結論とは限らない（5.0m を超える届かないは地図だけで決まる）。

### 体の係に合わせた所

- 届く距離: 体の dig の文は 5m、sight・use・place は 4.5m。頭の事実の行と守りは use に 4.5m（止めるのは 5.0m 超の明らかな物だけ）を使う。体が dig の文を 4.5m に揃えたら、頭の説明の「4.5m」はそのまま合う。
- 地図の記号の分け（% / P / D / +）：実走35 から変わらず体の側の仕事（頭はネザーの `%` だけ壁に読み替えている）。
- 「同じマスで 4 秒進めず」の元の行：体が止まりの行に出したら、頭の `repeat` に出る。頭の側は変えていない。

## 6 回目: 体の 2 回目（mb-llmc-cand 974c19f、本体 cd28661）に合わせる

承認: 実走36 の直しの続き。v2 の時だけ。切の request・動きは 4f98156 のまま（`MAP_LEGEND`、プローブの説明は切のまま）。

| 体の変更 | 頭の合わせ方 |
|---|---|
| 1. 届く距離は 5.0 に 1 つ（目＝足 +1.62 からマスの中心まで。dig・place・use・chest・furnace・craft） | `USE_REACH = 5.0` の 1 つ（前の 4.5 と 5.0 の 2 段をやめた）。バケツの use が目から 5.0m 超なら止める（体は試さずに止める所と同じ）。v2 の知識の「4.5m 内へ寄る」→「5m 内」、act の短い書き方の craft（4.5m→5m）、v2 のメニューのプローブの説明（sight「4.5m で届くか」→「5m」）。切のプローブの説明は 4.5m のまま |
| 2. 地図の凡例が変わった（`%` は葉だけ、`Y` `A` `J` `K` `b` `q` が増え、`P` `D` `+` の中身が変わった） | `MAP_LEGEND_V2`（体の `MAP_LEGEND` を一字一句。試験で体の 974c19f の凡例の写し `fixtures/body-map-legend-974c19f.txt` と比べる）。v2 の知識の記号の行はこの凡例の記号の行そのまま（層の範囲は v2 の地図の物）。`MAP_LEGEND`（切）は変えない |
| 　 守り・around・route の記号の分類 | `readLayers(map, BODY_RULES)` の読み替え：`p` `e`→入らない・床にならない、`Q` `R` `P` `B`→壁、`+`→壁（床にならない、`FENCE`）、`D`→`A`（歩きで開ける、床にならない）。`Y` `K` `b` は壁、`A` `J` `K` は床にならない（共通の集合に足した：新しい文字なので切の地図は変わらない）。`%` は葉だけ（壊して通る）、`q` は通れる、`h` `t` `=` `k` も通れる。体の 6 つの分類（通れる／歩きで開ける／歩きで壊す／壁／入らない）を試験で 1 記号ずつ確かめる |
| 　 前に入れた「ネザーの `%` は壁」 | **外した**。体の `symbolFor` は葉（`*_leaves`）だけ `%`、ウォートブロック・シュルームライトは `Y`（壁）。次元で読み替える必要が無くなった（`BodyRules` から `nether` を消した） |
| 3. walk の止まりの文の形（足のマスは 足 …・頭 …・下 …。体: 水の中。経路探索は…） | 頭が止まりの文を読む所は `repeat`（止まりの語と最初の座標「今 (x,y,z)」）だけで、先頭は変わらない：数え方は同じ（試験）。守りの文（`足のマス … の下は …`）は頭が自分で作る物で、体の文を読んでいない。v2 は H3（`stopFacts`）を使わない |
| 4. probe around の `answer.water`（源・流れ、近い 3 つの at・distance・eye・level・reach・visible） | **頭の `body.liquid` は地図の `w` `-` と足の位置から作る物のまま**（毎判断・probe を待たず・純関数なので再現台でも同じ）。体の `answer.water` は probe の答えとして tool result に出るだけで、live には写さない（二重に出さない）。違い：頭は地図の中（水平 7 マス）、体は半径 16 まで・実世界で「間に壁」を確かめ・流れの level を持つ。定義は同じ（目から中心まで 5.0 以内・目から中心への線に固い物が無い） |

- 凡例が長くなった分、v2 の固定の指示は約 +0.4k トークン（試験の上限 5.2k→5.8k）。
- 体の `symbolFor` と頭の読み替えの一致は、体の分類表（記号ごとの 5 つの扱い）を 1 記号ずつ頭の `blocked`・`noFloor` に当てて確かめた（`minecraftLlmcV2Round6.test.ts`）。体の `walkRules.cellWay` そのものを頭の試験で動かしてはいない（別の repo）。

## 7 回目: 鉄の数・かまど・近い溶岩・ポータルの walk・ベッド（実走37 を受けて）

承認: 2026-10-23「直してゼロから実走38」。v2 の時だけ。切（既定）の request・動きは 4f98156 のまま。実走37（rel41）: **新しい作りで初めてゼロからネザーに入った（2,335 秒）**。30 分には 535 秒届かず。死亡 0・停止 0。

| 直し | 原因（実走37 の記録から） | 直し方 |
|---|---|---|
| 1 鉄の数 | 作戦の知識の「鉄 24〜36」に従い鉄 24〜25 個を集め、鉄の全身を作った（372〜1,036 秒、約 660 秒）。ネザーに要るのはツルハシ 3・バケツ 3・盾 1・火打ち金 1 の約 10 | 既定の計画（`gateFirst`）：「鉄（ネザーの前は約10）」doneWhen `have:iron_pickaxe&have:bucket&have:shield`、「鉄を約10個掘る」、鉄の全身の防具の子を外す。最初の計画の知識（`GATE_FIRST_KNOWLEDGE`）：ネザーの前の鉄は約 10、防具は箱で見つけた物か余裕がある時だけ。段の知識（prep）に同じ 1 行 |
| 2 かまどで立って待たない | 鉄 22 個を 1 つのかまどに入れ、wait×6 で 175 秒立って待った（855〜1,030） | `furnaceWaitNote`：合わせて 10 秒以上の wait の act に、フレームの `jobs`（`waiting_external`、残り秒）から「かまどの焼き上がりまで (x,y,z) の raw_iron×22 はあと約 151 秒。立って待たず、その間に掘る・集める・作る手を入れられる」を結果に添える（act は止めない）。知識 1 行 |
| 3 近い溶岩を使う | 10m 先の覆い 1 枚の溶岩 (173,-16,147) があったのに、走査で見えた 85m 先の自然の黒曜石へ階段で向かい約 260 秒 | 黒曜石の節の時、`body.obsidian`：近い溶岩の源と自然の黒曜石を、地図・目印（landmarks）・走査の行から、足からの距離と読んだ所つきで並べる（「溶岩の方が近い」）。実測の目安（階段 0.5〜0.9 マス/秒、1 個目 30〜50 秒、黒曜石の dig 約 9 秒）。知識 1 行（20m 内に溶岩があれば水で固めて作る方が早い） |
| 4 ポータルのマスへの walk | ゲートの内側 (229,-54,196) への walk を「塞がっている」と見て止めた（+2,308、約 6 秒の無駄）。守りの地図でポータル（`p`）は入らないマス（`¤`）にしていた | 守りは、walk の目的地がポータルのマスそのものの時は止めない（v2 の時だけ。入るための walk） |
| 5 余分なベッド追い | 実走36（85 秒）・37（約 90 秒）とも、3 つ持っているのにベッドを追った。p2.1 が 130 秒に済みなのに act が 8 回続いた | 既定の計画の「食料とベッド」を `food>=40&have:bed>=1` に（村のベッドは 1〜2）。最初の計画の知識に「ベッドの節の doneWhen は have:bed>=1」。ベッドを 2 つ以上持つ時は `body.pack` に「ベッドは足りている（n）。これ以上取りに行かない」（エンドの節では出さない）。段の知識の「ベッドを全部」を「1〜2 つで足りる」に |

- 計画の前後（既定の計画）：
  - 鉄：前「鉄（24〜36）」`have:iron_ingot>=24|have:iron_chestplate&have:iron_pickaxe&have:shield`・子 3（掘る・焼いてツルハシ/バケツ/盾・全身の防具）→ 後「鉄（ネザーの前は約10）」`have:iron_pickaxe&have:bucket&have:shield`・子 2。
  - ベッド：前 `food>=40&have:bed`・「ベッド全部」→ 後 `food>=40&have:bed>=1`・「ベッド1〜2」。
- 体の側：`jobs` の形（`status`・`remainingEstimateMs`・`position`）は体の `backgroundJobs` のまま。**止まりの行が約 140 字で切れて新しい元の文が読めない**（実走37 の G5、体の係の仕事）ので、頭の側は読んでいない。水中の黒曜石の dig（約 190 秒）は今回触っていない。
