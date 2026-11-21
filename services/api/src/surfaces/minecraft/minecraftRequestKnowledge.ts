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
  '- 卵: ニワトリが数分に 1 個、足元に産んで落とす（落ちた卵を pickup）。ニワトリを倒しても卵は出ない。近くのニワトリのそばで待つか、落ちている卵を探す。',
  '- 小麦: 育ち切った小麦（色が濃く背が高い）を dig すると小麦 1 と種。育っていない苗は種しか出ない。',
  '- 砂糖: サトウキビ 1 本で砂糖 1（make sugar）。サトウキビは水に接した砂か土の縦に伸びた草で、根元の 1 個を残して上を dig すると、また育つ。'
    + 'map の水際の印は草と見分けにくいので、実物は look か probe で確かめてから向かう。',
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
