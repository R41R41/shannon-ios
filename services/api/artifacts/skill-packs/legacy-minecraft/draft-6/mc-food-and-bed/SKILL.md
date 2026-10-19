---
name: mc-food-and-bed
description: 鉄より先、夜の前に食料とベッド（羊3頭）をそろえる。村の回収
---

## 手順
オーバーワールドで、石のツルハシがあり、ベッドか食料（6個）が無い時に使う。日暮れの10分前からは段階に関係なく使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、時刻・持ち物（ベッド・羊毛・板材・食料）・近くの動物・村を新しく読む。
2. 鉄より先に、夜の前に食料6個とベッドをそろえる。ベッドがあれば夜を丸ごと飛ばせ、ゾンビに囲まれない。
3. ベッドは羊3頭の同じ色の羊毛3個＋板材3枚。羊を倒すと羊肉も落ちるので、まず羊を探す。
4. 食料は牛・豚・鶏・羊をまとめて狩り、かまどで焼く。焼き上がりを待たずに次へ進み、できた分を拾う。
5. 村が近ければ先に村へ。家のベッドで寝られ、チェスト・干し草の俵・畑から食料が取れる。
6. 村の回収: チェストは壊さず、中を見て要る物（パン・食料・鉄・糸・ベッド）だけ取る。干し草の俵は崩すと小麦9個、小麦3個でパン。実った作物も取る。家のベッドは壊して持って行ける。村人とアイアンゴーレムは攻撃しない。村の中で動物や敵をまとめて狩らない。
7. 暗くなったらベッドで寝る（夜と嵐の時だけ。近くに敵がいると寝られない）。朝はベッドを壊して拾い、持ち歩く。
8. 羊も村も無い日は、食料だけそろえて鉄へ進む（mc-iron-and-bucket）。暗くなる1分前でベッドが無い・敵が近い時は mc-night-retreat へ。

使う道具（名前と引数。身体の catalog が正）:
- 羊を探す: mc.find-nearest-entity（entityType=sheep）
- 狩る: mc.attack-continuously（entityName=sheep か food_animals、maxKills=3 や 4）
- ベッド: mc.craft-one（itemName=white_bed など羊毛の色の _bed）。寝る: mc.sleep-in-bed
- 焼く: mc.start-smelting（かまどの座標、inputItem=beef など、fuelItem=coal か oak_planks）
- 村: mc.find-structure（structureType=village）。チェスト: mc.find-blocks（blockName=chest,barrel、count=48）→ mc.check-container → mc.withdraw-from-container。干し草: mc.mine-block（blockName=hay_block）。作物: mc.harvest-crop

## 補助
羊を探すのは6分か12決定まで。同じ方角を二度探さない。平原・サバンナ・タイガは村が、草地は羊がいる見込みが高い。食料が尽きてから集めない（夜は地上へ出にくい）。

## 参考
運用側が旧Minebot実験の知識（seed-bed-from-sheep、seed-village-in-sight、seed-food-before-empty、seed-food-stock-before-depth）と、本番の実走15（食料0・ベッド無しで夜になり4回死亡）から書いた試しの手順で、シャノンの成功経験ではない。mc-bed-before-night と mc-opening-scout の後継。importは利用0・成功0から始まる。
