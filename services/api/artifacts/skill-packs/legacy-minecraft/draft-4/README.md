# 旧Minecraft実験からの試し手順（draft-4）: 日暮れ前のベッド、要点の書き直し

背景: 本番の Minecraft run 14（Sonnet）で、draft-3 のベッドの要点は 2 回の夕方に 11 回出たが、一度も辿られなかった（彼女は `mc.dig-shelter` を選んだ）。要点に利点が書かれておらず、最初の一歩（羊を狩る）が重く見え、「地下で過ごす方針は変えない」という文言がかえって地下へ誘っていた。

## この版でやること

- 改訂 1 本: `mc-bed-before-night` を新しい版にする（`revises`）。新設は無い。
- 要点（手順 2〜4 行目）を書き直した。2 行目に利点（ベッドは夜を丸ごと飛ばし、地下で長く待たずに済む、リスポーン地点）、3 行目に軽い最初の一歩（`mc.find-nearest-entity` で羊を 1 回探す。いなければ今日は諦めて続ける。村が近いと分かるなら村へ）、4 行目に作る・眠る（羊毛 3 個＋板材 3 個を `mc.craft-one`、暗くなったら `mc.sleep-in-bed`）。
- 「地下で過ごす方針は変えない」のような、ベッドを遠ざける文言を外した。夜になってベッドが無ければ `mc-night-retreat` へ、は残してある。
- `mc.explore-for-structure` による村探しは外した（最初の一歩を重くするため）。

## draft-3 との関係（本番）

- draft-3 は本番に導入済み（`mc-bed-before-night` 版 1、trial、operator_authored）。draft-4 はその同名 skill の新しい版として、通常の改訂経路（`SkillMemory.revise`、operator_authored）で書く。基になる本文は draft-3 と完全一致（SHA-256 `54eb66a3…`）でなければ入らない（`revision_base_changed`）。
- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial` で止まる）。要点が辿られていないので、利用 0 のはずだが、**dry-run で確かめる**。`on_trial` になった時は同名では入らない。その場合は別名の新 skill（例 `mc-bed-first`）で出し直し、`minecraftSkillPointers.ts` の宛先を替える（その時は相談）。
- 出し方（指す条件）はコード側。暗くなるまで 10 分以内かつ 1 分より先（`BED_LEAD_SECONDS` 600）。羊を探して居なかった日は、その日はもう指さない。

## 導入（本番）

owner の承認が要る別の段階。root担当が公開済みの exact source で次を行う。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-4
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-4 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、`mc-bed-before-night` に `(revises)` が付く、capacity は used が現状のまま・added 0（改訂は枠を増やさない）、skill の SHA-256 が manifest と一致。
- `mc-night-retreat` など他の skill には触れない。
- 改訂後の版は、利用 0 の試しのまま続く（`operator_authored`、provenance は draft-3 のまま）。
