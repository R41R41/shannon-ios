---
name: mc-ender-eyes
description: ブレイズロッドの後、エンダーパールを集めてエンダーアイを作る
---

## 手順
ブレイズロッドかブレイズパウダーを持ち、エンダーアイがまだ12個に足りない時に使う。ネザーでもオーバーワールドでも使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、持ち物（ロッド・パール・金・金の防具）・次元・体力・食料を新しく読む。
2. 要る数: アイは12＋投げる分で15ほど。アイ1＝パール1＋パウダー1、ロッド1でパウダー2（ロッド8が目安）。
3. パールはピグリンとの物々交換が早い。金の防具を1つ着けてから金インゴットを渡す（着けないと襲われる）。
4. 交換の当たりは確率（パールは約20〜50回に1回、版により2〜8個）。金が尽きたらエンダーマンを狩る。ボートは使わない。
5. 金: 金鉱石（nether_gold_ore）を掘ると金塊、9個で金インゴット。金のブーツは金4。ピグリンの近くで金ブロックやチェストを壊さない（怒る）。ゾンビピグリンは殴らない（群れで来る）。
6. エンダーマンはネザーの歪んだ森や夜の平原にいる。目を合わせると襲ってくるが、くり抜いたカボチャを頭に着ければ怒らない。天井が2マスの所に立つと入ってこられない。
7. 次元の規則: ネザーの1マスはオーバーワールドの8マス。ネザーでベッドを使うと爆発する（寝ない・右クリックしない）。
8. 落とし物は5分で消える。交換や狩りの後はすぐ拾う。アイが12個ほどになったら mc-stronghold（三角測量）へ。

使う道具（名前と引数。身体の catalog が正）:
- 金の防具: mc.equip-item（itemName=golden_boots、destination=feet）
- 交換: mc.use-item-on-entity（itemName=gold_ingot、entityName=piglin、count=8）
- エンダーマン: mc.attack-continuously（entityName=enderman）
- 拾う: mc.pickup-nearest-item（itemName=ender_pearl）
- 作る: mc.craft-one（itemName=blaze_powder、その後 ender_eye）

## 補助
体力が半分を切ったら mc-low-health。ネザーの移動は mc-nether-travel。

## 参考
運用側が旧Minebot実験の知識（seed-piglin-barter、seed-blaze-slit-cage のアイの数）と、身体の catalog の説明（use-item-on-entity はピグリンに gold_ingot を渡して物々交換）から書いた試しの手順で、シャノンの成功経験ではない。旧ではピグリン交易が取り込みから外れていた。エンダーマンの手順は運用作成の仮説。importは利用0・成功0から始まる。
