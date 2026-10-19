# 旧Minecraft実験からの試し手順（draft-7）: `mc-night-retreat` の要点の書き直し

背景: 本番の実走15 で、食料 0・ベッド無しで夜になり、ゾンビで 4 回死んだ。`mc-night-retreat`（draft-2）の要点（手順 2〜4 行目）は「夜の地上をさまよわない。地下へ入り…」「夜は地上に出ない…」「ベッドを持っていて…」で、最初の一手が道具の名前になっていなかった。

## この版でやること

- 改訂 1 本: `mc-night-retreat` を新しい版にする（`revises`、新設は無い）。
- 要点は 2 行目＝ベッドがあり敵が 8 マスより遠ければ `mc.sleep-in-bed`／3 行目＝無ければすぐ `mc.dig-shelter`／4 行目＝余裕があれば `mc.stair-mine` で地下の採掘。
- 前の版の中身（水辺へ逃げない、塞いだ中で敵が近い間は出ない、mc-low-health へ）は 5〜7 行目に残した。

## draft-2 との関係（本番）

- 基になる本文は draft-2 の `mc-night-retreat` と完全一致（SHA-256 `9b374b07…`）でなければ入らない（`revision_base_changed`）。
- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial`）。夜のたびに指されてきたので、すでに使われていれば入らない。**dry-run で確かめる**。
- 入らなくても draft-6 とコードの動作に影響は無い（draft-6 と分けたのはこのため）。その時は draft-6 の `mc-food-and-bed` が夜の前にベッドと食料をそろえる側を受け持つ。

## 導入（本番）

owner の承認が要る別の段階。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-7
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-7 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、`mc-night-retreat` に `(revises)`、capacity は used が現状のまま・added 0、SHA-256 が manifest と一致。
