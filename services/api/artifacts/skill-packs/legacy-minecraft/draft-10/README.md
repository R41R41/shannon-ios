# 旧Minecraft実験からの試し手順（draft-10）: 実走18 を受けた 2 本の改訂

背景: 本番の実走18（2026-10-20、30 分、49 決定）で、羊が 25〜41 m に見えていた最初の 5 決定でも、節目が「食料と羊とベッド」だった 27 決定でも、羊探し・村探しは 0 回だった。石の斧の後に原木を掘らず、原木 2・板材 3 のまま鉄へ進み、ツルハシが 2 本とも壊れた時に板材が 1 枚しかなく、作り直しに 281 秒かかった。

## この版でやること

- 改訂 2 本（`revises`、基は draft-9 の本文。本番の現行版と SHA-256 が一致することを 2026-10-20 の本番 DB で確かめた）。
  - `mc-first-day`: 石の斧の次の一手を mine-block（原木、count=10）にし、板材 12 枚分までは狩り・かまど・鉄へ進まない。夜の行き先を `mc-night-shelter` に。
  - `mc-food-and-bed`: 最初の一手を羊探し（find-nearest-entity、maxDistance=128）にし、居なければ体の新しい探し方（explore-for-structure の structureType=sheep、color）で探しに出る。鉄のツルハシの後でも、ベッドと食料 6 個が先。
- ほかの 4 本（iron-and-bucket・diamond-obsidian・food-and-pace・night-shelter）はこの版に入れない。改訂の要る証拠が実走18 に無いため。
- 枠は変わらない（新設 0、used 32・limit 32）。
- コードの側（同じブランチ）
  - 昼の判断が 3 回続けて節目と違うことをしたら、その節目の手順（道具と引数）を判断の先頭（`milestoneSteps`）に置く。
  - 石のツルハシの後も、木材が板材 12 枚分に足りない間は `mc-first-day` を指す。

## 本番との関係

- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial`）。2026-10-20 の時点で 2 本とも利用 0（v3）。次の実走の後に入れる時は、**dry-run で確かめる**。1 本でも `on_trial` があれば、その 1 本を外した版を作り直す。
- 本文は体の新しい道具の使い方（explore-for-structure の sheep・color）を書いている。**mb-body の実走18 の直し（6db1a86・0221837 の動物の探索）を体に出した後に入れる。** 同じブランチの API コードも先に出す（`standardSkillPack` が draft-10 を読む）。

## 導入（本番）

owner の承認が要る別の段階。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-10
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-10 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、2 本が `(revises)`、capacity は added 0、SHA-256 が manifest と一致。
