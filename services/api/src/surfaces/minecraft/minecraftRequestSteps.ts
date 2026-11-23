/**
 * How a request that is one thing to make or fetch (「骨粉を使って小麦を早く育てて、ケーキを作って」) is carried to its end. Four runs of that request
 * (bn1 to bn4, 11/21, Haiku, a meadow, nothing given) all failed, and what they shared was not the bone meal: the plan had no node for the method
 * the person asked for in two of four, the plan made again knew none of the recipe (its stage text is over the brief's 8,000 tokens and was
 * dropped, so it added cocoa beans, bones and a crafting table in turn), the decision's instructions carried the whole-game preparation
 * (food 40, stone tools) that sent the body to hunt, cook and dig holes, and a night in a hole took 580 to 1,280 s of 1,250 to 2,400.
 * These are words for her judgment, never read by the code. They are given to a request of one thing only (the goal is neither the dragon nor the Nether;
 * the wiring says so in `planFacts.request`): in the first plan (`SINGLE_REQUEST_PLAN_WORDS`) and in the overworld decisions' stage knowledge (`stageText`, put first,
 * with the night line replacing the whole game's); the brief of the plan made again gets the short text (`REQUEST_REPLAN_KNOWLEDGE`), because the long one does not fit.
 * The whole game's knowledge has none of them, and says so in the scope line of the always-on text (`REQUEST_SCOPE_EN`).
 */

/** The steps of a one-thing request, after the way each material is obtained (the same words in the first plan and in every decision). */
export const REQUEST_STEPS_LINES: readonly string[] = Object.freeze([
  '### 依頼を最後までやる段取り（材料の取り方の上の決まり。この依頼のための決まりで、準備の決まり（食料 40・石の道具）は、この依頼には当てはまらない）',
  '- 頼まれた物の配合に要る物と数だけを集める（ケーキなら下の材料、「鉄のツルハシ」なら鉄 3 と棒 2、「パン 3 個」なら小麦 9）。ほかの事は、それが無いと先へ進めない時だけ'
    + '（腹が減って動けない・道具が無くて取れない、など）。理由: 配合に無い物を集めた分だけ、頼まれた物の完成が遅れる（実走のケーキは、食料集めと余分なバケツで約 4 分を使った）。',
  '- 節にするのは、依頼の完成品とその材料だけ。ケーキは 小麦 3・砂糖 2・卵 1・牛乳入りバケツ 3 と作業台で足りる。',
  '  カカオ豆・骨・食料・ベッド・石の道具は要らないので足さない（持ち主がベッドなどそれ自体を頼んだ時は別。鉄は、バケツが足りない時のバケツ用だけ）。理由: 要らない節を足すと体がその節へ動き、依頼の材料が進まない'
    + '（実走では、カカオ豆の節に約 20 分、骨を探す節で夜に死亡）。',
  '- 数は配合のとおり。ケーキのバケツは牛乳と同じ 3 個で、6 個は要らない。列に積んだ手（実行中・予定）で増える物（live の「次の手で増える見込み」、直前の結果の「今 N 個」）は、'
    + 'もう持っている物として数え、同じ make を重ねて積まない。理由: 実走では、バケツ 3 個を作った直後にもう 3 個を積み、鉄を 7 個掘り足して 6 個になった（牛乳は 3 個で足りた）。',
  '- 持ち物にある材料の節は済み。戻って作り直さない（牛乳入りバケツ 3 を持っているなら、牛乳の節も牛探しもしない）。持っている材料は、作る時以外に手放さない。',
  '- 依頼が方法を言っている時（「骨粉を使って」）は、その方法を飛ばさない。先に要る物（種・クワ・耕した土）の節を先に書き、'
    + '次に方法（骨粉を使う）、最後に結果（育った小麦）。',
  '- 作る → 置く → 使う → 取り出す は 1 つの続き。作っただけで節を閉じず、結果の物（bone_meal・wheat）で閉じる。'
    + 'コンポスターは作って終わりにせず、置いて、入れて、満の骨粉を取り出すまでが 1 つの節。',
  '- 骨粉をもらっている時（持ち物に bone_meal がある）は、骨粉を手に入れる節も手A〜C も要らない。コンポスターは作らない。'
    + '小麦を植えたらすぐ骨粉を使う（1 株 平均 2〜3 個。結果の「育ち 0/7→5/7」を見て、育ち切るまで同じ株に使い、'
    + '育ち切ったら dig で収穫して次の株へ）。植える場所は水から 4 マス以内の耕した土。',
  '- 小麦の育ち待ちは節の止まりではない。骨粉が無い・足りない時は、待たずに砂糖・卵・牛乳の節を進め、育ち切りは近くへ戻って見る。'
    + '育ちは植えた時から数える。',
  '- 食料は、live の満腹（fullness）が 8 以下に下がった時だけ。持っている食べ物の点（foodPoints）が 0 でも、満腹が高い間は狩らない（持ち物に食べ物が無いのは、この依頼では普通）。'
    + '牛・ニワトリは、牛乳と卵のために倒さない（牛乳はバケツで、卵は拾って取れ、倒すと材料が減るため）。食べるなら、近くに何体もいる豚か羊から 1 体。'
    + 'ただし持ち主が頼んだ物が羊毛・ベッド・肉なら、それを取る手は別で、羊は殴って羊毛を取ってよい（羊や牛を傷つけない決まりではない）。',
  '- 体力が 15 以上の間は、live の recovery に「自然に戻らない」「食料の当て」が出ていても、回復のための狩りはしない（「食料の当て」は、食べる必要が出た時の候補で、今狩れという指示ではない）。'
    + '鉄を掘りに下りる手（バケツ用）に付く「準備の状態: 未達 — 食料 …」の注は攻略全体の準備の点検で、この依頼では下りる条件にしない（石のツルハシと作業台があれば下りてよい）。'
    + '理由: 実走では、体力 19.3/20 でその 2 行が出ていた時に、牛・羊を狩って焼くのに約 2 分を使った。',
  '- 配合の材料（ケーキなら 小麦 3・砂糖 2・卵 1・牛乳入りバケツ 3）は、食べ物にしない。小麦をパンにして食べない（卵・牛乳も同じ）。'
    + '空腹で体力が戻らない時は、羊・豚・魚などほかの食べ物か、材料の余り分（要る数を超えた分）だけを食べる。'
    + '理由: 実走では、死んで材料を失ったあと、育てるのに約 10 分かかった小麦 3 本をパンにして食べ、材料が 0 に戻った（食べ物は 1〜2 分で別に取れる）。',
  '- live の時刻に「時刻が止まっている」と出ている間は、夜も朝も来ない（「夜まで」「朝まで」の分数は進まない）。夜を待つ手を積まず、待つ計画を立てない。'
    + '今の昼のまま進められる作業（材料集め・畑・作る）を続ける。理由: 実走では、時刻が止まった世界で「夜まで 約 10 分」を 14 分待ち続けた。',
]);

/** The first plan's lines for the shape of the nodes of a request (the structure `SINGLE_REQUEST_PLAN_WORDS` is given in). */
export const REQUEST_PLAN_SHAPE_LINES: readonly string[] = Object.freeze([
  '- 節の形（例: 骨粉を使って小麦を早く育ててケーキ）: 材料ごとに 1 節。小麦 3（have:wheat>=3。下に 種 4 個・木のクワ。植える・骨粉を使うは、この節の手）、'
    + '砂糖 2、卵 1、牛乳入りバケツ 3、ケーキ（作業台。最後）。',
  '  骨粉が持ち物に無い時だけ、骨粉の節（have:bone_meal>=3。コンポスターを作る → 置く → 花を入れる → 満で取り出す）を小麦の節の前に足す。',
  '- 小麦の節の caution は「植えた株は掘らない。種が手に入ったら先に植える（育ちが一番遅い）」。「成熟を確認して収穫」と書かない（確認で掘ると種に戻り、植え直しになる。育ちは live の植物の行の「育ち中 2/7」「育った」で見る）。',
  '- 節の title と doneWhen は同じ物を指す。「小麦を育てる」を have:wheat_seeds>=3 で閉じない（種を集める節は、種の節として別に書く）。',
]);

/**
 * The scope of the descent's preparation and of the yardstick (the always-on instructions, English): the rules are for the whole game, not for a one-thing request.
 * It stays in the always-on text (about 60 real tokens) because the stage knowledge, which carries the request's steps, yields to this text where they disagree.
 */
export const REQUEST_SCOPE_EN =
  '- Scope: these rules are for the dragon run and the way to the Nether. A one-thing request (a cake, wool) has none of them: '
  + 'no food target, stone tools, hunting, cooking or bed, and a pack with no food is no reason to hunt (they took its time in four cake runs). '
  + 'Its yardstick is that one thing, made as fast as possible.';

/**
 * The night with no bed (a stage line of the overworld, Japanese): work on, near, with the body's own defence, and no hole. The line before was
 * only 「岩の中で待っても朝は早く来ない」 (run qr7, a cake: with no bed and no weapon the night's line may have been read as dig a hole and wait; a hypothesis).
 * The four bone meal runs read it the same way (bn1 and bn4: 580 to 650 s in a hole, twice), and the reason they gave was the body's own, not the line's:
 * 「剣が無い・食べ物が無い」. So the line now says what to do instead, and to make the sword.
 */
export const REQUEST_NIGHT_WAY =
  '穴や囲いに入って朝を待たない。待っても朝は早く来ず、夜 1 回で約 8 分を捨てる（実走では夜の穴で 10〜20 分を使った）。'
  + '穴を掘るのは、依頼そのものが地下の作業（鉄・石炭を掘る）で、塞いだ縦穴を地下へ下りる入口にする場合だけ（待つためではない）。'
  + '先に、板 2・棒 1 の木の剣を作って持つ（剣が無いのも、穴に入った理由の一つだった）。'
  + '依頼の続きを、今いる所の近く（明るい所・囲い・松明の近く）で進める。植える・骨粉を使う・牛乳・卵・砂糖・羊毛・作業台での製作は夜でもできる。'
  + 'act には stopIf hostileWithin=8 を付け、敵が近くに来た時だけ体が自分で迎える。'
  + '囲いは、3 体以上に近づかれた時と体力 8 以下の時だけ。洞窟・遠出・初めての場所の探索は朝に回す。夕方と夜は、今いる所から 20〜25m を超えて出ない（暗いと敵が湧き、遠いと戻る間に囲まれる）';
/** The same words as `REQUEST_NIGHT_WAY`, as a line of the stage knowledge;
 * the live's night line (`nightChoiceLine`, a one-thing request) says the very same words. */
export const REQUEST_NIGHT_LINE = `- ベッドが無い間の夜: ${REQUEST_NIGHT_WAY}。`;

/**
 * The knowledge the plan made again is shown for a one-thing request (instead of the stage's long text, which is over the brief's token bound
 * and was dropped whole). Short on purpose: the recipe, what is not to be added, the steps, and what a stall on the crop's growth is.
 */
export const REQUEST_REPLAN_KNOWLEDGE = [
  '一つの物を作る・取る依頼（ゲーム全体の準備ではない）の材料と段取り（材料の例はケーキ。ほかの物の依頼なら、その物の材料だけに置き換えて読む）:',
  '- 計画に入れてよいのは、依頼の完成品とその材料だけ。ケーキは 小麦 3・砂糖 2・卵 1・牛乳入りバケツ 3 と作業台。'
    + 'カカオ豆・骨・食料・ベッド・石の道具は要らない（持ち主がそれ自体を頼んだ時は別。足さない。入っていたら drop。鉄は、バケツが足りない時のバケツ用だけ）。',
  '- 頼まれた物の配合に要る物と数だけを集める。ほかの事は、それが無いと先へ進めない時だけ（腹が減って動けない・道具が無くて取れない）。'
    + 'バケツは牛乳と同じ数（ケーキは 3）で、増える見込みの手が列にあれば数に入れ、同じ make を重ねない。',
  '- 持ち物にある材料の節は済み。作り直しや牛探しの節を足さない。牛・ニワトリは牛乳と卵のために生かす（倒すと材料が減る）。羊毛・ベッド・肉を頼まれた時の羊や牛は別で、取ってよい。',
  '- 材料の節の手順: 小麦は 種 → クワ → 水から 4 マス以内に植える → 育ち切ったら dig。牛乳は空バケツで牛に use。卵はニワトリの近くで拾う。砂糖はサトウキビ。',
  '- 骨粉を使う依頼: 持ち物に骨粉があれば取る節は要らず、植えたらすぐ use（1 株 2〜3 個）。'
    + '無い時は、コンポスターに花（サトウキビは砂糖の分を残す）を入れる。作る → 置く → 入れる → 満で取り出す を 1 つの節にして、doneWhen は have:bone_meal>=数。'
    + '骨を集めない・夜に探しに出ない。',
  '- 止まった理由が小麦の育ち待ちなら、待たずに別の材料の節へ current を移す。穴に入って朝を待たない（夜も依頼の続きを近くで進める）。',
  '- 植えた作物は「今の様子」の植物の行にある（育ち中・育った）。小麦が持ち物に 0 でも、植えた株があれば小麦の節は済みでない。種・クワ・作業台の節を足し直さない。',
  '- 食料は live の満腹（fullness）が 8 以下に下がった時だけ。持っている食べ物の点が 0 でも、満腹が高い間は、狩りも調理の節も足さない。'
    + '体力が 15 以上なら、recovery の「自然に戻らない」「食料の当て」でも狩らない。',
].join('\n');
