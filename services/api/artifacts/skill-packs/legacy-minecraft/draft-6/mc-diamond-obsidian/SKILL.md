---
name: mc-diamond-obsidian
description: 鉄とバケツの後、ダイヤのツルハシ→黒曜石10個→ネザーのゲート
---

## 手順
オーバーワールドで、鉄のツルハシとバケツがあり、ネザーへまだ行っていない時に使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、持ち物（ダイヤ・黒曜石・バケツ・火打石）・体力・食料・高さを新しく読む。
2. 鉄とバケツの次はダイヤ。ダイヤは深い層（高さ -54 あたり）にあり、鉄のツルハシで掘る。3個でダイヤのツルハシ。
3. 黒曜石はダイヤのツルハシでしか掘れない。ゲートには黒曜石が最小10個要る。
4. 黒曜石は溶岩源（流れていない溶岩）に水をかけて作る。流れる溶岩は丸石になる。水はバケツで汲み戻す。
5. 深い層では溶岩の上を掘らない。足元と前を確かめ、溶岩が見えたら丸石で塞ぐ。
6. ゲートは4×5の枠（角は要らない）。火打ち金（鉄1＋火打石。火打石は砂利から）で火をつけ、面の中へ入る。
7. 入る前の目安: 焼いた食料十数個、丸石64以上、ハーフブロック、鉄の防具と盾、予備のツルハシ。弓矢などは mc-travel-kit。全部そろうまで待ち続けない。
8. ネザーの1マスはオーバーワールドの8マス。帰りのゲートの場所は覚えておく。

使う道具（名前と引数。身体の catalog が正）:
- 深い層へ: mc.stair-mine（targetY=-54）
- 掘る: mc.mine-block（blockName=diamond_ore、count=3）、黒曜石は（blockName=obsidian、count=10）
- 溶岩源: mc.find-blocks（blockName=lava）。水をかける: mc.use-item-on-block（溶岩の座標、itemName=water_bucket）
- 作る: mc.craft-one（itemName=diamond_pickaxe、flint_and_steel）
- ゲート: mc.build-structure（structureName=nether_portal、置く座標）。入る: mc.enter-portal（面の座標）。場所: mc.recall-places

## 補助
黒曜石を鉄のツルハシで掘ろうとしない（何も落ちない）。所持が増えたかは新しい観測の所持数で確かめる。同じ溶岩だまりで失敗が続いたら別の溶岩源を探す。

## 参考
運用側が旧Minebot実験の知識（mc-nether-portal の原典 k-d2d520e2、k-1be5104b、seed-nether-prepare など）と、身体の catalog の説明（use-item-on-block は水入りバケツで溶岩を黒曜石にする、build-structure の nether_portal は黒曜石10個）から書いた試しの手順で、シャノンの成功経験ではない。mc-nether-portal（鉄のツルハシで黒曜石まで進む誤り）の後継。importは利用0・成功0から始まる。
