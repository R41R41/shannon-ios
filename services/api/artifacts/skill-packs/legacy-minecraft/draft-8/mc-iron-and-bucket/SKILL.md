---
name: mc-iron-and-bucket
description: 鉄を掘り、つるはし→バケツ→鉄の全身の防具の順に作る
---

## 手順
オーバーワールドで、ベッドと食料があり、鉄のツルハシ・バケツ・鉄の全身の防具のどれかがまだ無い時に使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、持ち物（鉄鉱石・石炭・食料・作業台）と体力・空腹を新しく読む。
2. 鉄鉱石を30個ほど掘る: mc.mine-block（blockName=iron_ore、count=16 を2回）。ツルハシ3・バケツ3・全身の防具24に使う。
3. かまどを2個置き、一方で鉄、もう一方で肉を焼く。焼き上がりを炉の前で待たず、近くの鉄・石炭を掘る・木を集める・羊を探す。
4. 作る順はツルハシ→バケツ→胸当て→兜・脚・靴。全身を着てから深い層やダイヤへ降りる（受ける傷が約6割減る。夜のゾンビに効く）。
5. 防具の鉄の数: 兜5・胸当て8・レギンス7・ブーツ4で24。余裕があれば予備の鉄のツルハシ（鉄3）も作る。合わせて鉄30〜33個。
6. 鉄が足りない時は別の層や別の洞窟を探す。同じ場所の失敗を繰り返さない。盾は板6と鉄1。
7. 体は持っている防具を自分で着るので、着たかは観測の装備で確かめる。掘った・作った数は新しい観測の所持数で確かめる。
8. 暗くなる前に作業台と炉の近くへ戻る。夜やダメージ中は mc-night-retreat か mc-low-health へ。全身の防具ができたら mc-diamond-obsidian へ。

使う道具（名前と引数。身体の catalog が正）:
- 探す・掘る: mc.find-blocks（blockName=iron_ore）、mc.mine-block（blockName=iron_ore、count=16）
- 精錬: mc.start-smelting（かまどの座標、inputItem=raw_iron、fuelItem=coal）。肉は別のかまどで（inputItem=beef など）。取り出す: mc.withdraw-from-furnace
- かまど: mc.craft-one（itemName=furnace）→ mc.place-block-at
- 作る: mc.craft-one（itemName=iron_pickaxe、bucket、iron_chestplate、iron_helmet、iron_leggings、iron_boots、shield）。着る: mc.equip-item（itemName=iron_chestplate、destination=torso）

## 補助
同じ場所で掘れない・見つからない・足場が悪い時は、場所を変えるのを先にする。夜に深い所へ降りるのは、防具・焼いた食料・ベッドがそろってから（体が断ることがある）。

## 参考
運用側が旧Minebot実験の知識（mc-nether-portal の鉄の順序）と、本番 Minecraft run 14 で鉄のツルハシまでに時間がかかった観測から切り出した試しの手順で、シャノンの成功経験ではない。draft-8 は実走16（鉄11個でツルハシとバケツだけ作り、防具0のまま夜のダイヤ掘りでゾンビに倒された、精錬の間に70秒待った）と owner の指示（全身の防具を作ってから、余裕があれば予備のツルハシ、精錬の間に近くの鉄を掘る、かまど2個で鉄と肉を分ける）を受けて、進め方と道具の呼び方を分けた版。importは利用0・成功0から始まる。
