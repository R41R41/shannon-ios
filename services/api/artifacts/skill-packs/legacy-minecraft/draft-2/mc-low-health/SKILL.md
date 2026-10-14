---
name: mc-low-health
description: マイクラで体力が半分以下・撃たれて逃げ切れない時に囲って回復
---

## 手順
体力が半分以下の時、遠くから撃たれている時、追われて逃げ切れない時に使う。オーバーワールドでもネザーでも使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、体力・満腹度・敵・足元・液体・落下先を新しく読む。
2. 逃げ続けない。建築用ブロック約10個とハーフブロック4個があれば、その場で mc.build-around-self（structureName=slit_shelter、数秒）を建てる。掘らないので橋の上でも使える。殴る敵がもう隣にいる時は間に合わないので、立ち止まって mc.attack-continuously（holdPosition=true）で迎え撃つ。
3. 囲いの中で食べる（mc.use-item で焼いた食料など）。体力は満腹度18以上の時しか自然に戻らないので、満腹度を高く保って回復を待つ。
4. 敵がいないのに体力が減る時は、火・溶岩を疑い、溶岩側をブロックで塞ぐ。
5. 囲いの中で近くに敵がいる間は、壁や頭上を掘って出ない。mc.list-nearby-entities で敵がいないことを確かめ、足場・液体・落下先・退路を見てから出る。
6. 体力が戻ったら元の目的へ戻る。同じ危ない場所へそのまま戻らない。

## 補助
水辺へ逃げない（mc-night-retreat）。食料が無ければ、回復後に食料の確保を先にする（mc-food-and-pace）。操作の受付を安全の証明にしない。

## 参考
運用側が旧Minebot実験の知識から選んだ試しの手順で、シャノンの成功経験ではない。原典: seed-slit-shelter（支持9・反証3）, seed-shelter-stay-sealed, k-84bf2aaa, k-38a0e02d, k-add2d62e, k-4d837c22, k-2a290f18, seed-food-stock-before-depth。旧実験で体力2から囲い→食事→回復で立て直した1回に対応する。詳細は selection-report.json。importは利用0・成功0から始まる。
