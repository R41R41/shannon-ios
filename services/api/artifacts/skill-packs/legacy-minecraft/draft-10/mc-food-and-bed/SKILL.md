---
name: mc-food-and-bed
description: 鉄より先に食料とベッド（羊3頭）。羊は128mまで探す。村の回収
---

## 手順
オーバーワールドで、石のツルハシがあり、ベッドか食料（6個）が無い時に使う。日暮れの10分前からは段階に関係なく使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、時刻・持ち物（ベッド・羊毛・板材・食料）・近くの動物・村を新しく読む。
2. まず羊を探す: mc.find-nearest-entity（entityType=sheep、maxDistance=128）。見えている羊・見つかった羊はすぐ狩る: mc.attack-continuously（entityName=sheep、maxKills=3）。
3. 128 m に羊が居なければ探しに出る: mc.explore-for-structure（structureType=sheep、color=持っている羊毛の色）を方角を変えて。村も同じ道具（structureType=village、maxDistance=160）を2回。夜に逃したら明けてすぐ。
4. 羊毛が同じ色で3個たまったらすぐ mc.craft-one（itemName=white_bed など）でベッドを作る。色違いでは作れない: 持っている色の羊を狩る。
5. 生肉が3個たまったら、食べる前に mc.start-smelting（inputItem=beef など）で焼く。焼く間は待たずに羊探し・木集め・狩りを進める。
6. 鉄のツルハシを作った後でも、ベッドと焼いた食料6個がそろうまでは、これが先（節目がそう言う間）。ベッドがあれば夜を丸ごと飛ばせる。ベッドは同じ色の羊毛3個＋板材3枚。
7. 村があれば先に村へ。家のベッドで寝られ、チェスト・干し草の俵・畑から食料が取れる。村の回収: チェストは壊さず、中を見て要る物（パン・食料・鉄・糸・ベッド）だけ取る。干し草の俵は崩すと小麦9個、小麦3個でパン。実った作物も取る。家のベッドは壊して持って行ける。村人とアイアンゴーレムは攻撃しない。村の中で動物や敵をまとめて狩らない。
8. 暗くなったらベッドで寝る（夜と嵐の時だけ。近くに敵がいると寝られない）。朝はベッドを壊して拾い、持ち歩く。
9. 羊も村も無い日は、焼いた食料だけそろえて鉄へ進む（mc-iron-and-bucket）。暗くなる1分前でベッドが無い・敵が近い時は mc-night-shelter へ。

使う道具（名前と引数。身体の catalog が正）:
- 羊を探す: mc.find-nearest-entity（entityType=sheep、maxDistance=128）。探しに出る: mc.explore-for-structure（structureType=sheep、color=white など、direction=north など）
- 村: mc.explore-for-structure（structureType=village、direction=north など、maxDistance=160）。見える範囲だけ: mc.find-structure（structureType=village）
- 狩る: mc.attack-continuously（entityName=sheep か food_animals、maxKills=3 や 4。羊は color=white など持っている羊毛の色）。剣を持つ: mc.equip-item（itemName=stone_sword、destination=hand）
- ベッド: mc.craft-one（itemName=white_bed など、羊毛の色の _bed）。寝る: mc.sleep-in-bed
- 焼く: mc.start-smelting（かまどの座標、inputItem=beef など、fuelItem=coal か oak_planks）。取り出す: mc.withdraw-from-furnace
- 村の中: チェストは mc.find-blocks（blockName=chest,barrel、count=48）→ mc.check-container → mc.withdraw-from-container。干し草: mc.mine-block（blockName=hay_block）。作物: mc.harvest-crop

## 補助
羊を探すのは6分か12決定まで、村を探すのは方角を変えて2回、約5分まで。同じ方角を二度探さない。平原・サバンナ・タイガは村が、草地は羊がいる見込みが高い。食料が尽きてから集めない（夜は地上へ出にくい）。生の肉は焼く物が無い時だけ食べる。昼で危険が無い時は、体力が少し減っただけでは食べない（満腹なら自然に回復する）。

## 参考
運用側が旧Minebot実験の知識（seed-bed-from-sheep、seed-village-in-sight、seed-food-before-empty、seed-food-stock-before-depth）と、本番の実走15（食料0・ベッド無しで夜になり4回死亡）から書いた試しの手順で、シャノンの成功経験ではない。mc-bed-before-night と mc-opening-scout の後継。draft-8 は実走16 を受けて、村を先に探す・羊毛3個ですぐベッドを作ってみる・生肉は3個で焼くを要点に置いた版。draft-9 は実走17 を受けて、夜に逃したら明けてすぐ探す、を要点に置いた版。draft-10 は実走18（羊が25〜41 m に見えていた最初の5決定でも、節目が「食料と羊とベッド」だった27決定でも、羊も村も一度も探さず、鉄のツルハシの後は鉄だけを進めた）を受けて、羊探しを最初の一手（128 m）にし、居なければ体の新しい探し方（explore-for-structure の sheep）で探しに出る、鉄のツルハシの後でもこれが先、を要点に置いた版。importは利用0・成功0から始まる。
