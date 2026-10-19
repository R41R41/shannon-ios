---
name: mc-stronghold
description: エンダーアイを投げて要塞を三角測量し、ポータルの部屋を開く
---

## 手順
オーバーワールドで、エンダーアイを持ち要塞を探す時に使う（12個に足りなくても場所は先に探せる）。旧実験に知識は無く、身体のcatalogから組んだ運用作成の試しで、現在の観測を優先する。

1. 現在のFCAに minecraft.observe がある時だけ、位置・持ち物（アイ・ベッド・食料・丸石）・時刻を新しく読む。
2. 地点Aで mc.use-item（itemName=ender_eye）、すぐ mc.find-nearest-entity（eye_of_ender）で座標を読む。
3. 自分→目玉の向きが要塞の方角（結果に方角があればそれ）。横へ50〜100m mc.move-to し、地点Bでもう一度。
4. 2本の線の交点へ1回400〜500mずつ mc.move-to。64m以内で mc.find-structure（structureType=stronghold）。
5. 目玉の座標は少し間をおいて2回読むと飛ぶ向きが確かになる。mc.list-nearby-entities で目玉（eye_of_ender）が出ているかも確かめられる（座標は出ない）。投げたアイは5回に1回ほど割れ、落ちたら mc.pickup-nearest-item（ender_eye）で拾う。
6. 交点の近くで見つからなければ、そこで投げる。目玉が下へ向かえば真下にある。mc.stair-mine で下り、mc.explore-for-structure（structureType=stronghold）で石レンガを探す。
7. 要塞の中: ポータルの部屋の階段の上にあるシルバーフィッシュのスポナー（spawner）を mc.mine-block で壊す。
8. ポータルの部屋: mc.find-blocks（blockName=end_portal_frame、count=12）で枠を数え、まだ目の無い枠に1つずつ mc.use-item-on-block（itemName=ender_eye）。12枠がそろうと面ができる（mc.find-blocks で end_portal を確かめる）。
9. リスポーン地点: 入る前に、部屋の近くにベッドを mc.place-block-at で置き、mc.activate-block（blockName=置いたベッド 例 white_bed）で右クリックする。昼でも地点が決まり、寝る必要はない。エンドで死んでもここから戻れる。
10. 入る前に mc-travel-kit の持ち物（弓・矢32以上・くり抜いたカボチャ・水入りバケツ・食料・丸石64以上）を確かめる。エンドでは mc-end-fight。

## 補助
地点AとBの距離が短いと交点がずれる。ネザーで探す時は座標が8分の1になる（ネザーで要塞の方角は読めない）。ネザー・エンドでベッドを使うと爆発する。

## 参考
運用側が書いた試しの手順で、旧Minebot実験にもシャノンの経験にも無い（旧の到達はブレイズロッドまで）。三角測量は通常の遊び方の知識。身体が投げた目玉の方角を結果に添える拡張を進めているので、方角が結果にあればそれを使い、無い時は find-nearest-entity の座標から読む。importは利用0・成功0から始まる。
