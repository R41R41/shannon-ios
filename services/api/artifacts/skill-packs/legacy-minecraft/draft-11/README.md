# 旧Minecraft実験からの試し手順（draft-11）: 実走19 と「30 分でネザー」を受けた 3 本の改訂

背景: 本番の実走19（2026-10-20、30 分、64 決定）で、イグルーのベッドが D1 から場所の記憶にあり、D10 には 13 m まで近づいたのに、取りに行かなかった。羊の出ない雪原を南へ 130 m 探し、凍った海で鮭を 334 秒追った。171 m 東の村へは向かわなかった。燃料に原木を使い（近くに石炭の鉱石があった）、鉄は約 55 個掘って約 22 個余らせた。

## この版でやること

- 改訂 3 本（`revises`）。基の本文は、本番の現行版と SHA-256 が一致することを 2026-10-20 の本番 DB で確かめた。3 本とも利用は 0。
  - `mc-food-and-bed`（基は draft-10）
    - 置かれたベッドは壊せば持てる。場所の記憶に bed があれば、羊より先に取りに行く（move-to → dig-block-at）。
    - 羊の出る所（草原・平原・森・タイガ・村のまわり）と、出ない所（雪原・荒野・砂漠・海・氷）。
    - 食料は陸の動物を先に。水の中の追いは最後。
    - 燃料は石炭を先に。
  - `mc-iron-and-bucket`（基は draft-9）
    - 燃料は石炭を先に。石炭の鉱石が見えたら先に掘る。
    - 鉄は、かまどの中と作った物も数え、33 で止める。
  - `mc-diamond-obsidian`（基は draft-9。owner 2026-10-20「30分以内にスムーズにネザーに行けるくらい」）
    - y=-58 の枝掘り（stair-mine targetY=-58 → mine-block deepslate_diamond_ore,diamond_ore searchRadius=32）。
    - 溶岩の溜まりに水バケツをかけて黒曜石、ダイヤのツルハシで 10 個。
    - 砂利から火打石、火打ち金。
    - ゲートの 4×5 の枠（build-structure nether_portal）と入り方（enter-portal）。
    - 節目ごとの時間の目安。
    - 近道として、荒廃したポータル（枠の黒曜石、箱の火打ち金）と村の鍛冶屋の箱（鉄・黒曜石）。
  - `mc-iron-and-bucket` には、鍛冶屋の箱の鉄と、鉄の全身を着ていれば夜も地下で掘り続けることも足した。
- 枠は変わらない（新設 0）。
- コードの側（同じブランチ）
  - ベッドが無く、場所の記憶にベッドがある時は、昼の reminders と節目の手順の先頭に「取りに行く」手を出す。
  - 羊が見えず、羊の出ないバイオームにいて、場所の記憶に村がある時は、村へ向かう手を出す。

## 本番との関係

- 改訂できるのは、現行版に利用が 1 件も無い間だけ（`on_trial`）。次の実走の後に入れる時は、**dry-run で確かめる**。1 本でも `on_trial` があれば、その 1 本を外した版を作り直す。
- **順番**: 1. 体の be82ca8（codex/shannon/mb-body-r19。dig-block-at の takeEquipment の確かめ、explore-for-structure の structureType=bed）。2. 同じブランチの API コード（`standardSkillPack` が draft-11 を読む）。3. draft-11 の dry-run と取り込み。
- 本文は道具の呼び方だけを書き、場所の記憶の行の形には頼らない。

## 導入（本番）

owner の承認が要る別の段階。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-11
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-11 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、3 本が `(revises)`、capacity は added 0、SHA-256 が manifest と一致。
