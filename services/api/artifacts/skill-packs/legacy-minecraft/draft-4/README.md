# 旧Minecraft実験からの試し手順（draft-4）: 日暮れ前のベッドの書き直しと、序盤の新しい 2 手順

背景: 本番の Minecraft run 14（Sonnet）で、draft-3 のベッドの要点は 2 回の夕方に 11 回出たが、一度も辿られなかった（彼女は `mc.dig-shelter` を選んだ）。要点に利点が書かれておらず、最初の一歩（羊を狩る）が重く見え、「地下で過ごす方針は変えない」という文言がかえって地下へ誘っていた。また、石のツルハシから鉄のツルハシまで（6.9 分）の間、彼女が開くべき手順が指されていなかった。

## この版でやること

- 改訂 1 本: `mc-bed-before-night` を新しい版にする（`revises`）。要点（手順 2〜4 行目）の 3 行は、利点と村の近道（`mc.sleep-in-bed`）／探す順序と上限（村、無ければ `mc.find-nearest-entity` で羊を 1 回、6 分か 12 決定まで）／諦めの行き先（`mc-night-retreat`）。
- 新設 2 本（序盤の段階ポインタの宛先、`minecraftSkillPointers.ts` の `stage`）:
  - `mc-opening-scout`（石のツルハシがありベッドが無い昼）: biome と動物から羊・村の見込み、村の確かめ方（`mc.recall-places` / `mc.find-structure` / `mc.explore-for-structure`）、食料、斧。
  - `mc-iron-and-bucket`（ベッドがあり鉄のツルハシが無い）: 食料が足りたら鉄、つるはし 3 → バケツ 3 → 防具、炉の前で待たない、鉄が尽きたら別の層、同じ場所の失敗を繰り返さない。
- 「地下で過ごす方針は変えない」のような、ベッドを遠ざける文言を外した。夜になってベッドが無ければ `mc-night-retreat` へ、は要点に入れた。
- 要点の各行は 90 字以内で切れない（`skillGist`）。`mc.` の名前は身体 catalog の実在のものだけ。

## draft-3 との関係（本番）

- draft-3 は本番に導入済み（`mc-bed-before-night` 版 1、trial、operator_authored）。draft-4 はその同名 skill の新しい版として、通常の改訂経路（`SkillMemory.revise`、operator_authored）で書く。基になる本文は draft-3 と完全一致（SHA-256 `54eb66a3…`）でなければ入らない（`revision_base_changed`）。
- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial` で止まる）。**dry-run で確かめる**。`on_trial` になった時は pack 全体が入らない（problems が空でない）。その場合は別名の新 skill（例 `mc-bed-first`）で出し直し、`minecraftSkillPointers.ts` の宛先を替える（その時は相談）。
- 出し方（指す条件）はコード側。石のツルハシがあるなら昼のあいだ一日中（窓なし）、それ以外は暗くなるまで 10 分以内（`BED_LEAD_SECONDS` 600）かつ 1 分より先。羊を探して居なかった日は、その日はもう指さない。
- 新設 2 本は、本番の skill 枠（上限 25）に足される。現状 22 件なら 24/25 になる。

## 導入（本番）

owner の承認が要る別の段階。root担当が公開済みの exact source で次を行う。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-4
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-4 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、`mc-bed-before-night` に `(revises)` が付く、新設 2 本（`mc-opening-scout`、`mc-iron-and-bucket`）、capacity は used 22・added 2・limit 25、各 skill の SHA-256 が manifest と一致。
- `mc-night-retreat` など他の skill には触れない。
- 改訂後の版は、利用 0 の試しのまま続く（`operator_authored`、provenance は draft-3 のまま）。新設 2 本は trial・利用 0・成功 0 から始まる。
- 次に `draft-5`（`mc-nether-portal` の並べ替え改訂）を別に dry-run する。draft-4 の後でも先でもよい（互いに依存しない）。
