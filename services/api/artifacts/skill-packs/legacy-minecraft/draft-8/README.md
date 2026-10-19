# 旧Minecraft実験からの試し手順（draft-8）: 実走16 を受けた 6 本の改訂

背景: 本番の実走16（2026-10-19、Sonnet、約 20 分）で、鉄のツルハシまで 9.5 分・ダイヤ 16.5 分と前より進んだが、防具 0・焼いた食料 0・ベッド無しで夜に高さ -7 の洞窟へ降り、ゾンビに倒された。ほかに、原木 6 本で板が足りない、羊毛が色違い（白 2・薄い灰 1）でベッドを作れない、かまどがあるのに生肉を 6 回食べた、精錬の間に 70 秒待った、があった。`mc-night-retreat`（draft-7）の 4 行目「余裕があれば地下へ下りて掘る」は、夜の深い採掘を勧めていた。

## この版でやること

- 改訂 6 本（`revises`、新設は無い。枠の used は変わらない）。要点（手順 2〜4 行目）を、最初の一手が具体的な進め方にした（道具名は書かない決まりのまま）。
  - `mc-first-day`: 原木を 12〜16 本。原木の名前を「,」で並べない。剣を持ってから狩る。
  - `mc-food-and-bed`: 同じ色の羊 3 頭。生肉は焼いてから食べる。焼く間は待たずに別の仕事。
  - `mc-iron-and-bucket`: 鉄は 14 個（ツルハシ 3・バケツ 3・胸当て 8）。精錬の間に別の仕事。胸当てを着てから深い層へ。
  - `mc-diamond-obsidian`: 胸当て・焼いた食料・ベッドを持ち、昼のうちに降りる。
  - `mc-night-retreat`: 夜は高さ 16 より下へ降りない。縦穴が掘れない時は丸石の囲い（ハーフブロックの作り方つき）。
  - `mc-food-and-pace`: 焼いてから食べる、精錬と料理を待たない、を先頭に。
- コードの側（同じブランチ）: 節目「鉄の防具」と段階 5 の胸当て、体の夜の門の断り（`night_unprepared`）の受け取り。

## 本番との関係

- 基になる本文は、本番の現行版と完全一致（SHA-256 は manifest の `revises`）でなければ入らない（`revision_base_changed`）。2026-10-19 23:30 の本番 DB で 6 本とも一致を確かめた（first-day・food-and-bed・diamond-obsidian は draft-6、iron-and-bucket は draft-4、night-retreat は draft-7、food-and-pace は draft-2）。
- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial`）。10/19 の時点で 6 本とも利用 0。実走の後に入れる時は、**dry-run で確かめる**。使われた 1 本だけが止まり、ほかは入る。
- この版は `standardSkillPack` の `legacy-minecraft/draft-8` を読む。**同じブランチの API コードを出した後に入れる。**

## 導入（本番）

owner の承認が要る別の段階。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-8
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-8 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、6 本とも `(revises)`、capacity は used が現状のまま・added 0、SHA-256 が manifest と一致。
