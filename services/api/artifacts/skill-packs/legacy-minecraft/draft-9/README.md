# 旧Minecraft実験からの試し手順（draft-9）: 実走17 を受けた 5 本の改訂と 1 本の新設

背景: 本番の実走17（2026-10-19、Sonnet、30 分）で、鉄を 3・8・8・13 個に分けて掘り、そのたびに精錬して待った（かまど待ちの wait-time は合わせて 175 秒）。予備のツルハシを作らず、深い層でツルハシの耐久切れが 5 回あった。村探しは 0 回（夜から始まり、明けた後も探さなかった）。クリーパーと戦って爆死した。

## この版でやること

- 改訂 5 本（`revises`、基は draft-8 の本文）。要点の最初の一手は、道具の名前と引数のまま。
  - `mc-first-day`: 原木（丸太のブロック）を 4 個 → 木のツルハシ → 先に石の斧 → 石の斧で残りの原木を合わせて 12〜16 個（owner の指示）。
  - `mc-food-and-bed`: 村は explore-for-structure（village、160 ブロック）を 2 回。夜に逃したら、明けてすぐ探す。
  - `mc-iron-and-bucket`: 鉄鉱石は一度に mine-block（count=30、searchRadius=48）。かまど 2 台に半分ずつ。焼ける間は待たない。予備のツルハシまでで鉄 33 個。
  - `mc-diamond-obsidian`: 補助に、クリーパーとは戦わない・ツルハシの耐久が尽きる前に予備へ持ち替える、を足した。
  - `mc-food-and-pace`: かまどの前で待たない、をはっきり書いた。
- 新設 1 本: `mc-night-shelter`（`mc-night-retreat` の後継）。夜は穴から出ない・体力半分以下で遠くから撃つ敵と戦わない・反射の退避を取り消さない、を要点にした。指し示しは後継を先に読む。枠は used 31 → 32（上限 32 ちょうど）。
- `mc-night-retreat` そのものは改訂しない。実走17 で使われたので（v4 に利用 1 件）、改訂は `on_trial` で止まる。取り込みは 1 本でも止まると全体が `validation_failed` になるので、この版から外した。クリーパーの扱いは、コードの側（戦いの道具の断りと速い判断）と、ほかの 3 本の補助に書いた。
- コードの側（同じブランチ）
  - 節目「鉄」の文: 鉄鉱石は一度に 30 個掘る。
  - 村をまだ探していない間は、明るい時に `mc-food-and-bed`（村をまだ探していない）を指す。
  - クリーパーを狙った戦いの道具は、送る前に断る。

## 本番との関係

- 基になる本文は、本番の現行版（draft-8）と完全一致でなければ入らない（`revision_base_changed`）。2026-10-20 の本番 DB で 5 本とも一致を確かめた。
- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial`）。2026-10-20 の時点で 5 本とも利用 0 だった。次の実走の後に入れる時は、**dry-run で確かめる**。1 本でも `on_trial` があれば、その 1 本を外した版を作り直す。
- この版は `standardSkillPack` の `legacy-minecraft/draft-9` を読む。**同じブランチの API コードを出した後に入れる。**

## 導入（本番）

owner の承認が要る別の段階。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-9
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-9 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、5 本が `(revises)`・`mc-night-shelter` が新設、capacity は used 31・added 1・limit 32、SHA-256 が manifest と一致。
