---
name: mc-iron-and-bucket
description: 鉄を掘り、つるはし→バケツ→鉄の全身の防具の順に作る
---

## 手順
オーバーワールドで、ベッドと食料があり、鉄のツルハシ・バケツ・鉄の全身の防具のどれかがまだ無い時に使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、持ち物（鉄鉱石・石炭・食料・作業台）と体力・空腹を新しく読む。
2. 鉄鉱石は一度に掘る: mc.mine-block（blockName=iron_ore、count=30、searchRadius=48）。途中で止まったら同じ呼び方で続き。
3. かまどを2台置き、raw_iron を半分ずつ入れる（1台に15個で約150秒）。焼ける間は待たず、石炭・肉を焼く・羊を探す。
4. 作る順はツルハシ→バケツ→胸当て→兜・脚・靴→予備のツルハシ。全身を着てから深い層やダイヤへ降りる（受ける傷が約6割減る）。
5. 鉄の数: ツルハシ3・バケツ3・兜5・胸当て8・レギンス7・ブーツ4・予備のツルハシ3で33個。3個や8個ずつ掘って精錬を待つのを繰り返さない。
6. 鉄が足りない時は別の層や別の洞窟を探す。同じ場所の失敗を繰り返さない。盾は板6と鉄1。
7. 体は持っている防具を自分で着るので、着たかは観測の装備で確かめる。掘った・作った数は新しい観測の所持数で確かめる。
8. 暗くなる前に作業台と炉の近くへ戻る。夜やダメージ中は mc-night-retreat か mc-low-health へ。全身の防具ができたら mc-diamond-obsidian へ。

使う道具（名前と引数。身体の catalog が正）:
- 探す・掘る: mc.find-blocks（blockName=iron_ore）、mc.mine-block（blockName=iron_ore、count=30、searchRadius=48）
- 精錬: mc.start-smelting（かまどの座標、inputItem=raw_iron、fuelItem=coal）を2台に分けて。肉は空いた方で（inputItem=beef など）。取り出す: mc.withdraw-from-furnace
- かまど: mc.craft-one（itemName=furnace）→ mc.place-block-at
- 作る: mc.craft-one（itemName=iron_pickaxe、bucket、iron_chestplate、iron_helmet、iron_leggings、iron_boots、shield）。着る: mc.equip-item（itemName=iron_chestplate、destination=torso）

## 補助
同じ場所で掘れない・見つからない・足場が悪い時は、場所を変えるのを先にする。夜に深い所へ降りるのは、防具・焼いた食料・ベッドがそろってから（体が断ることがある）。洞窟でクリーパーを見たら戦わずに離れる（逃げ道が無ければ tower-up で3段上る）。

## 参考
運用側が旧Minebot実験の知識（mc-nether-portal の鉄の順序）と、本番 Minecraft run 14 で鉄のツルハシまでに時間がかかった観測から切り出した試しの手順で、シャノンの成功経験ではない。draft-8 は実走16 と owner の指示（全身の防具、予備のツルハシ、精錬の間に近くの鉄を掘る、かまど2個）を受けた版。draft-9 は実走17（鉄を3・8・8・13個に分けて掘り、そのたびに精錬して待った、予備のツルハシを作らなかった）を受けて、一度に30個・2台に分けて・予備のツルハシまでを要点に置いた版。importは利用0・成功0から始まる。
