---
name: mc-bed-before-night
description: マイクラで日暮れ前に、ベッドで夜を丸ごと飛ばす（羊毛3個＋板材3個）
---

## 手順
オーバーワールドで、ベッドを持っていない昼に使う（石のツルハシがあれば一日中、そうでなければ日暮れ前の10分）。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、時刻・持ち物（ベッド・羊毛・板材）・近くの動物を新しく読む。
2. ベッド1つで夜を丸ごと飛ばせる。村の家のベッドは寝ている村人がいなければ mc.sleep-in-bed でそのまま使える。
3. 村が分かれば村へ。無ければ mc.find-nearest-entity（sheep）を1回。いれば3頭倒し羊毛3＋板材3で mc.craft-one。6分か12決定まで。
4. 羊も村も無い・敵が近い・暗くなる1分前で未入手なら今日は諦め mc-night-retreat へ。
5. 村は mc.recall-places（kind=village）か mc.find-structure（structureType=village）で確かめる。遠くの村探しで一日を使い切らない。
6. 羊は mc.attack-continuously（entityName=sheep）で倒して羊毛を3個（同じ色）集め、板材3個と mc.craft-one でベッドにする。
7. 持ち歩くなら、朝に壊して拾う。置けたらその場所を覚えておく。羊毛の色は混ぜない。
8. 探すのは6分か12決定まで。暗くなったらベッドがあれば mc.sleep-in-bed で眠り、無ければ mc-night-retreat へ。探している間に敵が近づいたら探索をやめて mc-night-retreat に切り替える。

## 補助
羊が近くにいない日は、探し回らずに諦めてよい。ベッドが手に入った夜は地下で待つ必要が無く、朝まで眠って次の日に進める。

## 参考
運用側が旧Minebot実験の知識（seed-bed-from-sheep, seed-night-surface）から選んだ試しの手順で、シャノンの成功経験ではない。mc-night-retreat の4番にあるベッドの話を、日暮れ前に先行して取りに行く手順として分けた。draft-4 は、ベッドの利点と村の近道を先頭に置き、探す順序と上限、諦めの行き先（mc-night-retreat）を要点に入れて書き直した版。
