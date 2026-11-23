/**
 * mb-llmc v2: the body's legend of the map (mb-llmc-cand 2, Shannon 974c19f `utils/localMap.ts` `MAP_LEGEND`), word for word. The body split
 * the symbols by what the walk does with the block (`%` leaves only; `Y` the Nether's wart blocks and shroomlight; `P` planks, stairs, slabs, bookshelves;
 * `D` `A` `J` a wooden door, trapdoor, fence gate; `K` iron door and trapdoor; `+` fences and walls; `b` glass, panes, bars, chains;
 * `q` signs, plates, buttons, levers). `MAP_LEGEND` of `minecraftActContract.ts` is the legend of the bodies before it, which the switch off still sends;
 * (a file of its own: the contract file is at the ceiling of lines) a test compares this one with the body's.
 */
export const MAP_LEGEND_V2 = [
  '地図の記号（1字。地図は上が北・左が西。行の頭は z、列の見出しは x の下 1 桁）:',
  '@ 自分の足 / ! 敵の足 / & 中立の足 / m 動物の足 / * 60秒以内に歩いた空気 / . 空気 / , 通れる草花・雪 / ? 未ロード / X 掘れない（岩盤・バリア）',
  '# 石の類（石・深層岩・安山岩・閃緑岩・花崗岩・凝灰岩・丸石・石レンガ）/ : 土・草・雪・粘土 / s 砂・砂利 / I 氷',
  'w 水源 / - 流れる水 / L 溶岩源 / l 流れる溶岩 / f 火 / x クモの巣',
  'i 鉄 / c 石炭 / d ダイヤ / g 金 / r レッドストーン / o ほかの鉱石（銅・ラピス・エメラルド・石英・古代の残骸）',
  'W 原木（ネザーの幹も）/ % 葉（歩きの中で壊して通る）/ Y ネザーのウォートブロック・シュルームライト（固い）/ P 板・階段・ハーフブロック・本棚（固い）/ h はしご・つた / t 松明 / = レール',
  'D 木の扉 / A 木のトラップドア / J 木のフェンスゲート（D・A・J は閉じていても歩きの中で開けて通る）'
    + '/ K 鉄の扉・鉄のトラップドア（手では開かない＝壁）/ + 柵・壁（高さ1.5で上れない）/ b ガラス・板ガラス・鉄格子・鎖（通れない）/ q 看板・感圧板・ボタン・レバー（通れる。ブロックは置けない）',
  'F かまど（溶鉱炉・燻製器も）/ T 作業台 / C チェスト・樽 / B ベッド / H 干し草 / k 畑の作物（ネザーウォートも）/ S スポナー',
  'O 黒曜石（泣く黒曜石も）/ p ネザーポータル / n ネザーラック / u ソウルサンド・ソウルソイル / N ネザーレンガ（要塞）/ M マグマ / G グロウストーン',
  'E エンドストーン / Q エンドポータルの枠（空）/ R 枠（アイ入り）/ e エンドポータル・エンドゲートウェイ / $ ほかの固いブロック',
  '方式=surface のマスは「記号＋高さ」: 0〜9 は足より上、+ は10以上上、a〜i は1〜9下、v は10以上下。',
  '方式=layers の層: 足 −1〜+1 は 15×15、足 ±2 は 11×11（「y=47 x=196..206 z=272..282」のように範囲を書く）。足の 3〜6 上に敵（!）かスポナー（S）があれば、その高さの層（11×11）を一番上に足す。',
  '縦: 足の列の上（頭のマスから上へ）と下（足の下のマスから下へ）を、同じ記号の続きでまとめる。「上: y=46〜51 .×6 / y=52 #」は頭から空気が 6 段、その上が石。… はその先も続く。',
].join('\n');

/**
 * The same nine symbol lines in English, the form the mode's always-on instructions carry (the owner, 2026-11-11: the instructions are written in English; the
 * model's outputs stay Japanese). The symbols and their order are the body's: a test compares the symbol keys of each line with `MAP_LEGEND_V2`'s.
 */
export const MAP_LEGEND_V2_EN: readonly string[] = [
  '@ my feet / ! enemy\'s feet / & neutral mob\'s feet / m animal\'s feet / * air walked on within 60 s / . air / , grass plants and flowers, snow (passable) / ? not loaded / X undiggable (bedrock, barrier)',
  '# stone kinds (stone, deepslate, andesite, diorite, granite, tuff, cobblestone, stone bricks) / : dirt, grass blocks, snow, clay / s sand, gravel / I ice',
  'w water source / - flowing water / L lava source / l flowing lava / f fire / x cobweb',
  'i iron / c coal / d diamond / g gold / r redstone / o other ores (copper, lapis, emerald, quartz, ancient debris)',
  'W logs (Nether stems too) / % leaves (broken through while walking) / Y Nether wart blocks and shroomlight (solid) / P planks, stairs, slabs, bookshelves (solid) / h ladders, vines / t torch / = rail',
  'D wooden door / A wooden trapdoor / J wooden fence gate (D, A, J are opened and passed through while walking, even when closed)'
    + ' / K iron door and iron trapdoor (not opened by hand = a wall) / + fences and walls (1.5 high, cannot be climbed) / b glass, glass panes, iron bars, chains (impassable) / q signs, pressure plates, buttons, levers (passable; no block can be placed)',
  'F furnace (blast furnace and smoker too) / T crafting table / C chest, barrel / B bed / H hay bale / k farm crops (Nether wart too) / S spawner',
  'O obsidian (crying obsidian too) / p Nether portal / n netherrack / u soul sand, soul soil / N Nether bricks (fortress) / M magma / G glowstone',
  'E end stone / Q end portal frame (empty) / R frame (with an eye) / e end portal, end gateway / $ other solid blocks',
];
