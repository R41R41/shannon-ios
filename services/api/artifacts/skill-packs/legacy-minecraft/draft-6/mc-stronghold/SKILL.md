---
name: mc-stronghold
description: エンダーアイを投げて要塞を三角測量し、ポータルの部屋を開く
---

## 手順
オーバーワールドで、エンダーアイを持ち要塞を探す時に使う（12個に足りなくても場所は先に探せる）。旧実験に知識は無く、身体のcatalogから組んだ運用作成の試しで、現在の観測を優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、位置・持ち物（アイ・ベッド・食料・丸石）・時刻を新しく読む。
2. 要塞はアイの飛ぶ向きで探す。50〜100m離れた2地点で1つずつ投げ、2本の向きの線が交わる所が要塞。
3. 交点へは1回400〜500mずつ近づき、64m以内で周りを探す。近くでもう一度投げ、目玉が下へ向かえば真下。
4. 要塞の中ではポータルの部屋を探す。部屋の階段の上にあるシルバーフィッシュのスポナーを先に壊す。
5. 枠は12個。まだ目の無い枠に1つずつアイをはめる。12枠がそろうと面ができる。
6. 入る前に、部屋の近くにベッドを置いて右クリックし、リスポーン地点にする（昼でも決まり、寝る必要はない）。エンドで死んでもここから戻れる。
7. 投げたアイは5回に1回ほど割れる。落ちたら拾う。地点AとBが近すぎると交点がずれる。ネザーでは要塞の方角は読めない。
8. 入る前に mc-travel-kit の持ち物（弓・矢32以上・くり抜いたカボチャ・水入りバケツ・食料・丸石64以上）を確かめる。エンドでは mc-end-fight。ネザー・エンドでベッドを使うと爆発する。

使う道具（名前と引数。身体の catalog が正）:
- 投げる: mc.use-item（itemName=ender_eye）。すぐ目玉の座標を mc.find-nearest-entity（entityType=eye_of_ender）で読む。結果に方角があればそれを使う。mc.list-nearby-entities は目玉が出ているかだけで、座標は出ない。
- 近づく: mc.move-to（x、z）。探す: mc.find-structure（structureType=stronghold）、mc.explore-for-structure（structureType=stronghold）。下る: mc.stair-mine
- スポナー: mc.mine-block（blockName=spawner）。拾う: mc.pickup-nearest-item（itemName=ender_eye）
- 枠: mc.find-blocks（blockName=end_portal_frame、count=12）→ mc.use-item-on-block（枠の座標、itemName=ender_eye）
- 地点: mc.place-block-at（blockName=white_bed など）→ mc.activate-block（blockName=置いたベッド）

## 補助
身体が投げた目玉の方角を結果に添える拡張を進めている。方角が結果にあればそれを使い、無い時は自分の位置と目玉の座標から読む。

## 参考
運用側が書いた試しの手順で、旧Minebot実験にもシャノンの経験にも無い（旧の到達はブレイズロッドまで）。三角測量は通常の遊び方の知識。importは利用0・成功0から始まる。
