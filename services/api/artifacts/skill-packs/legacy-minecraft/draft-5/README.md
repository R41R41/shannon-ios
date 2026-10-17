# 旧Minecraft実験からの試し手順（draft-5）: `mc-nether-portal` の要点の並べ替え

背景: `mc-nether-portal`（draft-2）の要点（手順 2〜4 行目）は、2 行目が鉄の順序、3 行目が溶岩・黒曜石（90 字で切れていた）、4 行目がポータルだった。鉄のツルハシを持った段階（段階ポインタの 4）で指されるので、鉄の話は要らない。さらに、黒曜石は **diamond_pickaxe（かネザライト）でしか掘れない**（身体 catalog の `mc.use-item-on-block` の説明も同じ）。draft-2 の「溶岩だまりに水を流して黒曜石にし、掘る」は、鉄のツルハシの段階では最後の掘る所で止まる。

## この版でやること

- 改訂 1 本: `mc-nether-portal` を新しい版にする（`revises`、新設は無い）。要点（2〜4 行目）を、2 行目＝黒曜石は diamond_pickaxe でしか掘れない、無い間は枠の型に溶岩を注ぎ水で固めて**枠を鋳造**する／3 行目＝型は `mc.place-block-at` で丸石、溶岩は `mc.use-item-on-block`（lava_bucket）、固めは water_bucket／4 行目＝火打石で着火、`mc.enter-portal`（黒曜石 10 個を持つなら `mc.build-structure`）にした。鉄の順序は 7 行目へ下げた。diamond_pickaxe がある時の従来の道（水で固めて掘り、`mc.build-structure`）は 6 行目に残した。型の組み方・溶岩を置く位置は旧知識に無く、身体 catalog の説明（`use-item-on-block` は手持ちのアイテムを右クリック、`place-block-at` は丸石などを置く）から書いた試しで、実機で確かめていない。
- 要点は 90 字以内で切れない。`mc.` の名前は身体 catalog の実在のものだけ。

## draft-2 との関係（本番）

- 基になる本文は draft-2 の `mc-nether-portal` と完全一致（SHA-256 `547d4c11…`）でなければ入らない（`revision_base_changed`）。draft-2 の `milestone: nether` は新設の時の目的で、改訂は provenance を変えない。
- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial`）。**dry-run で確かめる**。入らなくても draft-4 とコードの動作に影響は無い（ポインタは今の要点のまま指す）。
- draft-4 とは独立（draft-4 の中に入れると、`on_trial` の時に新しい 2 本とベッドの改訂まで止まるので分けた）。

## 導入（本番）

owner の承認が要る別の段階。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-5
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-5 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、`mc-nether-portal` に `(revises)`、capacity は used が現状のまま・added 0、SHA-256 が manifest と一致。
