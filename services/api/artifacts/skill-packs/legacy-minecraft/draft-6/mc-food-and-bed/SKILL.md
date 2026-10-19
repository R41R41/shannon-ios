---
name: mc-food-and-bed
description: 鉄より先、夜の前に食料とベッド（羊3頭）をそろえる。村の回収
---

## 手順
オーバーワールドで、石のツルハシがあり、ベッドか食料（6個）が無い時に使う。日暮れの10分前からは段階に関係なく使う。鉄より先にそろえる。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、時刻・持ち物（ベッド・羊毛・板材・食料）・近くの動物・村を新しく読む。
2. ベッドが無ければ最初に mc.find-nearest-entity（entityType=sheep）で羊を探す。
3. いれば mc.attack-continuously（entityName=sheep、maxKills=3）。羊毛3と板3で mc.craft-one（white_bed）
4. 食料が6個未満なら mc.attack-continuously（entityName=food_animals、maxKills=4）。肉は焼く。
5. 羊毛は同じ色を3個。色に合わせて itemName を red_bed などにする。羊肉も拾って食料にする。焼くのは mc.start-smelting（かまど、燃料は石炭か板材）で、待たずに次へ進む。
6. 暗くなったらベッドで mc.sleep-in-bed（夜と嵐の時だけ寝られる）。夜を丸ごと飛ばせ、ゾンビに囲まれない。朝はベッドを壊して拾い、持ち歩く。
7. 村が近ければ先に村へ（mc.find-structure、structureType=village）。家のベッドで寝られ、チェスト・干し草の俵・畑から食料が取れる。
8. 村の回収: チェストは壊さず mc.find-blocks（blockName=chest,barrel、count=48）→ mc.check-container → mc.withdraw-from-container で要る物（パン・食料・鉄・糸・ベッド）だけ取る。干し草の俵は mc.mine-block（blockName=hay_block）で取り、小麦9個に崩してパン（小麦3）にする。実った作物は mc.harvest-crop。家のベッドも壊して持って行ける。村人とアイアンゴーレムは攻撃しない。村の中で food_animals や hostile を指して戦わない。
9. 羊も村も無い日は、食料だけそろえて鉄へ進む（mc-iron-and-bucket）。暗くなる1分前でベッドが無い・敵が近い時は mc-night-retreat へ。

## 補助
羊を探すのは6分か12決定まで。同じ方角を二度探さない。平原・サバンナ・タイガは村が、草地は羊がいる見込みが高い。食料が尽きてから集めない（夜は地上へ出にくい）。

## 参考
運用側が旧Minebot実験の知識（seed-bed-from-sheep、seed-village-in-sight、seed-food-before-empty、seed-food-stock-before-depth）と、本番の実走15（食料0・ベッド無しで夜になり4回死亡）から書いた試しの手順で、シャノンの成功経験ではない。mc-bed-before-night と mc-opening-scout の後継で、最初の一手を道具の名前と引数で書いた。importは利用0・成功0から始まる。
