---
name: mc-ender-eyes
description: ブレイズロッドの後、エンダーパールを集めてエンダーアイを作る
---

## 手順
ブレイズロッドかブレイズパウダーを持ち、エンダーアイがまだ12個に足りない時に使う。ネザーでもオーバーワールドでも使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、持ち物（ロッド・パール・金・金の防具）・次元・体力・食料を新しく読む。
2. 要る数: アイは12＋投げる分で15ほど。アイ1＝パール1＋パウダー1、ロッド1でパウダー2。
3. パールはピグリンと交換。先に金の防具を1つ着ける: mc.equip-item（itemName=golden_boots、destination=feet）。
4. mc.use-item-on-entity（itemName=gold_ingot、entityName=piglin、count=8）。返った物は拾う。
5. 作り方: mc.craft-one（itemName=blaze_powder）、次に mc.craft-one（itemName=ender_eye）。パール15・ロッド8が目安。
6. 金: 金鉱石（nether_gold_ore）を掘ると金塊、9個で金インゴット。金のブーツは金4。ピグリンの近くで金ブロックやチェストを壊さない（怒る）。ゾンビピグリンは殴らない（群れで来る）。
7. 交換の当たりは確率で、パールは約20〜50回に1回、2〜4個。金が尽きたらエンダーマン（ネザーの歪んだ森、夜の平原）を mc.attack-continuously（entityName=enderman）で狩る。目を合わせると襲ってくる。頭にくり抜いたカボチャを着ければ怒らない。天井が2マスの所に立つと背の高いエンダーマンは入れない。
8. 次元の規則: ネザーの1マスはオーバーワールドの8マス。ネザーでベッドを使うと爆発する（寝ない・右クリックしない）。ボートは使わない。
9. アイが12個ほどになったら、オーバーワールドで mc-stronghold（三角測量）へ。

## 補助
落とし物は5分で消えるので、交換や狩りの後はすぐ mc.pickup-nearest-item（ender_pearl）で拾う。体力が半分を切ったら mc-low-health。ネザーの移動は mc-nether-travel。

## 参考
運用側が旧Minebot実験の知識（seed-piglin-barter、seed-blaze-slit-cage のアイの数）と、身体の catalog の説明（use-item-on-entity はピグリンに gold_ingot を渡して物々交換）から書いた試しの手順で、シャノンの成功経験ではない。旧ではピグリン交易が取り込みから外れていた。エンダーマンの手順は運用作成の仮説。importは利用0・成功0から始まる。
