/**
 * What the head is told for a request that is one thing to make or fetch (「ケーキを作って」「羊毛を3つ」), not the whole game.
 * Two runs of the cake (the first plan of both began with 「食料の確保」 and `food>=40`, and one of them searched for milk at the water) showed
 * two gaps in what she was given: the first plan's words are those of the whole-game route (food and a bed before the iron, the descent's
 * preparation), and no line said how the cake's own materials are obtained. These are words for her judgment, never read by the code.
 */

/**
 * How the things a small request needs are obtained (the rules of the game, Java 1.21; the body's `use` hand milks a cow with a bucket,
 * `use bucket target=#id`). Given in the stage knowledge of every decision in the overworld, and in the first plan of a request.
 */
export const MATERIAL_ACQUISITION_LINES: readonly string[] = Object.freeze([
  '### 小さな依頼の材料の取り方（ケーキなど）',
  '- ケーキ: 作業台で 小麦 3・砂糖 2・卵 1・牛乳入りバケツ 3（make cake。作ると空のバケツ 3 個が戻る）。',
  '- 牛乳: 空のバケツを持って牛に use bucket target=#id（水源は関係ない。水を汲んだバケツには入らない）。成牛 1 頭から 1 回で 1 個で、'
    + '牛乳入りバケツが 3 個 同時に要るので、バケツは 3 個（バケツは鉄 3 で 1 個: 鉄が無ければ鉄の節が要る）。子牛は搾れない。',
  '- 卵: ニワトリが数分に 1 個、足元に産んで落とす（落ちた卵を pickup）。ニワトリを倒しても卵は出ない。近くのニワトリのそばで待つか、落ちている卵を探す。'
    + 'ニワトリが見えなければ、草原を別の向きへ見回って探す（ニワトリは地図の動物の印や走査に出る）。',
  '- 小麦: 育ち切った小麦（色が濃く背が高い）を dig すると小麦 1 と種。育っていない苗は種しか出ない。必要なのは 3 本分。'
    + '村の畑は、live の nearby に「食料（村）」の行がある時か、landmarks に「村」がある時だけ使う（近ければ先に寄る）。'
    + 'nearby に「食料（村） ○○m 内に なし」と出ている時は、その範囲に村は無い。行も landmarks の「村」も出ていない時は、村の有無は分からない。どちらの時も、村は遠いと数百マス先のことがあり、探しに歩くより種から育てる方が早いので、村は探しに遠出せず、草から種を集めて育てる:',
  '  1) 草（short_grass・tall_grass。地図では「,」）を dig する。草のマスは地面ブロックの 1 つ上（y が 1 つ違うと「既に air」と出るので、地図の「,」の x・z に mc.probe column を当てて y を読むと確実）。dig の at には 1 手に 16 マスまで並べられるので、草を 8〜10 マス並べて 1 手で壊す。壊すと時々 wheat_seeds が落ちる（8 回に 1 回ほど。何も落ちなかった草が続くのは普通で、効いていないわけではない。結果の文に「拾った: wheat_seeds+1」と出る）。種が 3〜4 個になるまで、別の草で繰り返す。',
  '  2) 水の近く（水から 4 マス以内）の土か草ブロックを、クワで耕す。クワは作業台で作る（木のクワ = 木の板 2・棒 2）。耕すブロックの真上に草や花があると耕せないので、先にそれを dig する。'
    + 'その後 use item=wooden_hoe（作ったクワの名前）at=そのブロック。結果の文に「今 farmland」と出れば耕せている。',
  '  3) 耕した farmland に use item=wheat_seeds at=その farmland で種を植える（結果の文の「上」が wheat になる）。3 か所に植える。',
  '  4) 小麦が育つまで数十分から 1 時間ほどかかる。待たずに別の材料（砂糖・卵・牛乳）を進め、戻ったら育ち切った小麦を dig する。',
  '- 砂糖: サトウキビ 1 本で砂糖 1（make sugar）。サトウキビは水に接した砂・土・草ブロックの上に、高さ 1〜3 段の縦に伸びた草として立つ（地図では草と同じ「,」）。'
    + '株は dig で直接壊せる（dig の at に、株のブロックの座標）。根元の 1 つ上の段を壊すと、その上の段が全部落ち、根元が残ってまた伸びる。'
    + '高さ 1 の株は根元しか無いので、根元を壊す（1 本取れて、株は終わる）。落ちた物は dig が拾い、結果の文に「拾った: sugar_cane+N」と出る。',
  '- サトウキビの在りかは、live の nearby の「植物（材料）: sugar_cane …」の行にある（株の数と、根元の座標・高さ・水に接するか）。水のマスの行ではない。'
    + 'そこへ go して、根元の 1 つ上の段（高さ 1 なら根元）を dig する。理由: map では草・シダも , で同じ記号になり、look は向きを変えるだけで何も教えないので、水際を見回しても分からない。'
    + 'sugar_cane の行は 96m 内を探した結果で、「なし」なら 96m 内に無い（水辺を見回しても無い）。行が出ていない時は、mc_view の only=[sugar_cane] を使い、地図に出た記号「,」（草と同じ記号）の所を mc.probe column で読むと、ブロックの名前が sugar_cane か分かる。',
  '- 材料の植物（小麦・ニンジン・ジャガイモ・ビートルート・カボチャ・スイカ・ベリー）も同じ nearby の「植物（材料）」の行に出る。作物は「育った」の物を dig する。',
  '- 同じ物を探す手（水辺を見回す・別の岸へ行く）を 3 回続けて見つからない時は、4 回目は同じ探し方にせず、遠くの別の水辺・別の向きの地図（mc_view の center を動かす）・'
    + '別の入手法へ切り替える。同じ節に長くいても持ち物が増えていない事は、live の持ち物で確かめられる。',
]);

/**
 * The first plan's words for a request that is not the whole game or the way to the Nether (`planGoal` is null). The structure of the plan
 * (`CURRENT_PLAN_STRUCTURE`) is the same; what is left out is the whole-game route and the descent's preparation, which a small request
 * has no use for and which, as the only long text on food and nights, put a food node first.
 */
export const SINGLE_REQUEST_PLAN_WORDS = [
  '## この依頼だけを計画する（ゲームの攻略全体ではない）',
  '- 計画の目的は、入力の「依頼」の達成だけ。最初の節は、依頼の完成品か、その材料に直接つながる仕事にする。',
  '- 依頼に要らない準備（食料 40 点・ベッド・夜の備え・鉄の道具・地下へ下りる準備・村回り）は節にしない。'
    + 'その材料を作るのに要る時だけ、その材料の節の子として書く（例: 牛乳のバケツが足りない時だけ、バケツ用の鉄の節）。',
  '- 理由: 攻略全体の準備を毎回先に置くと、依頼と関係ない仕事に最初の数分を使い、依頼の材料集めが後ろへ回る。',
  '- 持ち物にある物は引く。完成品の節の doneWhen は have:完成品>=1 の形にして、材料ごとの節は材料の取り方（下の知識）に沿って、材料の数を note でなく節の title に書く。',
  '- 空腹や体力は live の事実で、体が食べる。食料の節は、live の食料が尽きかけている時だけ。',
  '',
  ...MATERIAL_ACQUISITION_LINES,
].join('\n');
