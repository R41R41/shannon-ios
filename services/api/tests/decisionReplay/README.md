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
