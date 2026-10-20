---
name: mc-food-and-bed
description: 鉄より先に食料とベッド。置かれたベッドを先に。羊は草地と村
---

## 手順
オーバーワールドで、石のツルハシがあり、ベッドか食料（6個）が無い時に使う。日暮れの10分前からは段階に関係なく使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、時刻・持ち物・近くの動物・場所の記憶・バイオームを新しく読む。
2. 置かれたベッドは、壊せば持てる（takeEquipment=true）。場所の記憶に bed がある時（イグルー・村の家など）は、羊より先にそこへ行き、壊して持つ。
3. 羊は草原・平原・森・タイガ・村のまわりに出る。雪原・荒野・砂漠・海・氷の上には出ない。そこでは探し続けず、記憶の村か草地の方角へ移る。
4. 羊を探す: mc.find-nearest-entity（entityType=sheep、maxDistance=128）。見つけた羊はすぐ狩る: mc.attack-continuously（entityName=sheep、maxKills=3）。128 m に居なければ mc.explore-for-structure（structureType=sheep、color=持っている羊毛の色）を方角を変えて。村も同じ道具（structureType=village、maxDistance=160）を2回。夜に逃したら明けてすぐ。
5. 羊毛が同じ色で3個たまったらすぐ mc.craft-one（itemName=white_bed など）でベッドを作る。色違いでは作れない: 持っている色の羊を狩る。
6. 生肉が3個たまったら、食べる前に mc.start-smelting（inputItem=beef など）で焼く。焼く間は待たない。燃料は石炭を先に。
7. 食料は陸の動物を先に。水の中の魚は最後: 水中で追うと息継ぎで止まり、岸へ戻れなくなる。
8. 鉄のツルハシの後でも、ベッドと焼いた食料6個が先（節目がそう言う間）。ベッドがあれば夜を飛ばせる。
9. 村があれば先に村へ。家のベッドは壊して持って行け、チェスト・干し草の俵・畑から食料が取れる（回収の決まりは補助）。
10. 暗くなったらベッドで寝る（近くに敵がいると寝られない）。朝は壊して拾い、持ち歩く。羊も村も無い日は、焼いた食料だけそろえて鉄へ（mc-iron-and-bucket）。暗くなる1分前でベッドが無い・敵が近い時は mc-night-shelter へ。

使う道具（名前と引数。身体の catalog が正）:
- 置かれたベッドを取る: mc.move-to（x、y、z、goalType=near、range=2）→ mc.dig-block-at（x、y、z、takeEquipment=true）。探す: mc.explore-for-structure（structureType=bed）
- 羊を探す: mc.find-nearest-entity（entityType=sheep、maxDistance=128）。探しに出る: mc.explore-for-structure（structureType=sheep、color=white など、direction=north など）
- 村: mc.explore-for-structure（structureType=village、direction=north など、maxDistance=160）。見える範囲だけ: mc.find-structure（structureType=village）。記憶にある村へ: mc.move-to（村の座標、goalType=near、range=8）
- 狩る: mc.attack-continuously（entityName=sheep か food_animals、maxKills=3 や 4。羊は color=white など持っている羊毛の色）。剣を持つ: mc.equip-item（itemName=stone_sword、destination=hand）
- ベッド: mc.craft-one（itemName=white_bed など、羊毛の色の _bed）。寝る: mc.sleep-in-bed
- 焼く: mc.start-smelting（かまどの座標、inputItem=beef など、fuelItem=coal。石炭が無い時だけ oak_planks）。取り出す: mc.withdraw-from-furnace

## 補助
村の回収: チェストは壊さず（mc.find-blocks blockName=chest,barrel → mc.check-container → mc.withdraw-from-container）、中を見て要る物（パン・食料・鉄・糸・ベッド）だけ取る。干し草の俵（mc.mine-block blockName=hay_block）は崩すと小麦9個、小麦3個でパン。実った作物も取る。村人とアイアンゴーレムは攻撃しない。村の中で動物や敵をまとめて狩らない。羊を探すのは6分か12決定まで、村を探すのは方角を変えて2回、約5分まで。同じ方角を二度探さない。平原・サバンナ・タイガは村が、草地は羊がいる見込みが高い。雪原のイグルーには地下室とベッドがあることが多い。食料が尽きてから集めない（夜は地上へ出にくい）。生の肉は焼く物が無い時だけ食べる。昼で危険が無い時は、体力が少し減っただけでは食べない（満腹なら自然に回復する）。

## 参考
運用側が旧Minebot実験の知識（seed-bed-from-sheep、seed-village-in-sight、seed-food-before-empty、seed-food-stock-before-depth）と、本番の実走15（食料0・ベッド無しで夜になり4回死亡）から書いた試しの手順で、シャノンの成功経験ではない。mc-bed-before-night と mc-opening-scout の後継。draft-8 は実走16、draft-9 は実走17、draft-10 は実走18（羊も村も一度も探さなかった）を受けた版。draft-11 は実走19（イグルーのベッドが最初から場所の記憶にあり、13 m まで近づいたのに取らなかった。羊の出ない雪原を南へ130 m 探し、凍った海で鮭を334秒追った。171 m 東の村へは向かわなかった）を受けて、置かれたベッドは壊せば持てる・羊の出る所と出ない所・水の中の追いは後、を要点に置いた版。importは利用0・成功0から始まる。
