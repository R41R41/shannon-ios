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
   タスクの一時停止（paused）は、90 秒続くか「止まった」になるまで終わりと見ない（`fca_unknown` の止まりは、体の確かめ直しで数秒のうちに
   再開されることが多い。10/20 の 1 回目はここを終わりと見て、再開した最中に logout した）。
   タスクが体を放す（終わる、または paused・stopped になる）まで体はログインしたままにして、`cancel`、それでも放さなければ `release`。
   そのあと `logout`、サーバーを `stop.sh` で止める。その試しの journal の `Shannon FCA step unknown` の code も結果に残す。
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

止まった理由：`reached`（達成）、`time_limit`、`budget`、`died`、`task_<status>:<理由>`、`login_failed:<code>`、`request_refused:<code>`、
`fail:<規則>`（S6〜S11 の `failIf`）、`setup_failed:<準備の手>`・`setup_failed:preflight:<確認>`（依頼の前。費用 0）、`no_sites:<足りない場所>`。

---

# 種の下調べ（`seedscan.py`）— 2026-11-02 追加

ライ氏が「条件の良いシードを選ぶ」を選んだ時に、すぐ使える候補を **事実の表** にする道具です。本番の `shannon_home` にも `shannon-home` のサーバーにも触りません
（`~/.cache/minebot-lab/seedscan/` に使い捨てのラボサーバーを 127.0.0.1:25570+枠 で立て、RCON は +1000。VM のラボの雛形 `~/minecraft/1.21.11-fabric-test` を使うので、
バージョンは本番と同じ 1.21.11 の Fabric）。標準ライブラリだけの Python 3.12（`python3 -I seedscan.py ...`）。

| 段 | 何をするか | 1 本 | 対象 |
|---|---|---|---|
| A1 | vanilla の `/locate` と `execute if biome`。スポーンのバイオーム、村（`#minecraft:village`）、陸の廃ポータル 5 種、ピリジャーの前哨、ネザー側（スポーン÷8）の要塞・砦・歪んだ森・クリムゾン、1 輪目のストロングホールド 3 つ（原点から 1,408〜2,688m の輪。8 方向×2 半径から `/locate` して集める）。村が 350m 超・スポーンが海/山頂/きのこ/ジャングル/マングローブは足切り | 約 20〜60 秒 | 全部 |
| A2 | A1 の仮の点が 45 以上のもの：村とストロングホールドまでの直線（96m 刻み）の海（`locate biome #minecraft:is_ocean`）、ストロングホールドの上の海、海底神殿との距離 | +5 秒 | 仮の点が高いもの |
| B | 実際にチャンクを作らせ、保存して領域ファイル（NBT）を読む：スポーン 96m 内の地表の溶岩・原木・鉱石・動物、村のベッド・畑・箱（戦利品表ごと）・動物、廃ポータルの溶岩・黒曜石・箱、ストロングホールドの枠 12 個（位置・向き・目玉）と部屋・地下の深さ・上の地面、ネザーの到着地点・要塞のブレイズのスポナーと立ち位置・歪んだ森の足場 | 約 4 分 | 上位だけ |

点（0〜100）は **撮影の通し（ゼロから・支給なし・1 回で竜まで）** に合わせた私たちの判断で、内訳を表に併記します（`--profile film`。ライ氏が別の重みにしてよい。最初の表の重みは `--profile general`）：
- ネザーまでの速さ 50：村 18（60m 以内 18・100m 17・150m 14・250m 9・350m 4。道に海 −8。ベッド 3 未満 −4。畑 20 未満かつ家畜 6 未満 −5）／
  黒曜石の元 14（廃ポータル 120m 以内 14・250m 10・400m 5、または地表の溶岩 40m 以内 14・70m 11・100m 7 の高い方）／ダイヤ鉱石 3（水平 48m 以内 3・96m 1）／
  **スポーン直後の安全 15**（半径 64m の地面を読む：足元の水の割合 5%・15%・35% 超で −2・−4・−8、海まで 60m 未満 −3・120m 未満 −1、氷 3% 超 −5、凍ったバイオーム 30% 超 −5、
  深い森（暗い森・古い森・ジャングル、または 32m 内に原木 350 本超）−4〜−5、起伏（地面の高さの幅）30 超 −2・45 超 −4、地表の溶岩 12m 未満 −2）。
- ネザー 28：要塞 15（120m 以内 15・180m 13・250m 10・350m 6・500m 3）／歪んだ森 10（100m 以内 10・200m 8・350m 5・500m 2）／砦 3（200m 以内 3・400m 1）。
- ストロングホールド 20：スポーンから 1,200m 以内 12・1,600m 10・2,000m 7・2,400m 4・2,800m 2、道に海が無ければ +6（2 マスまで +3）、地下 70 以内 +2・110 以内 +1。海の上・海底神殿 150m 以内は 0。
- スポーン 2（良いバイオーム 2・まあまあ 1）／前哨 200m 以内 −5。

**資源の約束**（ライ氏の指示 2026-11-02：世界を無駄に作らない、圧迫を確かめる、不要な処理とデータは消す）
- 1 本ずつ（同時に 1 つのラボ）、Java のヒープは 1〜2GB まで。測り終えた世界はその場で消し（`deep --discard`）、事実（JSON）だけ残す。残すのは選ばれた 1〜2 本の必要な範囲だけ。
- 重い作業の前に空きを見る：PC は Windows の空きメモリ 3GB 以上・C: 10GB 以上、VM は `df -h ~` で 10GB 以上（`lab-slot.sh` が見て、足りなければ終了 6。VM のディスクが 10GB を切ったら取りまとめに知らせて止まる）。
- 使い終わったらラボを止める。PC の WSL は、止めたあとに root で `sync; echo 3 > /proc/sys/vm/drop_caches` するとページキャッシュ（5GB 台）が返り、Windows の空きが戻る。
- 「生成を伴わない方法」を先に検討した結果：村・廃ポータル・要塞の **候補の位置** は乱数の式で計算できるが、成否（バイオーム）とスポーンの位置は気候のノイズが要り、サーバー無しには正確に出せない
  （外から取る計算ライブラリは使わない）。計算だけの足切りは、村で本数を約 3 割しか減らせない見込み（見積もり。測ってはいない）。そのため /locate を 1 本ずつのサーバーで当て、足切りに通らないものは 1〜4 秒で捨てている。
  上位を決める段階（B）も、スポーン周りだけの軽い読みを先にして、全部作るのは選ばれたものだけにする。

```bash
# PC の WSL（24 コア。HOME=/home/azureuser を付けると VM と同じパスになる。ラボ側の準備は backend/scripts/lab/README.md）
wsl -d Ubuntu-24.04 -u ghrunner -- env HOME=/home/azureuser bash -lc 'cd ~/seedscan-bin && python3 -I seedscan.py scan --tag r1 --random 2000 --master 20261102 --workers 6'
python3 -I seedscan.py rank --top 14                       # A の点の順位（途中でも見られる。足切りの数も出る）
python3 -I seedscan.py deep --seeds=<シード>,<シード> --keys c1,c2 --workers 1 --heap 1G   # B（負のシードは --seeds=<...> の形）。--reuse --stages nether で一部の段だけやり直し、--discard で測ったら世界を消す
python3 -I seedscan.py report --keys c1,c2,...             # A と B をまとめた点と事実（このまま表になる）
python3 -I seedscan.py publish --key c1 --labworld         # pristine/c1/{world,facts.json,sites.json} と ~/.cache/minebot-lab/worlds/c1
# VM では先に枠を取る：bash lab-slot.sh --wait 1800 -- python3 -I seedscan.py scan ...   （backend/scripts/lab/lab-slot.sh）
```

結果は `~/.cache/minebot-lab/seedscan-out/`（`phaseA-<tag>.jsonl` に 1 本 1 行、`deep-<名前>.json`、`sites.json` を含む `pristine/<名前>/`）。WSL と VM と本番で /locate の答えは同じになる
（サーバーの jar が同じ：`versions/1.21.11/server-1.21.11.jar` の sha256 先頭 `ec47239a8de24633` が WSL・VM のラボの雛形・本番 shannon-home で一致、Fabric の起動 jar も `437be1fb0db0cec0` で一致）。

**決まったシード（取りまとめ、2026-11-02）：本命 c1（-1687609181642700084）、予備 c6（3528818900495331395）**。c1 の弱点はストロングホールドの部屋の地下 170（区間の試しで重いと分かったら c6 に替える）。
VM の `trials/pristine/` に c1・c6 を置いた（各 33〜35MB）。

- **実走（`shannon_home`）で c1 の新しいワールドを用意する（1 行）**：shannon-home を止めたまま `ssh azure-constant-server 'flock ~/.cache/minebot-lab/prod.lock bash -c "cd ~/minecraft/shannon-home && ./new-world.sh --seed -1687609181642700084"'`
  （古いワールドは `shannon_home.before-regen-…` に残り、次の起動で c1 の世界が作られる。支給・tp なしのゼロから。c6 は `--seed 3528818900495331395`。起動はいつもの `./start.sh` か運用 CLI）。

---

# S6〜S11（ネザー要塞からエンドの竜まで）— 2026-11-02 追加

S1〜S5 の続きです。**S6〜S11 は「支給あり」の診断で、受入には数えません。** 世界の決まった場所（種ごとの `sites.json`）へ体を置き、持ち物を渡し、`setblock`・`fill`・`summon` で
準備をして、運用 CLI で同じ「エンドラを討伐してください」を頼みます。支給・tp・準備は、種の世界 `trial_live`（shannon-home の別ワールド）の中だけです。本番の `shannon_home` には何もしません。

**ライ氏の確認（2026-11-02、取りまとめ経由、選択肢での回答）**：trial_live での支給・tp・時刻の変更は **診断に限り許可**。結果に「支給あり」の印を付ける。本番ワールド `shannon_home` と、
撮影の通し（支給・tp なしのゼロから）には使わない。`sections.json` の S6〜S11 は `requiresOwnerOk` で、`run` は `--owner-ok-supply "<誰が・いつ>"` を付けた時だけ回ります
（例：`ライ氏 2026-11-02 選択肢で回答（取りまとめ経由）`。`--dry-run`＝ワールドの入れ替えだけ、は無くても可）。付けた文言は結果の JSON と表の `ownerOk` に残ります。

**shannon-home を使う時は `prod.lock`**：`trials.py` の `scout`・`run`・`restore`・`env on/off` は、動いている間 `flock ~/.cache/minebot-lab/prod.lock` を持ちます（反映の再起動・実走と重ならないため。
塞がっていれば持ち主を表示して止まる。待つなら `python3 -I trials.py --wait-lock 600 run ...`）。ラボの枠の台本は、`prod.lock` が塞がっている間ラボを回しません。

**VM は Spot のまま（撮影の週も）— 止まったら途中から再開する**
- 結果はその都度保存：バッチの始めに `results/<バッチ>/plan.json`（区間×種・モデル・上限・確認の文言）、走っている区間は 20 秒ごとに `partial-<試し>.json`（節目・使った円・位置・タスク）、終わるたびに `<試し>.json` と `history.jsonl`。
- 止まった後：VM が戻ったら `python3 -I trials.py restore`（本番の設定を戻す）→ 残っている Minecraft のタスクがあれば運用 CLI で `cancel` →
  `python3 -I trials.py run --resume <バッチ>`。終わった区間は飛ばし、途中で切れた区間は `interrupted`（そこまでの節目と円を残す）として記録して、**新しい世界で最初から** やり直す。使った円はバッチの上限に数える。
  計画・モデル・上限・確認の文言は plan.json から読むので、付け直さなくてよい。

| 区間 | 開始（次元・場所） | 持ち物・準備（支給） | 成功の事実（サーバーが答える） | 上限 | 失敗の定義 | 予測 |
|---|---|---|---|---|---|---|
| S6 ネザーの到着地点→ネザー要塞 | ネザー・`netherArrival`（スポーン÷8 の近くで、溶岩から 6m 離れた足場） | 鉄の全身（着る）＋盾、ダイヤのツルハシ、鉄のツルハシ、鉄の剣、弓＋矢 32、水入りバケツ、火打ち金、丸石 64、松明 16、焼き牛 16。準備：3m 東に黒曜石の枠とポータル（`fill`）、周りの岩を空気に | advancement `minecraft:nether/find_fortress`（要塞に入った）。途中：`blazeStand` の 100m 以内・24m 以内 | 15 分・¥300 | 死亡、時間・円の上限、タスクの終わり、オーバーワールドに 30 秒 | 成功 25%・600 秒・¥150 |
| S7 ブレイズのスポナー→ロッド 6 | ネザー・`blazeStand`（スポナーから 5m の要塞の通路） | S6 の持ち物＋丸石 128・丸石のハーフブロック 8、焼き牛 24（ポータルの準備なし） | ロッド換算 6（ロッド 1・粉 0.5・目玉 0.5）。途中：advancement `obtain_blaze_rod`、換算 3 | 25 分・¥400 | 死亡、時間・円、タスクの終わり、オーバーワールドに 60 秒 | 成功 10%・1,200 秒・¥300 |
| S8a パール 12（エンダーマン狩り） | ネザー・`warpedStand`（歪んだ森の足場） | 鉄の全身＋盾、ダイヤのツルハシ、鉄のツルハシ、鉄の剣、水入りバケツ、丸石 128、松明 8、焼き牛 24 | パール換算 12（パール 1・目玉 1）。途中：1・6 | 30 分・¥450 | 死亡、時間・円、タスクの終わり、オーバーワールドに 60 秒 | 成功 5%・1,500 秒・¥350 |
| S8b 物々交換（金 40 のうち 32 を渡す） | ネザー・`warpedStand` | 金インゴット 40、金の兜（着る。ピグリンが怒らない）、鉄の胸当て・脚当て・靴＋盾、鉄の剣、丸石 64、焼き牛 8。準備：3×9 の足場をネザーラックで作り、ピグリン 3 体を `summon`（`PersistenceRequired`・ゾンビ化しない） | 金が 8 個以下（32 個を渡した）。途中：8・16 個。**パールの数は成否に使わない**（記録だけ）。金 1 個あたりパール約 0.07 個（確率 2.4%×平均 3 個）なので、32 個の期待値は約 2.2（標準偏差約 2）。試行数 32 と合格の線は先に決めてある | 15 分・¥250 | 死亡、時間・円、タスクの終わり、オーバーワールドに 60 秒、ピグリンがいない（準備の確認） | 成功 25%・600 秒・¥180（パール期待 2.2 個） |
| S9 目玉 12→三角測量→ストロングホールド | オーバーワールド・`spawn`（朝） | 鉄の全身＋盾、ダイヤのツルハシ、鉄のツルハシ、鉄の剣、鉄の斧、弓＋矢 32、水入りバケツ、丸石 64、松明 16、焼き牛 24、白いベッド、**エンダーアイ 12**、作業台、かまど、石炭 8 | advancement `minecraft:story/follow_ender_eye`（ストロングホールドの中に入った）。途中：目玉 1・3 個使った、`strongholdPortalCenter` の 200m・32m 以内 | 45 分・¥600 | 死亡、時間・円、タスクの終わり | 成功 10%・1,800 秒・¥450 |
| S10 枠の部屋→目玉 12 を置く→エンド | オーバーワールド・`strongholdStand`（枠の部屋の足場。ポータルの下は溶岩） | 鉄の全身＋盾、ダイヤのツルハシ、鉄の剣、水入りバケツ、丸石 64、焼き牛 8、エンダーアイ 12。準備：枠 12 個を全部「目玉なし」に `setblock`（生成時に入っていた目玉も取る） | 次元が the_end。途中：目玉の入った枠が 1・6・12（枠ごとに `execute if block ...[eye=true]`） | 15 分・¥250 | 死亡（溶岩）、時間・円、タスクの終わり | 成功 20%・420 秒・¥150 |
| S11 エンドの到着→竜の討伐 | エンド・`endPlatform`（100, 49, 0。黒曜石の足場は世界生成で既にある） | 鉄の全身＋盾、ダイヤのツルハシ、鉄のツルハシ、鉄の剣、弓＋矢 64、水入りバケツ、丸石 64、焼き牛 24、くり抜いたかぼちゃ、金のリンゴ 2。準備：足場の 5×5 を黒曜石・上 4 マスを空気にする（既にあれば何も起きない）。**依頼の前の確認**：竜が 120 秒以内に現れる（現れなければ開始しない・費用 0） | advancement `minecraft:end/kill_dragon`。途中：竜が存在した | 45 分・¥800 | 死亡（奈落を含む）、時間・円、タスクの終わり、エンドを出て 20 秒 | 成功 2%・2,400 秒・¥600 |

- 秒は依頼からの経過です。予測は **2026-11-02 の版（頭 2bd7788・体 8c48b7e）** に対する、先に書いた数字で、結果の表に「予測（成功）」「秒（予測 / 目標）」「費用（予測）」として並び、バッチの終わりに
  「予測の合計 ○件に対し実測 ○件」を出します。版が変わったら `sections.json` の `prediction` を書き換えて、`builds` にその版を残します。根拠は各区間の `prediction.basis`。
- 開始の持ち物は S5 の終わりと同じ程度の物に、その区間が要る道具を足した **診断用の支給** です。結果の JSON に `supplied`・`supplyKinds`（give・equip・tp・fill・summon ...）が残り、表の「支給」の欄に出ます。
- 場所は `pristine/<種>/sites.json` から引きます（`seedscan.py deep` → `publish`）：`spawn`、`netherArrival`、`blazeStand`・`blazeSpawner`、`warpedStand`、`strongholdPortalCenter`・`strongholdStand`・`strongholdFrames`、`endPlatform`。
  足りない場所があれば `no_sites:<名前>` で依頼の前に止まります。`sections.json` の読み違い（上限が 120 分を超える・未知の場所・支給なのに印が無い ...）も `run` の始めに止めます。
- **モデル**：S6〜S11 の既定は `--model current`（`api.env` も 6 サービスの再起動も触らない）。S1〜S5 と同じバッチには入れられません（別々に回す）。
- **batchCapYen**：1 区間の上限は区間ごとの `capYen`（S6 ¥300・S7 ¥400・S8a ¥450・S8b ¥250・S9 ¥600・S10 ¥250・S11 ¥800。合計 ¥3,050）。バッチは「使った額＋次の区間の上限」が
  バッチの上限を超える前に止まります。既定の `batchCapYen` 3,000 のままだと S11 が回らないことがあるので、全区間を通す時は `--batch-cap-yen 3500` のように **バッチごとに明示**（予算はライ氏の確認が要る）。
  予測の費用の合計は約 ¥1,900。運用 CLI は 1 依頼 120 分・¥2,000 までなので、どの区間もその内側です。1 時間 20 件の受け付けは 1 区間で 3〜5 件使うので、1 時間に 4〜6 区間まで。

```bash
cd ~/minecraft/shannon-home/trials
python3 -I trials.py run --dry-run --sections 6,7 --seeds c1            # 世界の入れ替えだけ（支給なし・費用 0）。種の世界は pristine/c1 が要る
# ライ氏の確認は 2026-11-02 に出ている（診断に限る）。回す時：
nohup python3 -I trials.py run --sections 6,7 --seeds c1 --model current --batch-cap-yen 1500 \
  --owner-ok-supply "ライ氏 2026-11-02 選択肢で回答（取りまとめ経由）" > results/run.log 2>&1 &
python3 -I trials.py report
```

### 回す前の点検（費用 0・モデルなし）：`sections_smoke.py`
公開した世界でラボを立て（難易度 normal）、素のクライアント `I_am_Shannon` を体の代わりに入れ、S6〜S11 それぞれで `trials.py` が依頼の前にやること（持ち物・準備・tp・事前確認）と、毎回の問い合わせ
（advancement・距離・枠・換算数・金の減り）を実際のサーバーに通す。そのあと成功の事実を作って（advancement を与える・ロッド 6 本・パール 12 個・金 32 個の消費・枠 12 個に目玉と End への tp）、
**検出されて区間が終わる** ことと、**開始の時点では終わっていない** ことを確かめる。

```bash
wsl -d Ubuntu-24.04 -u ghrunner -- env HOME=/home/azureuser bash -lc 'cd ~/seedscan-bin && python3 -I sections_smoke.py --key c1'     # 約 40 秒（pristine/c1 が要る）。VM では lab-slot.sh の下で
```
2026-11-02：c2・c6・c7 の 3 つの世界で 7/7（S6・S7・S8a・S8b・S9・S10・S11）。書き方の誤り（`@a[name=...,advancements={...}]`、`[eye=true]`、`distance=..N`）、準備の `fill`・`summon`・`tp`、
End の到着点（足場は世界生成で既にある）、竜の事前確認（`execute in minecraft:the_end if entity @e[type=minecraft:ender_dragon]`）が、サーバーで通ることまでは分かった。**体が実際にそこで何をするかは分からない**（それは有料の試験）。

### 世界を VM に置く（確認の後でよい。pristine の追加だけで、本番のワールドには触らない）
```bash
# PC の WSL で publish したもの（~/.cache/minebot-lab/seedscan-out/pristine/c1）を VM へ
wsl -d Ubuntu-24.04 -u ghrunner -- tar -C /home/azureuser/.cache/minebot-lab/seedscan-out/pristine -cf - c1 | ssh azure-constant-server 'tar -C ~/minecraft/shannon-home/trials/pristine -xf -'
```

### 窓の試し（run59 の実走の保留中だけ。本物の頭、VM の上、2026-11-02 夜に追加）
取りまとめの決め（ライ氏 11/2 19:55「巻けるところは巻く」）：S6〜S10 を run59 の道の順（要塞→ブレイズ→パール→目玉→ストロングホールド→枠の部屋）に先回りして試し、止まりを見つけて持ち主へ送る。
**回してよい時**：run59 が保留で、shannon-home が止まっていて、Minecraft のタスクが動いていない間だけ。1 区間 ¥500、合計 ¥3,000 まで。API の鍵は VM の外に出さない（試しは VM の本番のサービスの上で動くので、鍵は触らない）。
- **試すのは今本番に入っている版**です（体 `Shannon-current`・頭 `~/shannon-ios`）。S2・S3 の枝が本番に入る（S0 の反映）までは、その版で S6〜S10 が止まる所を見るだけで、後半の部品の確かめにはなりません。
  結果の JSON の `builds` に、試した時の頭と体の版を残します。
- **run59 に道を譲る**：`touch ~/.cache/minebot-lab/trials.stop` — 走っている区間が次の確認（5 秒）で `stopped_by_file` で終わり、タスクの取り消し・ログアウト・本番の設定の戻しをして止まる（約 1 分）。
  ファイルが残っている間は `run` が始まらない（始めてよくなったら消す）。区間と区間の間でも見る。`prod.lock` は終われば放される。
- 回し方（S6〜S10、c1。1 区間の上限は `--max-section-yen` で ¥500 に抑える＝S9 の ¥600 だけが下がる。合計の見込みは ¥2,150）：

```bash
cd ~/minecraft/shannon-home/trials
nohup python3 -I trials.py --wait-lock 600 run --sections 6,7,8a,8b,9,10 --seeds c1 --model current --max-section-yen 500 --batch-cap-yen 3000 \
  --owner-ok-supply "ライ氏 2026-11-02 選択肢で回答（取りまとめ経由）" > results/run.log 2>&1 &
python3 -I trials.py report          # 表と「止まりの様子」（頭の最後の手と、体から返った言葉）
```
- 止まった区間の様子：結果の JSON の `stall` に、タスクの計画の進み（`done`・次の行き先）と、最後の 4 手（頭の `mc_act` とその `why`、体から返った言葉。失敗は `ERR`）が入り、`report.md` の「止まりの様子」に出ます。
  体の止まりは S2（`local_d59198d3-234c-40f6-b62c-473188ed5c1c`）、頭の止まりは S3（`local_0300d99d-07c3-440c-9229-1883531caeca`）へ送ります。
- 体だけの確かめは PC の WSL で LLM なし：`backend/scripts/lab/s4-section-probe.sh`（S2 の hunt の場面に、c1 の道の場面 `route_fortress`・`route_stronghold`・`dig_to_room`・`frames_enter` を足したもの）。

### 隔離台（`rig.py`、本物の頭＋本物の体＋ラボの世界。run59 と並べて回せる。2026-11-02 夜に追加）
取りまとめの決め：窓を待たずに、本番の実走と並べて S6〜S10 を本物の頭で繰り返し試す場。**本番の shannon-home・体の口座・頭のサービス・DB には触らない**（別のポート・口座・DB）。API の鍵は VM の中だけで使う。
- 仕組み：1 つの Node プロセス `services/api/scripts/minecraft-rig.ts` に、頭の本物のコード（運用 CLI とソケット・タスクの実行・FCA の歩・LLM 中心の歩の部品・制御・予算）と、体の本物（`NativeCommonFcaBody` の mineflayer ボット＋`CommonFcaControlLoop`。poll は HTTP でなく制御へ直接）を入れ、
  ラボのサーバー（`seedscan.Lab`：pristine の世界の写し・難易度 normal・view 10・simulation 8・モブあり）につなぐ。頭の hold ラボ（`tests/minecraftHoldResumeLab.ts`）のモデルと体の代役を、本番のモデル（`configuredMinecraftLlmc`）と本物の体に替えたもの。
  予算は本番と同じ `fcaBudget`（運用 CLI の `--budget-yen` がその依頼の上限）。`rig.py` が 1 試しごとにラボのサーバーと rig を立て、`trials.run_trial` をそのまま回し（開始の状態・節目・上限・止まりの様子・報告は同じ）、終わったら両方を止めて消す。
- 木：**頭の木**＝試す版の `git archive`（+ node_modules を本番の checkout からハードリンク。rig の台本は上書きで置く）、**体の木**＝試す版（src・scripts・package）+ `~/Shannon-dev` の node_modules。固定して使う（その後の枝の動きに左右されない）。体側の束は pin ごとに 1 回 esbuild で作る。
- 回し方（lab-slot の決まり：`bash lab-slot.sh --allow-run --label rig -- ...`。`--allow-run` は取りまとめの判断。VM は 4 vCPU になってから＝`nproc` が 4。負荷（1 分）が 3.5 を超え続けたら `touch ~/.cache/minebot-lab/trials.stop`）：

```bash
cd ~/minecraft/shannon-home/trials
python3 -I rig.py run --head-pin ~/s4-pins/head-<sha> --body-pin ~/s4-pins/body-<sha> --sections 6,7,9,8a,8b,10 --seeds c1 --model real \
  --max-section-yen 500 --batch-cap-yen 3000 --owner-ok-supply "ライ氏 2026-11-02 選択肢で回答（取りまとめ経由）"
python3 -I rig.py run ... --model script --smoke      # 鍵なし・1 分に切った配線の試験（頭の台本のモデル）
python3 -I rig.py report
```
- 結果は `results/<バッチ>/`（試しごとの JSON・`rig-<試し>.log`＝rig の出力・`report.md`）。rig の出力の `RIG_USAGE` は有料の呼出し 1 回ごとの費用（USD）。`builds` は試した頭と体の版。

### 未確認のこと（分かっていること／仮説／不明）
- 分かっている：`execute if entity @a[name=...,advancements={...}]`・`distance`・`[eye=true]` の書き方、`/locate` の答え、End へ tp すると竜が 4.7〜7.3 秒で現れること（ラボで実測。体の観測はまだ）。
- 仮説：`trial_live` の `server.properties`（難易度 normal、view-distance 10、simulation-distance 8）では、ブレイズのスポナー・エンダーマン・ピグリンの `summon` が期待どおり動く。S7・S8 は実機で初めて確かめる。
- 不明：S6〜S11 を shannon-home で一度も回していない（確認待ち）。体がネザー・エンドで頭の計画にどう入るか、`goalEvidence`（竜の死を接続中に見る）と advancement の食い違い（弓・爆発・再接続）。
