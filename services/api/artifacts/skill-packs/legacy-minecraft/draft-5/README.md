# 旧Minecraft実験からの試し手順（draft-5）: `mc-nether-portal` の要点の並べ替え

背景: `mc-nether-portal`（draft-2）の要点（手順 2〜4 行目）は、2 行目が鉄の順序、3 行目が溶岩・黒曜石（90 字で切れて「…溶岩の縁へ正面から流して黒曜石にする。遠く…」まで）、4 行目がポータルだった。鉄のツルハシを持った段階（段階ポインタの 4）で指されるので、鉄の話は要らず、溶岩だまり→黒曜石→ポータルを先に出したい。

## この版でやること

- 改訂 1 本: `mc-nether-portal` を新しい版にする（`revises`、新設は無い）。要点を、2 行目＝水を汲み溶岩源の隣へ、縁へ正面から流す／3 行目＝黒曜石を掘り枠の数（10 個目安）まで／4 行目＝`mc.build-structure`（nether_portal）で建てて着火、`mc.enter-portal` で入る、に並べ替えた。鉄の順序は 5 行目へ下げた（本文は失っていない）。
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
