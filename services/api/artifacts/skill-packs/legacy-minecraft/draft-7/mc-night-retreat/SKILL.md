---
name: mc-night-retreat
description: マイクラの夜や敵の接近時、待たずに地下作業か近場へ退避する
---

## 手順
オーバーワールドの夕暮れ・夜、または敵が近く退避が必要な時に使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 現在のFCAに minecraft.observe がある時だけ、体力・空腹・酸素・水中か・敵・周囲の足場を新しく読む。観測が届かなければ安全になったと推測しない。
2. ベッドを持ち、敵が8マスより遠ければ、暗くなってすぐ mc.sleep-in-bed で夜を飛ばす。朝はベッドを拾い持ち歩く。
3. ベッドが無ければ地上をさまよわず、すぐ mc.dig-shelter で縦穴に入り頭上を塞ぐ。中で食べ、クラフトを進める。
4. 体力と食料に余裕があれば、穴から mc.stair-mine で地下へ下り鉄・石炭を掘る。地上の用事は日が出てから。
5. 地上でしかできない用事（食料・木・羊）は明るくなってから。体力が半分以下なら mc-low-health。食料が無い夜は穴の中で精錬やクラフトを進め、明るくなったらすぐ食料（mc-food-and-bed）。
6. 敵から逃げる時は水辺へ逃げない。乾いた近場の足場と遮蔽を確かめる。水の中なら mc.leave-water。囲いが要るなら mc.build-around-self（structureName=slit_shelter）。
7. 塞いだ中で敵が近い間は掘って出ない。出る前に時刻と敵（mc.list-nearby-entities）を確かめる。

## 補助
unknownの身体操作は元の結果を待つ。遮蔽の受付を生存の証明にしない。旧実験の退避には失敗や被ダメージもあり、死亡回避の保証はない。夜の前にベッドと食料をそろえておけば、この手順はほとんど要らない（mc-food-and-bed）。

## 参考
運用側が旧Minebot実験の知識から選んだ試しの手順で、シャノンの成功経験ではない。原典: k-76a3237b, seed-night-surface（支持17・反証7）, seed-shelter-stay-sealed, seed-bed-from-sheep, k-d5dd8eef。draft-7 は、本番の実走15（食料0・ベッド無しで夜になりゾンビで4回死亡）を受けて、最初の一手（ベッドがあれば mc.sleep-in-bed、無ければ mc.dig-shelter）を道具の名前で要点の先頭に置いた版。詳細は draft-2 の selection-report.json。importは利用0・成功0から始まる。
