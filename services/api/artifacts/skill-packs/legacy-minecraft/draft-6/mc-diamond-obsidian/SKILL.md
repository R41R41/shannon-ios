---
name: mc-diamond-obsidian
description: 鉄とバケツの後、ダイヤのツルハシ→黒曜石10個→ネザーのゲート
---

## 手順
オーバーワールドで、鉄のツルハシとバケツがあり、ネザーへまだ行っていない時に使う。順番は ダイヤのツルハシ → 黒曜石10個 → ゲート。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、持ち物（ダイヤ・黒曜石・バケツ・火打石）・体力・食料・高さを新しく読む。
2. ダイヤは mc.stair-mine（targetY=-54）で下り mc.mine-block（blockName=diamond_ore、count=3）。
3. 黒曜石は diamond_pickaxe（ダイヤ3＋棒2）でしか掘れない。溶岩源へ mc.use-item-on-block（water_bucket）。
4. mc.mine-block（blockName=obsidian、count=10）→ mc.build-structure（nether_portal）で建てる。
5. ダイヤは鉄のツルハシで掘る（石のツルハシでは出ない）。深い層では溶岩の上を掘らない。足元と前を確かめ、溶岩が見えたら丸石で塞ぐ。diamond_pickaxe は作業台で mc.craft-one（itemName=diamond_pickaxe）。
6. 黒曜石の作り方: mc.find-blocks（blockName=lava）で溶岩源（流れていない溶岩）を探し、隣に立って water_bucket を持ち、溶岩の座標に mc.use-item-on-block。水が溶岩源を黒曜石に変える（流れる溶岩は丸石になる）。水は空のバケツで汲み戻す。
7. ゲートは最小10個の黒曜石（4×5の枠の角を除く）。足りない数を数えてから掘る。火打ち金（flint_and_steel、鉄1＋火打石。火打石は砂利を掘る）を持っていれば mc.build-structure が着火する。着火したら面（nether_portal）の座標へ mc.enter-portal。
8. 入る前の目安: 焼いた食料十数個、丸石64以上、ハーフブロック、鉄の防具と盾、予備のツルハシ。弓矢などは mc-travel-kit。全部そろうまで待ち続けない。
9. ネザーの1マスはオーバーワールドの8マス。帰りのゲートの位置は覚えておく（mc.recall-places）。

## 補助
黒曜石を鉄のツルハシで掘ろうとしない（何も落ちない）。採掘や応答だけで所持が増えたと決めず、新しい観測の所持数で確かめる。同じ溶岩だまりで失敗が続いたら別の溶岩源を探す。

## 参考
運用側が旧Minebot実験の知識（mc-nether-portal の原典 k-d2d520e2、k-1be5104b、seed-nether-prepare など）と、身体の catalog の説明（use-item-on-block は水入りバケツで溶岩を黒曜石にする、build-structure の nether_portal は黒曜石10個）から書いた試しの手順で、シャノンの成功経験ではない。mc-nether-portal（鉄のツルハシで黒曜石まで進む誤り）の後継。importは利用0・成功0から始まる。
