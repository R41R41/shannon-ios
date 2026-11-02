# Minecraft 後半（ネザー奥〜エンドラ）の頭の入力と通しの自律（2026-11-02、S3）

- 決定: ライ氏 2026-11-02「11/10 の撮影までに、シャノンがエンドラを討伐できる状態に」。作戦書は Syzygy `notes/minebot-dragon-sprint-2026-11-02.md`。担当は頭（この文書）、体の S1（エンド）・S2（ネザー奥・パール・要塞探し）。
- 土台: 頭 `claude/dragon-head`（2bd7788 ＋ Codex の計画の target・現在の能力・目的別の進み・待ちの期限）。切り替えは**無い**（環境変数のスイッチを付けない）。
- 方針: 判断は LLM、入力は事実を分かりやすく。コードで強制しない（強制は、観測と食い違う「済み」を通さない検査と、立て直しの回数の上限だけ）。
- 「分かっている」は実装と単体テストで確かめたこと。実機・実走で確かめたことは**まだ無い**（下の「未確認」）。
- 体の欄名は S1（`docs/minecraft-end-fight.md`、`utils/dragonState.ts`）と S2（`docs/minecraft-hunt-s2.md`、`utils/huntEyeFlight.ts`）の実際の出力に合わせた（2026-11-02、体の枝 `claude/dragon-end`・`claude/dragon-nether` を読んで）。

## 1. 頭が体の frame から読む欄（契約の受け口）

欄が無い・形が違う時は黙って読み捨てる（その行を出さないだけ）。体の欄名・単位を変える時は、先に S3 と S0 に知らせる（頭の契約と produced の同期の順番を合わせるため）。

| 欄 | 形 | 頭の使い方 |
|---|---|---|
| `observation.state.world` 直下の `dragon`・`crystals`・`perch`・`dragonBreath`・`dragonFireballs`（エンドだけ。S1 の最終形、`status/S1.json` 11/2 20:10） | `dragon: { id, health /200, phase 0〜10, phaseName, phaseFor（その phase の秒）, perched, position, yaw, distance, headPosition?, headReach（目から頭の箱の m）, strike }`（竜が見えなければ欄ごと無い）、`crystals: { remaining /10, gone, caged, list:[{ id, position:{x,y,z}, caged, distance, healing?, blast? }], unseen:[{ x, z }] }`、`perch: { x, y, z }`、`dragonBreath:[{ x, y, z, radius, dangerRadius }]`、`dragonFireballs`（数） | `minecraftEndView.ts`（`endViewOf`）が 1 つの形に読み、live の「竜:」「エンドクリスタル:」「竜の息の雲:」「火の玉:」「止まり木:」行と、済む条件 `crystals<=n`・進みの証拠（与えたダメージ・壊したクリスタル）に使う。`remaining` は「立っている・まだ見ていない台座の数」で、体が壊れたと見たものだけが減る。同じ部品が `state.world.end`・`state.end` の中にある早い形（`fountain`・`clouds`・`fireballs`・`at`・`head`・`dist`・`r`）も同じ読みで受ける（直下が先） |
| 旧形式（`world.mapLandmarks` の `! エンダードラゴン … id N 体力 H/200`・`! エンドクリスタル`・`X 止まり木`） | 体が上の欄を 1 つも送らない時だけ読む | 竜の体力と「見えている n 個」と止まり木だけ。島全体の残りは言わない（`crystals<=n` は「未」のまま） |
| `observation.state.world` の `lastDeath`・`deaths`・`rememberedPlaces`・`mapLandmarks`・`inside` | 体が今出している行と記録・印の行 | 「最後の死:」行（死んだ次元が今と違えば「行くにはポータルを通る」と足す）、「控え（体の記憶、今いる次元）:」行、済む条件 `see:<印>`（`N ネザー要塞`・`inside` の「ネザー要塞」、`Q エンドポータルの枠 … ×12 アイ入り k`、`e エンドポータル` ほか。別の次元の行 `[overworld] …` は読まない） |
| 結果 `ActResult.eye`（S2） | `{ from, bearingDeg（北0・東90、小数 2 桁）, flew, to, broke, origin（投げた足の位置、小数）, unit:{ x 東, z 南 }（水平の単位ベクトル。沈んだ時は null）, start, end, rise, fate:'dropped'\|'shattered'\|'unknown', drop?:{ id, at }, arrived, samples, ms, down? }` | 目玉の帳簿（5）。`origin` が線の始点、`unit` が向き。`down`（横 1 ブロック未満で沈んだ）は線に使わず「要塞はその真下」の事実にする。`arrived`（飛びが 10.5 ブロック未満で止まった）は「止まった先が要塞の入口の近く」の事実にする（S2 の隔離ラボで 12m 以内の 6 投は終点が入口から 0.3 以内）。`fate:'dropped'` の `drop.id`・`drop.at` は pickup の目印、`broke` は割れる合図を見た時だけ真 |

## 2. 済む条件の足し（`minecraftPlanDone.ts`）

- `see:<fortress|bastion|spawner|blaze_spawner|nether_portal|end_portal_frame|end_portal|stronghold|village>`: その印が今の frame に見えている。場所の条件なので、子が開いている親は閉じない。
- `crystals<=n`: 体が数えたエンドクリスタルの残り（`crystals.remaining`）が n 以下。体が数えていない時は「未」（不明を済みにしない）。壊したクリスタルは戻らないので、`have:` と同じく「手元にある結果」として扱う: 子（弓で撃つ・檻を登る）が開いたままでも、残りが n 以下なら親は閉じる（Codex の指摘）。
- ロッド・パールの数え方（`acquired`）: `have:blaze_rod>=7` は「持っている棒 ＋ 粉・目玉になった棒」、`have:ender_pearl>=12` は「持っているパール ＋ 目玉になった分」で数える（早く粉にしても節が閉じなくならない）。`target` の検査・不足の言い方・進みの証拠も同じ数え方。
- 竜の討伐は節の条件では閉じない（体の `boss.verified`、既存の goal binding）。S1 の定義: 体がこの竜に被害を与え、その後 60 秒以内に同じ竜が死に、同じ接続・同じタスクの時だけ true。再接続すると `unknown` のまま。

## 3. 計画の後半（`minecraftFirstPlan.ts` の BEYOND）

出発の点検（ネザーの奥）→ ネザー要塞（`see:fortress`）→ ブレイズロッド7（`target`、`have:blaze_rod>=7`）→ エンダーパール12（`target`）→ エンダーアイ12（`target`）→ オーバーワールドへ戻る（`dim:overworld`）→ 出発の点検（エンド）→ ストロングホールド（枠の部屋 `see:end_portal_frame`、ポータルが開く `see:end_portal`）→ エンドに入る（`dim:the_end`）→ エンドでドラゴン（クリスタル `crystals<=0`、止まり木で剣）。最初の計画（Opus）にも同じ書き方を `minecraftCurrentPlanPrompt.ts`・`minecraftStrategy.ts` で伝える。

## 4. 段の知識（`minecraftLlmcV2Knowledge.ts`）

S1・S2 の手の言葉に合わせた（`stronghold` 段を足した）:

- ブレイズ（S2）: `mc_probe kind=camp` が湧き場とその 3m 以内の足場（縁・火の無い所）を教え、そこへ go → `fight target=blaze`（種類名か `#id`）。体は追わず、キーも押さず、盾の下で待つ。浮いた相手は降りるまで待つ。撃つ直前と火の玉が 10 tick 内の間は見送る。`attack hold` は待つだけで届く所に来ない（ラボ: 262 秒でロッド 0・盾が壊れた）ので使わない。行に「落とし物 blaze_rod×1」「湧き場 (x,y,z) まで Nm」「盾 −N（残り M）」「見送り N」。盾は火の玉 1 個で耐久 6 減る。ラボの数: 79 秒に 5 体・ロッド 1・傷 12.8・盾 −155。
- パール（S2）: `use item=gold_ingot target=piglin` が金 1 個の交換をまるごと（金の防具を先に `equip`。code: not_adult・piglin_hostile・out_of_reach・not_accepted・nothing_returned）。`fight target=enderman` は体が屋根の穴を作る（3×3×2 の空きの平らな床・建築用ブロック 11 個・missing_item／no_site／pumpkin。練習場で確かめた形、本物のエンダーマンでは未確認）。**バーターの数字を直した**（Codex の指摘、Java 1.21.11 の `piglin_bartering.json` で確認: 真珠の重み 10／全体 469 = 2.13%、1 回に 2〜4 個）: 金 16 個で平均 1 個、12 個には金 190 個前後（以前の「4〜8 個・金 90 個」は誤り）。
- 要塞探し（S2）: `use item=ender_eye`（at 無し）で飛びを最大 10 秒追う。結果の向き・終わり方（落ちた＝pickup target=#id／割れた）。沈んだ（down）・12m 足らず（11.9 未満）で止まった（arrived）所が要塞の入口（隔離ラボで 6/6）。枠は `mc_probe kind=frames`（x・z=探す中心、radius 16〜128、既定 64。近い順に最大 12 個、無ければ 16 ブロック刻みの輪の次に歩く点）で探す。入口からポータルの間は 7〜72 ブロック（5 世界）なので radius 128 を使う。S2 の `find-structure` は通しのモデルの道具に無い（呼べるのは `mc_act`・`mc_probe`・`mc_view`・`plan_update`・`fca_complete` の 5 つ。段の文が持たない道具名を言うことは `llmcV2Fix9.test.ts` が禁じている）ので、S2 が probe の kind `frames`・`camp` として足した。頭の契約（`minecraftProbeContract.ts`・`minecraftLlmcProbeInput.ts`）に両方を足した。
- エンド（S1）: クリスタルを先に壊す（竜の回復 +2/秒・実測）。`shoot target="#id"`（13〜64m・too_close／too_far／line_blocked。檻の格子だけ dig で取る・格子 2 つを消して 17.8m から 1 発）、`attack target="end_crystal"`（3m 以内・blast_unsafe）。竜は `attack target="ender_dragon"`（止まり木の間だけ頭・歩かない・perch_over 等）、`shoot` は飛んでいる間だけ。頭への剣 1 回 7・他の部位 2.75、1 回の降下で削れるのは約 50（バニラの規則）。息の窓（phase 6 が主）は「ゲームの規則から導いた仮説・未確認」と書いた。ベッドの爆発は `use at=[ベッドのマス]`（体は自分では使わない・blast_unsafe）。討伐の確認は `boss.verified`。

いつもの system 文（8,800 トークンの上限）は増やしていない（節目の長い一覧は meter だけに出す）。

## 5. live の事実と目玉の帳簿

- 行は `facts` に入る（通常版は全部、急ぎ・短縮版は竜・クリスタル・息の雲・火の玉・枠・最後の死だけ）。竜の依頼でなければ出さない。竜・クリスタル・目玉の帳簿・枠は、体がその欄を送った時・投げた時だけ出る。
- 「竜:」行は体力・phase の言葉（止まり木の phase 5〜7 は「この phase N 秒目。矢は効かない」）・頭か位置・「頭の箱まで N m（剣が届く／剣は 5m 以内で届く）」・id。「エンドクリスタル:」行は残り n/10（壊れた・檻つき・まだ見ていない台座）と近い順 3 個（檻つき・竜を回復中・「壊すと爆発（今の立ち位置で体力 −N の見込み）」）。
- 目玉の帳簿（`minecraftEyeLedger.ts`）: 行動結果の `eye` を 1 回ずつ記録（オーバーワールドだけ、新しい 8 個、45 分・4,000 マス内）。task の checkpoint（`minecraftEyes`）に入るので、要約・再起動で消えない。**読む時にも 45 分を過ぎた投げは使わない**（古い checkpoint を戻しても同じ。Codex の指摘）。落ちた目玉は「(x,z) で拾える・pickup target=#id」を 5 分間言う。
- 交点（`minecraftEyeTriangulation.ts`、純粋関数）: 前向きだけ（投げた先の後ろで交わる線は使わない）、誤差の見積り（飛んだ距離が短いほど方位が悪い・遠いほど大きい）が 600m を超えたら出さない（150m を超える間は「方角の目安」と添える）。3 本以上は重み付き最小二乗で、合わない 1 本は外す。**誤差は線が点を外す分（残差）を含む**ので、合わない線が「±1m」を名乗らない（Codex の指摘）。出す時は「計算上の見積り ±Nm・k 本が一致」と原点からの距離を言う。
  - 向きが `unit` で正確に読めた線（飛びが 4 ブロック以上・`bearingDeg` と 1° 以内で合う）は、方位の下限を 0.5° ではなく 0.02° とし（S2 の隔離ラボの実測は 10 投で最大 0.003°・交点は 45 組とも入口から 0.12 ブロック以内。その約 7 倍）、2 本の交わる角度が 3° 以上あれば点を出す（方位だけの線は 8°）。次に投げる場所の案は、方位だけなら最後の線の横 100/200/400m、正確な線なら 200/400/800m（最初の要塞は 1,280m 以上先なので 200m で 4° 以上交わる）。
  - **沈んだ目玉（`down`）と止まった目玉（`arrived`）は線にしない**: 沈んだ所が交点そのもの（誤差 ±4m）、止まった目玉は `origin ＋ unit × flew`（誤差 ±8m。S2 の隔離ラボで、12m 以内の 6 投は終点が入口から 0.3 以内）。次に投げる場所の案は出さず、「`mc_probe kind=frames` で枠を探す（部屋は入口から 7〜72 ブロック離れていた）」を言う。沈んだ目玉の意味のない方位 0 は線に使わない（Codex の指摘）。
  - 交点に近づいたら、交点の手前（誤差と同じだけ）から投げ直す案。方位の精度は隔離ラボの実測（本番の世界での確かめは未）。

## 6. ペースの目安（`minecraftLlmcRoad.ts`）

ネザーの後ろに、要塞 2,700・ロッド7 4,500・パール12 7,800・アイ12 8,100・枠の部屋 10,800・エンド 11,200 秒（先例のネザー 55 分→討伐 3:56 の各区間を、持ち主の 30 分に足した。ものさしで、手は決めない。最初の数走で見直す）。討伐は 12,700 秒前後を想定。

## 7. 無人の通し（止まりの常時検出と立て直し）

保留しない依頼（`--hold-on-failure` でない依頼）でも、止まり（節が進まない・同じ所で止まる・待ちの繰り返し・死）を毎判断の前と結果の後に見る（`minecraftLlmcWatch.ts`。目的別の進みは Codex の C のまま。子の節が親の目標（ブレイズロッドなど）に向けて進めた分は親の進みとして数え、竜との戦いは「与えたダメージ・壊したクリスタル」も進みに数える）。止まりを見つけたら、次の判断の前に強いモデル（Opus、最初の計画と同じ）へ**履歴なしの短い brief**（8k トークン以内）を送り、`plan.update` の ops（add・split・set・move・drop・forbid・caution・lift、12 個まで）と今の節と一行の理由を受け取る（`minecraftLlmcReplan*.ts`）。ops は今の計画と観測に照らして検査し（目標と条件の不一致・準備の節・観測が満たしていない「済み」は通さない）、計画の次の読みで取り込む。

- 上限（走っている時間の時計で）: 最短 10 分おき・1 時間に 6 回・1 実走 30 回・1 つの節に 3 回。数える回数は、頼んだ時点で増やす（答えが来なくても）。
- 見つけた止まりは、**ステップをまたいで checkpoint（`minecraftReplanPending`）に残る**（死は 1 度しか見えないため。Codex の指摘）。10 分の間隔・1 時間の回数で待たされた止まりは、15 分（走っている時間）までは次の判断で再び頼む。実走・節の上限で止められたものは、告げて捨てる。15 分を過ぎたものは捨てる（まだ止まっていれば見張りがまた見つける）。
- ops は、**検査した時の計画の節（id の title と kind）に束ねる**。取り込む読みの時に、その節が別物になっていれば（最初の計画が後から届いた時など）取り込まない。取り込む時に、計画の検査と観測の検査（目標・準備・「済み」）をもう一度かける。体の観測が取れていない時は、観測の条件を持つ節を済みにする ops を通さない。
- 節に 3 回立て直しても進まない時は、判断に事実を 1 度言う（「続けるか、blocked にして別の道を計画するかを決める」）。頭は節を止めない。
- 強いモデルが「止まりに見えて進行中の待ち」と見たら ops を空にする（直さない）。
- 保留は、結果が不明で解放を確かめられない時と、体と頭の操作権が食い違う時だけ（従来どおり）。止めて直す診断の実走（`--hold-on-failure`）は今のまま: その見張りが読む道のりは**ネザーまでの区間**（`firstStretch`）に限り、ネザーの先の節目（要塞が見えた等）で時計が戻ることはない（Codex の指摘）。
- 費用: Opus 5.5 は入力 $4・出力 $20 / 百万トークン。1 回は入力 約 9k・出力 約 2k なので約 $0.08〜0.15（キャッシュの書き込み込みで上限は約 $0.15）。30 回で約 $2.5〜4.5。予想: 3 時間の通しで 3〜8 回（$0.3〜1.2）。実走で数える。

人の resume なしで 4〜5 時間を通すために、止まりの原因を一つずつ点検して直した（2026-11-02、コードを読んだ監査 18 項目の結果。**保留しない依頼だけ**。`--hold-on-failure` の依頼は元のまま）:

- **失敗の連続**（`fcaFailureLadder.ts`）: 元の梯子は、連続失敗が 6 回以上で 120 秒動かない時（10 回なら時間によらず）に依頼を止めた。保留しない依頼は、その時点で強いモデルへ立て直しを頼み（失敗の連続 1 回につき 1 度）、止まるのは「5 回を超えた後、30 分動かない」か「200 回続いた」時だけ（`unattendedFailureStops`、`FcaStepPorts.failureStop`）。立て直しは 10 分おきなので、止まる前に 3 回は頼む。
- **モデルの応答が得られない**（`taskRuntimeUnavailable.ts`）: 提供者の障害で判断が返らない時の周回を 4 から 24 に（約 45 分。それまでは 15 分ほど）。超えると一時停止（resume が要る）。請求の残高切れはすぐ一時停止（補充が要る）。
- **履歴の要約**（`fcaHistory.ts`）: 提供者に届かず要約が得られない時（5xx・混雑・切断）、体の依頼は切り詰めた履歴で続ける（`patient`）。元は、続けて 2 回で依頼が失敗した。
- **体が戻る窓**（`fcaBodyRecoveryPolicy.ts`）: Spot の停止から 30 分で一時停止していたのを 2 時間に（環境の `SHANNON_FCA_BODY_RETURN_MINUTES` で 720 分まで）。回復の回数の上限は 1 時間に 6 から 12。
- **体が居ない間の判断**（`withBodyPresent`、`minecraftLlmcLifecycle.ts`）: 体の frame が無い（15 秒より古い）か接続していない間は、ステップの始めでモデルを呼ばない。判断が来なかった周回（`FcaDecisionUnavailableError`、理由 `body_absent`、`taskRuntimeUnavailable.ts`）として 30 秒ごとに待ち、2 時間（240 周）まで、費用 0・失敗に数えず待つ。超えると体の言葉（体が戻らなかったため一時停止）で止まる。元は、体だけが落ちると失敗する判断が約 ¥3.5 ずつ続き、失敗の梯子を上り、強いモデルへの引き上げも起こした（S0 の復旧試験）。ステップの途中で体が居なくなった時は、そのステップの判断（最大 1 stretch）までで、次のステップの始めに止まる。
- **再起動の後の続き**（`minecraftLlmcRestart.test.ts`）: 計画の節・目玉の線・待ちの期限・立て直しの回数と、待っている止まりが、checkpoint から再起動のたびに配り直されずに続く（3 回の再起動を模した試験）。
- 残る人手: 請求の残高切れ、24 回の周回を超える障害、体が 2 時間戻らない時、30 分動かない失敗の連続、運用の時間の上限（VM の停止中の時間も数える）。取りまとめに伝えた物（環境・運用の側）: 下の 10。

## 10. 撮影の日のコマンドと、取りまとめの側の点検（2026-11-02）

- 依頼の文は、`isNativeDragonGoal` の閉じた集合（`fcaMinecraftGoalBinding.ts`）の物だけが「竜の死」で完了できる。例: `エンドラを討伐して`。他の言い方（「エンドラを倒しに行って」など）は、倒しても完了にならない。
- 運用 CLI は `--max-minutes 360`（既定は 30 のまま）・`--budget-yen` は省くと上限の 15,000。`--hold-on-failure` は付けない。
- 取りまとめ・運用の側で見てほしい点（頭の枝では直せない）: (1) 運用の時間の上限は VM の停止中も数える（`heldMs` は `fca_unknown` の時間を引かない）。(2) リースは 25 秒更新できないと落ちる（`actionExecutionWiring.ts`）。夜の睡眠処理は 03:00 から使え、体の依頼が動いていると 09:00 まで待って、その後は動いていても始まる（`fcaSleepJobs.ts`）ので、09:00 をまたぐ通しでは API のスレッドを止めうる。`shannon-ios-mind.service` は `CPUQuota=25%`・`MemoryMax=256M`（`deploy/azure`）。確かめてほしい（頭では未確認）。(3) `bodyHeld`（`operatorMinecraftWiring.ts`）は `holdOnFailure` の確認が無く、体が自分で保留を立てると保留しない依頼も止まる。(4) 請求の残高の確認。

## 8. 運用 CLI の上限（2026-11-02 に取りまとめ経由で承認、この枝に入れた）

1 依頼 120 分・¥2,000 は 4〜5 時間の通しに足りないので、`operatorContract.ts` の `OPERATOR_LIMITS` と `fcaBudgetWiring.ts` の `MINECRAFT_TASK_CAP` を上げた:

| | 前 | 後 | 根拠 |
|---|---|---|---|
| `maxMinutes`（既定は 30 のまま） | 120 | 360 | 目標 4〜5 時間 ＋ Spot の再起動と遅い区間の 1 時間 |
| `maxBudgetYen`・`MINECRAFT_TASK_CAP.yen`（依頼ごとに `--budget-yen` で下げられる） | 2,000 | 15,000 | 稼働 1 時間 最大 ¥1,640（実走 42〜58 の実測）× 6 時間 = ¥9,840 ＋ 立て直し 30 回 約 ¥700 ＋ 要約・最初の計画。Opus を重要な区間に使っても収まる |
| `MINECRAFT_TASK_CAP.steps` | 300 | 2,000 | 判断は 1 分に約 4 回（実走 42 は 43 分で q166）、6 時間で約 1,400。1 歩は判断の続き（stretch）なので、歩数が通しを止める上限にならない |

既定の予算は上限と同じ（`--budget-yen` を省くと 15,000）。短い依頼は時間の上限（既定 30 分）で止まる。運用 CLI の契約文書（`docs/operator-minecraft-contract.md`）とテストも合わせた。

## 11. 強いモデル（Opus）を使う所（2026-11-02、新しい環境変数なし）

- 最初の計画と立て直し（監督）は、常に計画のモデル（`SHANNON_MINECRAFT_LLMC_PLAN_MODEL`、既定 Opus 5.5）。
- 判断（1 手ごと）は主モデル（本番の設定。run 55 の記録は Sonnet 5.5）。ただし計画の今の節、またはその上の節の kind が `LLMC_STRONG_KINDS`（今は `nether`・`fortress`・`blaze`・`pearl`・`stronghold`・`end`・`dragon` = ネザーの奥からエンドまで）の間は、計画のモデルが決める（`strongStage`、`minecraftLlmcConfiguration.ts`）。計画は checkpoint の `fcaPlanTree` から読むので、再起動の後も同じ。主モデルと計画のモデルが同じ（既定は両方 Opus）なら何も変わらない。失敗が続いた時の引き上げ（`ESCALATE`）が先に効く。
- 本番が主 Sonnet・計画 Opus のままなら、api.env の変更は要らない。
- ライ氏の許可（11/2: 迷ったら Opus 側）で、エンドまでの道は全部 Opus に倒した。**この集合は場面再生（Sonnet と Opus の正しさと 1 判断の秒、費用）で絞れる**が、エンドまでを急ぐので比べは後回し。実 LLM を使うので API キーの供給待ち（`scripts/minecraft-llmc-endgame-scene.ts --models=sonnet,opus`、立て直しは `scripts/minecraft-llmc-stall-replay.ts`）。
- 費用の見込み: 切り替えた節の間は Opus の接頭辞のキャッシュ（1 時間）を使い、節が変わる度に書き込みが 1 回（約 $0.1〜0.2）。判断 1 回の単価は Sonnet の約 2 倍。

## 9. 確かめたこと・未確認

- 確かめた（単体・結合テスト、型検査、コードの形の検査、関係するテスト）: 済む条件の読みと閉じ方（クリスタルの親を含む）、数え方、フェイクの frame（S1 の最終形 = `state.world` 直下・早い形の `state.end` と `world.end`・S2 の `eye` の形）からの行、目玉の帳簿と交点（真の位置との誤差・残差・沈んだ／止まった目玉・読む時の期限切れ）、checkpoint の往復、立て直しの上限と流れ（フェイクの強いモデル、ステップをまたぐ止まり、取り込み時の束ねと再検査）、brief の大きさ。
- **未確認**: 実機の体が上の欄名で送ってくるか（S1・S2 の枝のコードを読んで合わせたが、頭と体を合わせた通しはまだ）、実機の本番の世界での目玉の方位の精度（S2 の隔離ラボは 0.003° 以内、頭は 0.02° で受ける）、Opus が立て直しで有用な ops を返すか・誤検出の頻度、段の知識の言い回しが Sonnet の判断を良くするか（場面再生は API キーと予算の承認待ち）、2〜4 時間の通しで要約をまたいで事実が効くか、エンダーマンの屋根の穴が本物に効くか（S2 の練習場は模型）。
