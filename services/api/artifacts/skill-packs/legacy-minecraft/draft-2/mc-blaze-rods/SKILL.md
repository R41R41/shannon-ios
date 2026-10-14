---
name: mc-blaze-rods
description: ネザー要塞でブレイズのスポナーからロッドを集める時に使う
---

## 手順
ネザー要塞で、ブレイズのスポナーを見た・覚えている時、目的がブレイズロッドの時に使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。

1. 持ち物を確かめる: 建築用ブロック（丸石や要塞のネザーレンガ）約80個、ハーフブロック8個、剣。足りなければ先にそろえる（ハーフブロックは同じ石3個で6個）。
2. スポナーの場所は mc.recall-places（kind=spawner）で思い出す。要塞の通路を歩いてブレイズを探さない。
3. mc.accept-threat（kinds=blaze,wither_skeleton、seconds=120）を呼んでから、スポナーの東西南北どれかの隣（足がスポナーと同じ高さ）へ mc.move-to する。途中のウィザースケルトンは走り抜けず、立ち止まって attack-continuously（holdPosition=true）で倒してから進む。
4. 着いたらすぐ mc.build-around-self（structureName=slit_cage）。開けたまま戦わない。止まったらもう一度呼べば続きから建てる。
5. 中から mc.attack-continuously（entityName=blaze、holdPosition=true）を繰り返す。「手の届く所に来ない」は湧いていないだけなので、追って外へ出ない。
6. 3分ほど戦ったら accept-threat を呼び直し、mc.pickup-nearest-item（itemName=blaze_rod）を見つからなくなるまで繰り返す。終わったら中央へ戻り、build-around-self をもう一度呼んで壁を直す。
7. ロッドが7本以上になるまで5と6を繰り返す。

## 補助
火炎耐性のポーションがあれば先に飲む（mc.use-item）。無ければ盾が次善。体力が半分を切ったら mc-low-health に移る。ロッドの数は mc.goal-evidence や観測の所持数で確かめる。

## 参考
運用側が旧Minebot実験の知識から選んだ試しの手順で、シャノンの成功経験ではない。原典: seed-blaze-slit-cage（支持3・反証3）, seed-blaze-fire-resistance, k-2a290f18。旧実験でネザー到達とロッド取得まで死亡0だった1回は、この囲いの手順に依っていた。成功率の証明ではない。詳細は selection-report.json。importは利用0・成功0から始まる。
