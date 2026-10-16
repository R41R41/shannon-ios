---
name: mc-bed-before-night
description: マイクラで日暮れ前にベッドが無い時、羊毛か村でベッドを手に入れる
---

## 手順
オーバーワールドで暗くなる前、ベッドを持っていない時に使う。ベッドは夜を飛ばし、リスポーン地点にもなる。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、時刻・持ち物（ベッド・羊毛・板材）・近くの動物を新しく読む。
2. 羊を mc.find-nearest-entity（entityType=sheep）で探し、倒して羊毛3個（同じ色）を集める。
3. 羊毛3個と板材3個で mc.craft-one（ベッド）。羊がいない地形は mc.explore-for-structure（village）で村へ行く。
4. 暗くなる1分前までに手に入らなければ諦め、mc-night-retreat へ。手に入れたら暗くなってから mc.sleep-in-bed。
5. 村の家のベッドは、寝ている村人がいなければそのまま mc.sleep-in-bed で使える。持ち歩くなら、朝に壊して拾う。
6. 探している間も敵が近づいたら探索をやめて mc-night-retreat に切り替える。夜の地上をベッドを探して歩き回らない。

## 補助
夜になったら探さず、mc-night-retreat の地下作業を優先する（地下で過ごす方針は変えない）。羊毛の色は混ぜない。ベッドを置けたらその場所を覚えておく。

## 参考
運用側が旧Minebot実験の知識（seed-bed-from-sheep, seed-night-surface）から選んだ試しの手順で、シャノンの成功経験ではない。mc-night-retreat の4番にあるベッドの話を、日暮れ前に先行して取りに行く手順として分けた。importは利用0・成功0から始まる。
