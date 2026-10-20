# Minebot の区間タイムアタック（練習場）

シャノンの体（Minebot）と頭（shannon-ios）を、30 分の実走の代わりに **区間ごと** に何度も測るための道具です。
本番の VM（azure-constant-server）の `~/minecraft/shannon-home/trials/` に置いて、azureuser のまま動かします。
Python 3.12 の標準ライブラリだけを使います（`python3 -I trials.py ...`）。

## 何をするか

1. 区間の始まりの状態を作る
   - 決まった種の **まっさらなワールド**（`pristine/<種>/world`、下見の時に作った写し）を `shannon-home/trial_live` に写す。
   - `server.properties` の `level-name` を `trial_live` に、`world-id` を `trial-<種>-s<区間>-<時刻>` に替える。体の場所の記憶は試しごとに分かれる。
   - サーバーを `start.sh` で起こし、運用 CLI の `login` で体を入れる。
   - 運用者のコマンド（RCON）で、持ち物・装備・時刻・天気・体力を区間の始まりにそろえる。位置は世界のスポーン。
2. 運用 CLI の `request` で「エンドラを討伐してください」を頼む（上限は 1 区間 300 円、時間は区間の上限＋2 分）。
   `agent_tasks.goal` が 13 文字で届いたかを確かめて、結果に `goalOk` として残す。
3. 5 秒ごとに RCON で持ち物（`clear <体> <物> 0` で数える。着ている防具も入る）・次元・死んだ数を見て、節目の時刻を記録する。
4. 終わりの条件（区間の「end」の節目がすべて済んだ）・時間切れ・費用の上限・死亡・タスクの終わり のどれかで止める。
   止まっていなければ `cancel`、止まらなければ `release`。そのあと `logout`、サーバーを `stop.sh` で止める。
5. 1 回のまとめての実行（バッチ）が終わったら、`level-name`・`level-seed`・`world-id`・`server.properties` を控えのとおりに戻す。

**本番のワールドのフォルダ（`shannon_home`）は、動かさず、書きもしません。** 戻し忘れに備えて、始める前の設定を `state.json` と
`backups/` に控えます。途中で止まった時は `python3 -I trials.py restore` で戻ります（SIGTERM でも戻します）。

運用 CLI の受け付けは、全員で 1 時間 20 件までです（`OPERATOR_LIMITS.requestsPerHour`）。1 区間で `login`・`request`・`logout` の 3 件
（止まらなかった時は `release` も）を使うので、空きが足りない時は待ちます。サーバーの起動と停止は運用 CLI を通さず、
`start.sh`・`stop.sh` を直接呼びます（体が使うのと同じスクリプト）。目安は 1 時間に 5〜6 区間です。

## 区間（`sections.json`）

秒は依頼からの経過。目標は、ライ氏の節目の目標（2026-10-20：鉄のツルハシとバケツ 420・ベッド 600・鉄の全身 780・ダイヤのツルハシ 1,200・
黒曜石 1,500・ゲート 1,650・ネザー 1,800 秒）の差です。ゲームの時刻は、夜明けから始めた実走でその時に当たる時刻です。

| 区間 | 始まりの持ち物 | 時刻 | 終わり（すべて） | 目標 | 上限 |
|---|---|---|---|---|---|
| S1 ゼロ→石器 | なし | 0 | 石のツルハシ | 150 秒 | 6 分 |
| S2 石器→鉄のツルハシとバケツ | 石のツルハシ・石の斧・作業台・原木 4・板 4・棒 4・丸石 12 | 3000 | 鉄のツルハシ、バケツ | 270 秒 | 10 分 |
| S3 鉄のツルハシ→鉄の全身と予備のツルハシ＋ベッド | 鉄のツルハシ・石のツルハシ・石の斧・バケツ・かまど・作業台・石炭 4・丸石 20・原木 4・棒 4・パン 3 | 8400 | 鉄の 4 部位、ツルハシ 2 本、ベッド（持ち物かリスポーン） | 360 秒 | 14 分 |
| S4 鉄の全身→ダイヤのツルハシ | 鉄の全身（着る）・鉄のツルハシ 2・石の剣・石の斧・バケツ・白いベッド・作業台・かまど・石炭 8・丸石 32・原木 4・松明 8・焼き牛 6 | 15600（夜） | ダイヤのツルハシ | 420 秒 | 12 分 |
| S5 ダイヤのツルハシ→黒曜石 10→ゲート→ネザー | S4 の物＋ダイヤのツルハシ・水入りバケツ・鉄インゴット 2 | 1000 | ネザーに入る | 600 秒 | 15 分 |

途中の節目（原木・作業台・かまど・鉄の原鉱・各防具・ダイヤ・黒曜石 1/10・火打石・ゲート（黒曜石を 8 個以上置いた）など）も時刻を残します。
節目は一度でも満たせば済み（後で減っても戻らない）です。

## 種（`seeds.json`）

下見（`scout`）で、スポーンから 96 ブロックの中を実際に作って数えた事実です（村・イグルー・荒れたポータルは `locate`、
溶岩・原木・鉱石・羊は保存されたチャンクを読んで数えます）。区間ごとに条件の違う 3 つを選んで `sections.json` の `seeds` に書きます。

## 回し方

```bash
cd ~/minecraft/shannon-home/trials
python3 -I trials.py scout --key r19-snowy --seed 5313593320881658764 --note 'run19'   # 種の下見（1 つ 約 2.5 分）
python3 -I trials.py run --dry-run --sections 1 --seeds r19-snowy                     # ワールドの入れ替えだけ（運用 CLI も費用も使わない）
nohup python3 -I trials.py run --sections 1 --seeds r19-snowy > results/run.log 2>&1 &   # 1 区間（Sonnet、下を参照）
nohup python3 -I trials.py run > results/run.log 2>&1 &                                  # 全区間 × 各 3 種
python3 -I trials.py report                                                             # 一番新しいバッチの表
python3 -I trials.py restore                                                            # 途中で止まった時の戻し
```

- `--model sonnet`（既定）：バッチの始めに `api.env` に `SHANNON_FCA_MODEL=claude-sonnet-5-5` を 1 行足し、6 サービスを順に再起動する。
  終わりに（失敗・中断でも）その 1 行を消して再起動し、控え（`~/shannon-ios-data/deploy-backups/trials-sonnet-<UTC>/api.env`）との一致・
  mode 0600・API の環境に `SHANNON_FCA_MODEL` が無いことを書き出す。`--model current` は env を触らない。
- **env の変更と再起動を伴うので、`run` は毎回、先にメインのセッションへ知らせて了解を得てから動かす。**
- 費用：1 区間は API の上限（`--budget-yen 300`）で止まる。バッチは、使った額＋次の 300 円が 3,000 円を超える前に止まる。
- 依頼の前に止める物：動いている Minecraft のタスク、体の実験（`minecraft-campaign-live-probe`）、サーバーに誰かいる。

## 結果

- `results/<バッチ>/<バッチ>-s<区間>-<種>.json`：秒・判断の数（`fca_task_history` の行）・道具の数と失敗・費用（`fca_task_budget.yen`）・
  節目の時刻・最初に見えた時刻・足りなかった物・止まった理由・最後の状態・`goalOk`。
- `results/history.jsonl`：すべての試しを 1 行ずつ。
- `results/<バッチ>/report.md`・`report.json`：区間 × 種の表。同じ区間と種の **前回** の秒と差（5 秒より速い・遅い・同じ）を並べる。

止まった理由：`reached`（達成）、`time_limit`、`budget`、`died`、`task_<status>:<理由>`、`login_failed:<code>`、`request_refused:<code>`。
