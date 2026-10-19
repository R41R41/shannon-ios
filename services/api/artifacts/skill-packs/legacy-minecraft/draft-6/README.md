# 旧Minecraft実験からの試し手順（draft-6）: 最初の日からドラゴンまでの 7 本

背景: 点検（Syzygy `notes/parity/audit-A-control-memory.md`）で、旧から移った知識は 18% だけで、ダイヤ・黒曜石・エンダーパール・要塞・エンドの知識が無かった（K-03〜K-05）。本番の実走14 では要点を 13 回出したのにスキルの本文は一度も開かれず（skill_read 0 回）、実走15 では食料 0・ベッド無しで夜になり、ゾンビで 4 回死んだ。

## この版でやること

新設 7 本だけ（改訂は無い）。同じ名前の skill が無いので、既存の skill が試し中（`on_trial`）でも入る。各要点（手順 2〜4 行目）の最初の一手は、身体の道具の名前と引数で書いた（`mc.` の名前は身体 catalog の実在のものだけ、各行 90 字以内で切れない）。

| skill | 指す時（`minecraftSkillPointers.ts`） | 後継の対象 |
|---|---|---|
| `mc-first-day` | 段階 1（石のツルハシが無い）の昼 | `mc-early-toolchain` |
| `mc-food-and-bed` | 段階 2（石のツルハシがあり、ベッドか食料 6 個が無い）の昼、日暮れの 10 分前でベッドが無い時。村の回収もここ | `mc-bed-before-night`、`mc-opening-scout` |
| `mc-diamond-obsidian` | 段階 5・6（鉄のツルハシとバケツの後、ネザー前）。ダイヤ → 黒曜石 10 個 → ゲート | `mc-nether-portal` |
| `mc-travel-kit` | 段階 6 かエンダーアイを持ち、弓・矢 32・くり抜いたカボチャのどれかが無い昼 | （新規） |
| `mc-ender-eyes` | ブレイズロッドかパウダーを持ち、アイが 12 個に足りない（エンド以外） | （新規。旧の seed-piglin-barter） |
| `mc-stronghold` | オーバーワールドでアイを 8 個以上（投げると割れるので 12 より下から）。ロッドとパウダーが残っていなければ 1 個から（枠にはめて減っても消えない） | （新規） |
| `mc-end-fight` | エンドにいる | （新規） |

- 指し示しは「後継の名前 → 旧の名前」の順で、読める方を指す。draft-6 を入れる前は今までどおり旧を、入れた後は新を指す。だから導入の順番（コードが先か import が先か）に縛られない。
- 段階（`minecraftStage.ts`）は 1〜6 になった。1 石のツルハシが無い／2 ベッドか食料が無い／3 ベッドと食料があり鉄のツルハシが無い／4 鉄のツルハシがありバケツが無い／5 バケツがありダイヤのツルハシが無い／6 ダイヤのツルハシ。4 より下の意味（鉄の前）は前と同じ。
- 食料は食べられる物 6 個。鉱石か鉄インゴットを持っていれば 3 個で段階 3 に留まる（鉱山で 1 回食べただけで羊探しに戻らないため）。
- 羊を探して居なかった日は、段階 2 でも鉄を指す（食料が足りなければ食料の指し示しと並べる）。
- `mc-diamond-obsidian` の `milestone` は `nether`（ネザー到達で採点）。

## 実機で確かめていないこと

- 投げたエンダーアイの座標を `mc.find-nearest-entity`（eye_of_ender）で読めるか。`mc.list-nearby-entities` は名前と距離だけで座標を出さないので、要点は find-nearest-entity にした（体の側で方角を結果に添える拡張が入れば、それを使うと書いてある）。
- カボチャへの `mc.use-item-on-block`（shears）、ベッドへの `mc.activate-block`（昼のリスポーン地点）、`mc.shoot-bow` の `targetName=end_crystal`、`mc.tower-up` で柱を登ること。
- いずれも身体 catalog の説明から組んだ試しで、旧にも知識が無い（旧の到達はブレイズロッドまで）。

## 枠

- 本番は 24/25（K-19）。この 7 本で 31 になるので、枠を 32 に上げた（`skillDocument.ts` の `SKILL_INDEX_LINES` 26 → 33）。
- 目次は毎回の入力のうちキャッシュされる側にあり、増えるのは本数ぶんの行だけ。決定ごとの側（指し示しと要点）は最大 3 件・各 3 行のまま。
- 後継に替わった 4 本（`mc-early-toolchain`、`mc-bed-before-night`、`mc-opening-scout`、`mc-nether-portal`）は、新が入ると指されなくなる。今は import で退役させる道が無いので、目次には残る。

## 導入（本番）

owner の承認が要る別の段階。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-6
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-6 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- 枠を上げたコード（32）を先に本番へ出してから import する。25 のままだと `over_capacity` で入らない。
- dry-run で確かめる: problems が空、新設 7 本、capacity は used 24・added 7・limit 32、各 skill の SHA-256 が manifest と一致。
- draft-7（`mc-night-retreat` の改訂）は別。後でも先でもよい。
