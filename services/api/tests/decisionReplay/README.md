# 判断の再現台（decision replay）

シャノンの Minecraft の頭（FCA の LLM 中心モード）の「判断 1 回」を、実走をせずに再現して、版（モデル・指示文・出力の長さ）を比べる台です。
Syzygy ADR-0014 の段 2（戦術を Sonnet、作戦を Opus に分ける）の前に、安く比べるために作りました。本番のコードは変えていません（この下だけ）。

## 何を再現するか

本番の DB（`fca_task_history`）は、判断ごとに「その判断が受け取った live（地図・脅威・直前の結果を含む）」「答え（thinking は署名だけ）」「道具の結果」を、**送った形のまま**残しています。
なので、ある判断の要求は次の部品でそのまま組み直せます。

| 部品 | どこから | 本物か |
|---|---|---|
| system（輸送の枠 + 指示文 + 知識） | 本番の部品（`createAnthropicFcaModel`）が作った物を取る。版ごとに `minecraftOwnPrompt` と `systemAppendix` を変える | 本物（この branch の 3008876 の指示文と、専用の指示文） |
| 道具 | DB の checkpoint が持つ、その run の core の道具の定義 | 本物（実走32・33 は当時の定義: mc.act の説明が 185 字、plan.update が 173 字短い） |
| 履歴（epoch の始まりから、この判断の手前まで） | DB の行（entries）そのまま。署名つきの thinking だけ全版で外す | 本物 |
| この判断の live | DB の行の `system clear_at` | 本物 |
| epoch の始まりの bootstrap | 最後の epoch は DB に残る本物。それ以外は本番と同じ要約器（Haiku）で作り直し | 最後の epoch だけ本物。他は近似（下） |

**確かめ**: 実走34 の最初の epoch は、再現した要求の文字数が journal の `fca_request_size.requestCharacters` と**1 文字も違わない**（`decisionReplay.test.ts`）。最後の epoch（本物の bootstrap）を含めた 32 判断中 30 が一致（残り 2 は +0.2% 大きく、原因は未確認）。

## 近似している所（弱い所）

- 実走32・33 の場面には、本番がその時使った指示文（r7・r8）ではなく、3008876（r9）の指示文を使う。履歴と live はその時の物。
- bootstrap を作り直した epoch（実走32 の 2・3 番目の epoch、実走33 の 2〜4 番目、実走34 の 2 番目。場面 32 のうち 14 は最初の epoch で bootstrap が無く全部本物、18 が作り直しの bootstrap を使う。本物の bootstrap の epoch の場面は無い）は、本物と同じ形（要約 + 直近 8 ラウンドの公開記録）だが要約の文面は違う。最後の epoch で作り直しと本物を比べると、作り直しの方が 25〜33% 長い（18.9k対14.7k、14.2k対10.7k、19.6k対15.7k 字）。
- 署名つきの thinking を全版で外す（本番は先頭が同じなら残る。外しても本番の `thinking_dropped:prefix_binding_mismatch` と同じ扱いになる場面が多い）。V1 は本番より少し履歴が少ない。
- キャッシュは 5 分（本番は 1 時間）、場面の間にも印を 1 つ足して、前の場面の書き込みを読む。費用は 5 分の書き込みで数える。本番想定の費用は補正した値を別に出す。
- 時間は自分の PC から、ストリームで測る（本番は VM から、ストリームでない）。版は 3 本を並べて走らせる（Opus 2 本 + Sonnet 1 本が同時）。API 側の混み具合で 1 回ごとにばらつく。
- 場面は 3 つの実走（32〜34）の 239 判断から選んだ 32 個。同じ場面でも、実走の中の 1 点でしかない。

## 採点

- 場面ごとに `scenes/*.json`（ライ氏が見て直せる形）。`situation`（状況）・`correct`（正しい手の条件）・`hindsight`（実際に起きたこと）は文で書く。
- 機械で決まる所だけ検査の名前で書く（`checks.ts`）。
  - 自動（どの場面にも）: 体に送れる形（`llmcPrepare` が通す）、直前に止まった手のくり返し、塞がったマス・床の無いマス・1 段の上り下りで塞がる柱への walk（地図に、その手の前までの dig・place を写して見る）。
  - 場面ごと: `must`（外れたら ×）、`want`（全部通れば ○）。例: 壁の無い橋、`exposeOk` で見られるのを受け入れる、`stopIf hpBelow` が今の HP 以上、待つ act に `hostileWithin` が無い、急ぎの答え方の行（手は 3 つまで）、急ぎの先頭が安全、素手の dig に `tool:"hand"`、計画を p3 に飛ばす。
- 検査で ○ にも × にも決まらない答えと、`judge: always` の場面の × でない答えは、場面ごとに 1 回、**後知恵つき**の Opus 5.5 が採点する（`judge.ts`）。候補の出どころは伏せて混ぜる。基準は場面の `correct` と `hindsight`。
- 検査を直すと、本番の記録の答え（`recordedCheck.ts`）が実際の結果どおり ×／○ になるかを見られる（実走32・33 の死・行き止まりは ×、順調なトンネルは ○ になる）。

## 使い方

```
# 1. 本番 DB と journal を読む（VM では読むだけ。LF のファイルを cmd /c "ssh -o BatchMode=yes azure-constant-server bash -s < file" で流す）
vm/export-history.sh   > data/export1.txt
vm/export-journal.sh   > data/journal.txt
# 2. 鍵は環境に入れる（ファイルに書かない）: SHANNON_ANTHROPIC_API_KEY
cd services/api
node --import tsx tests/decisionReplay/makeBootstraps.ts        # bootstrap を作り直す（Haiku、数円）
node --import tsx tests/decisionReplay/count.ts all              # count_tokens（無料）→ data/counts.json
node --import tsx tests/decisionReplay/plan.ts 2                 # 費用の見積もり
DECISION_REPLAY_CAP=7.4 node --import tsx tests/decisionReplay/run.ts --reps=2 [--variants=v1,v2] [--scenes=s01,s02]
node --import tsx tests/decisionReplay/judgeAll.ts               # 後知恵つきの採点
node --import tsx tests/decisionReplay/report.ts                 # 表（data/report-tables.md）
```

- 版を足す: `request.ts` の `VARIANTS` に 1 行（モデル・専用の指示文か・短い出力か・effort）。上げる条件の違いは、場面の連なりが要るので別の流れ（`run.ts` の `chain`）になる。
- 費用は `data/ledger.jsonl` が呼び出しごとに数え、`DECISION_REPLAY_CAP`（既定 8 ドル）を超える前に止まる。`run.ts` は、残りの 2 回目まで走らせても上限に収まらないと見たら、2 回目をやめて全場面の 1 回目を優先する。
- 場面を足す: `scenes/` に JSON を足す（`s33-…` と同じ形）。`recordedCheck.ts` で、本番の記録の答えが期待どおりに採点されるかを見る。
- `data/`（DB の控え・journal・結果の途中）は git に入らない。結果の写しは `results/`。

## 試験

`tests/decisionReplay.test.ts`（API を呼ばない）: 地図の読み・検査・場面のファイル・要求の組み立て・本番の要求との文字数の一致。控え（`data/export1.txt`）が無い所では、それを使う試験は飛ばす。

## 10/23 の追加: 送る前の守りと r10 の比べ、v8（絞った形）

- 守り（`src/surfaces/minecraft/minecraftLlmcPreflight*.ts`、branch `codex/shannon/act-preflight` 4f98156）の確かめ: `preflightEval.ts`。本番の記録（実走27〜34 の mc.act）に守りをかけ、体の実際の結果の行と照らして「体が済にした手を止めた数」を数える。地図は act を送る時に体が持っていた最新の地図の見積もり（直前の act の終わりの地図）。`exportPreflightFixture.ts` が試験の控え（`tests/fixtures/act-preflight-*.json`）を作る。
- 場面を足す: `vm/export-history-27-31.sh`（VM は読むだけ）→ `data/export2.txt`、`makeScenes.ts`（実走27〜31 の 13 場面を本番の記録から文にする）、`makeBootstraps2.ts`。run は `allRuns.ts` が実走27〜34 を引く。
- 版: v4（`r10Live.ts`: 止まりの補足 H3 を履歴と lastResults に、線上のマス H5 を urgent の行に。H2 は作れない）、v5（v4 の答えに守りをかけ、止めたら事実を tool_result で返して 1 回だけ聞き直す）、v6（effort high。Opus 5.5 は thinking を切れない）、v7（Sonnet + 守り）、v8a〜d（`slim.ts`: 道具 6 つ → + 知識の段 → + 履歴の要約 → + 短い書き方 `shortHands.ts`）。
- 回す: `run2.ts`（v1/v2/v4/v6/v7、`--variants --reps --scenes --out`）、`run3.ts`（v8）。費用は `DECISION_REPLAY_LEDGER` の帳簿に数え、`DECISION_REPLAY_CAP` で止まる。採点は `judgeAll2.ts`（`--out=judge2b.jsonl --force` で 2 回目）、表は `report2.ts`。
- 近似: 場面の地図は直前の act の終わりの地図、敵と自分の場所は live の整数（H5 の線は 0.5 ずれる）、守りは 1 回だけ聞き直す、v8 の要約は block 6 判断ごと。

## 10/23 の追加 (3): 書き直した live の比べ（情報の形で Opus の誤りが減るか）

- 点検（API を使わない）: `inspectMech.ts`（要らない欄・誤り・省略・地図の形を機械で数える）、`cellLook.ts`（live の地図のマスを引く）、`dumpReadable.ts`（場面の live を読める形で出す）、`inspectReport.ts`（人手の事実の表 + 機械の数 → 場面ごとの表と型ごとの集計）。結果は `results/decision-rewrite-inspect-20261023.md`。
- 書き直した live: `rewriteLive.ts`（欄の整理・敵の 1 行化・合算・目印の直し）と `rewriteMap.ts`（足の周り `body.around`、目的地への道 `body.route`、地図の全層を同じ範囲に）。決まりは `rewriteRules.md`。`showRewrite.ts s01` で見られる。手は決めず、場面の記録だけから作る。
- 版: v2 = 今の live（基準）、v9b = 書き直した live（指示文に `REWRITE_LEGEND` を足す）、v9c = v9b + 手の短い書き方。回すのは `run4.ts`（v2 は前の結果を使い、足りない回数だけ回す。`--dry` で要求の組み立てだけ確かめる）、採点は `judgeAll2.ts --out=judge4.jsonl --only=v2,v9b,v9c`（2 回目は `--out=judge4b.jsonl --force --scenes=…`）、表は `report4.ts`。
- 間違いの仕分け: `failDump4.ts`（× の答えを書き直した live と並べる）、`walkDistance4.ts`（塞がったマスへ walk の × を足からの距離で数える）、`sceneDiff4.ts`（場面ごとの良し悪し）。
- 結果のまとめ: `results/decision-rewrite-20261023.md`。試験: `tests/decisionRewrite.test.ts`。

## 10/23 の追加 (4): 候補の版の確かめの下ごしらえ（場面 60・頭の変換・基準 v1 の回数・候補の口）

- 場面 60（`makeScenes2.ts`、実走28・30・31・33・34 から 15 足した。`pickScenes.ts` で候補を一覧できる）: 順調に進む 9、止まった直後 3、近い敵・急ぎ 3。前の 45 は止まり・失敗に偏っていたので、足した分で偏りを減らした（60 場面の種類は `report5.ts` の 9 節）。実走27・29 は古い頭の道具・live の形で bootstrap も無いので使わない。足した 15 は良し悪しを検査ではなく後知恵つきの採点（`judge: always`）に任せる。
- 頭の変換（`headTransform.ts`）: 本番の `fcaMinecraftTools.ts` が mc.act にする順（`llmcPrepare` の形の整え → `checkedStopIf`）を、記録の live だけで写す。stopIf の点検に要る frame（体力・敵の名前と距離・届くか）は live の行から作る近似。写さない物: why の札付け、`fightRefusal`、catalog の変化、lease。`transformEffect.ts` は API を使わず、変換の前後で検査の結果がどう変わるかを数える。
- 見え方（`views5.ts` の `VIEWS`）: v1 = 生の答え、v1t = 本番の変換を通した答え。候補を足す時はここに cand（生）・candt（候補の変換を通した答え）を足す。`judge5.ts` は本番の記録 + 全見え方を場面ごとに 1 回で採点（基準と候補を同じ呼び出しで、出どころを伏せて混ぜる）、`report5.ts` が表。
- 候補の口: 版の表に `cand`、`candidateAdapter.ts`（候補の頭の関数につなぐ所。できるまで投げる）。
- 試験: `tests/decisionTransform.test.ts`。
