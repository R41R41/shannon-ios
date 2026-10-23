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
