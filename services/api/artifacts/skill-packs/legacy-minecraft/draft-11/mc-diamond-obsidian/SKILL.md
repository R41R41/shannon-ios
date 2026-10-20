---
name: mc-diamond-obsidian
description: 鉄の全身の後、y=-58でダイヤ→黒曜石10→火打石→ゲート
---

## 手順
オーバーワールドで、鉄のツルハシ・バケツ・鉄の全身の防具があり、ネザーへまだ行っていない時に使う。旧実験の過去経験であり、現在の観測と身体のcatalogを優先する。番号の行は進め方、最後の「使う道具」は呼び方。

1. 現在のFCAに minecraft.observe がある時だけ、持ち物（ダイヤ・黒曜石・バケツ・火打石）・体力・食料・高さを新しく読む。
2. 鉄の全身の防具を着て、焼いた食料とベッドを持って降りる: mc.stair-mine（targetY=-58）。防具を着ていれば夜でも降りてよく、地上で朝を待たない。ダイヤは y=-58 付近にいちばん多い。
3. y=-58 で枝掘り: mc.mine-block（blockName=deepslate_diamond_ore,diamond_ore、count=3、searchRadius=32）。見つからなければ stair-mine の direction を変えて横へ 20 ブロックほど進み、また mine-block。3個でダイヤのツルハシ。
4. 黒曜石は溶岩の溜まり（流れていない溶岩）に水をかけて作る: mc.find-blocks（blockName=lava、maxDistance=32）→ mc.use-item-on-block（溶岩の座標、itemName=water_bucket）。固まったらダイヤのツルハシで掘る: mc.mine-block（blockName=obsidian、count=10）。水はバケツで汲み戻す。流れる溶岩は丸石になる。y=-58 付近は溶岩の溜まりが多い。
5. 近道: 荒廃したポータル（地表や水の底の、壊れた黒曜石の枠）は、枠の黒曜石を掘れて、横の箱に火打ち金や金がある。村の鍛冶屋の箱には鉄や黒曜石が入っていることがある（火打ち金は荒廃したポータルの箱）。地図か場所の記憶にあれば、先にそこへ。深い層では溶岩の上を掘らない。足元と前を確かめ、溶岩が見えたら丸石で塞ぐ。
6. 火打石は砂利から: mc.mine-block（blockName=gravel、count=10）。砂利1個で約1割が火打石。鉄1と火打石1で火打ち金（flint_and_steel）。
7. ゲートは黒曜石の 4×5 の枠（横4・縦5、角は要らない、中は 2×3 の空き）。平らな地面の上に建てる: mc.build-structure（structureName=nether_portal、x、y、z、facing）。火打ち金を持っていれば完成後に体が火をつける。点いたかは観測で確かめ、点かなければ mc.use-item-on-block（枠の内側の底、itemName=flint_and_steel）。
8. 入る: mc.enter-portal（枠の内側の座標）。入る前の目安は、焼いた食料十数個、丸石64以上、鉄の防具と盾、予備のツルハシ。全部そろうまで待ち続けない。ネザーの1マスはオーバーワールドの8マス。帰りのゲートの場所は覚えておく。

使う道具（名前と引数。身体の catalog が正）:
- 深い層へ: mc.stair-mine（targetY=-58、direction=north など）
- 掘る: mc.mine-block（blockName=deepslate_diamond_ore,diamond_ore、count=3、searchRadius=32）、黒曜石（blockName=obsidian、count=10）、砂利（blockName=gravel、count=10）
- 溶岩: mc.find-blocks（blockName=lava、maxDistance=32）。水をかける: mc.use-item-on-block（x、y、z、itemName=water_bucket）。水を汲む: mc.use-item-on-block（水の座標、itemName=bucket）
- 作る: mc.craft-one（itemName=diamond_pickaxe、flint_and_steel）。箱: mc.check-container → mc.withdraw-from-container
- ゲート: mc.build-structure（structureName=nether_portal、x、y、z、facing）。入る: mc.enter-portal（x、y、z）。場所: mc.recall-places

## 補助
黒曜石を鉄のツルハシで掘ろうとしない（何も落ちない）。所持が増えたかは新しい観測の所持数で確かめる。同じ溶岩だまりで失敗が続いたら別の溶岩源を探す。防具が無い間は、夜に深い所へ降りようとすると体が断る。洞窟でクリーパーを見たら戦わずに離れる（逃げ道が無ければ tower-up で3段上る）。ツルハシの耐久が尽きる前に予備へ持ち替える。時間の目安は、ダイヤのツルハシ 1,200 秒、黒曜石10個 1,500 秒、ゲート 1,650 秒、ネザー 1,800 秒。遅れている時は、掘りすぎや寄り道を切る。

## 参考
運用側が旧Minebot実験の知識（mc-nether-portal の原典 k-d2d520e2、k-1be5104b、seed-nether-prepare など）と、身体の catalog の説明（use-item-on-block は水入りバケツで溶岩を黒曜石にする、build-structure の nether_portal は黒曜石10個）から書いた試しの手順で、シャノンの成功経験ではない。mc-nether-portal の後継。draft-8 は実走16、draft-9 は実走17 を受けた版。draft-11 は owner の指示（30 分でネザーへ）を受けて、y=-58 の枝掘り・溶岩の溜まりに水をかけて黒曜石・砂利から火打石・ゲートの枠の形と建て方を、道具と引数つきで書いた版。importは利用0・成功0から始まる。
