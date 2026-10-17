---
name: mc-opening-scout
description: 石のツルハシの後、羊・村・食料の当たりを付けて動く
---

## 手順
オーバーワールドの昼に、石のツルハシを持ちベッドがまだ無い時に使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、biome・時刻・持ち物・近くの動物と地形を新しく読む。
2. biome と動物から羊と村の見込みを読む。羊は mc.find-nearest-entity（sheep）を1回。
3. 村は mc.recall-places か mc.find-structure。無ければ食料を集めつつ mc.explore-for-structure（village）。
4. 羊か村が見つかればベッドへ（mc-bed-before-night）。無い日は食料を確保して鉄へ進む。
5. 平原・サバンナ・砂漠・タイガは村が、草地は羊がいる見込みが高い。洞窟や海ばかりの所は羊も村も薄い。mc.recall-places（kind）と mc.find-structure（structureType）は village を指す。
6. 食料は牛・豚・鶏を mc.attack-continuously（entityName）で狩る。羊は羊毛3個ぶんを残す。
7. 斧が無ければ板材と棒で作る。探すのは昼のうち、暗くなる1分前や敵が近い時は mc-night-retreat へ。

## 補助
同じ方角を二度探さず、見つからなかった範囲は覚えて別の方角へ。食料が減ったら探索より先に食べる。鉄に進んでよい目安は、焼いた肉などの食料が十数個ある時。

## 参考
運用側が旧Minebot実験の知識と、本番 Minecraft run 14 の序盤（石のツルハシから鉄のツルハシまで）の観測から選んだ試しの手順で、シャノンの成功経験ではない。羊や村を見つける順序の目安であり、biome ごとの見込みは過去の知識で反証もありうる。
