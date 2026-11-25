/**
 * The rules for handing a spoken or written wish to her Minecraft body, written once. The same words reach her by two ways: the turn's
 * intent field (`minecraftQueuePrompt.ts`, anyone in a channel, the game chat) and the tool `minecraft.request` (the owner alone in his
 * private room, `shannonTools.ts`). Only the way of handing over differs (`act`); a rule that read stronger on one way than the other
 * would make her act differently by who is listening, which she does not (owner decision: whoever listens, she behaves the same).
 * Words for her judgment, each with its reason: nothing in the code reads a sentence for a phrase. Imports nothing, so the tool registry
 * can use it without touching the body.
 */

/** Advice, a suggestion and the answer to her own question are requests when they hold something for the body to do. */
export function adviceIsRequestRule(who: string, act: string): string {
  return `助言・提案・質問への答えの形（「〜した方がいいよ」「〜しようか」「〜してほしいな」「〜して」、ボクの質問への答え）でも、体でしてほしいことが入っていれば、はっきりした頼みと同じに${act}。聞き返さない・「ケーキを先にやってほしいって言ってたよね」のように相手の言っていないことを足さない。`
    + '例: 「夜が来る前に先にベッド作った方がいいよ」→ 頼む（placement=now、goal「夜が来る前にベッドを作る」）。'
    + '「近くに適当に置いて寝て」（置き場所を聞いた質問への答え）→ 頼む（goal「ベッドを近くに適当に置いて寝る」）。'
    + `理由: 助言の形のまま聞き返したり、ただ受け答えするだけにすると、${who}はもう一度言い直すことになり、そのたびに20秒以上かかる。違っていたら、引き受けたあとで「やめて」「変えて」と言ってもらえば直せる。`;
}

/**
 * While a request of hers is running: what is said to help it get done (a way, a material, a preparation) is words for that request, not a
 * new one. Written because the voice turned "skeletons for bone meal to grow the wheat" into a separate request four times in a night, queued
 * behind the cake it was meant for (2026-11-26 shoot). Only the intent field has this (the tool `minecraft.request` can only add a request).
 * Words for her judgment: nothing reads the sentence for a phrase.
 */
export function adviceForRunningRule(who: string): string {
  return `いま実行中の依頼（や [依頼の列] の待ち・保留の依頼）を成し遂げるための手段・準備・材料・やり方の提案は、助言の形でも頼む形でも新しい依頼にせず kind=message にし、goal に${who}が言った内容と、何のためか（目的）を書く。`
    + '選ぶ目安は、言い方でなく中身: 言われたことをすると、[いまの依頼の計画] の「いま」「残り」の節が早く・楽に進むか、そこで要る物・足りない物（その材料の材料も含む）が手に入るか。進む・手に入るなら message にする。'
    + '「ついでに」「ちょっと」「もう何体か」「待ってる間に」「〜しようか」「〜してほしいな」「〜して」は、話し方の軽さや頼み方の形で、別の仕事かどうかは決めない。「ついでに」と付いていても、計画で使う物を手に入れる話なら message。計画に使わない別の物を作る・集める・建てる話なら task。'
    + '何のためかが文に書かれていなくても、いまの計画の節で使う物だと分かるなら message にし、goal には、その目的を「〜のために」の形で書く。計画のどの節にも使わない物には、目的を考えて足さない（理由: 無い目的を足すと、要らない物を集めて計画が止まる）。goal に「ついでに」「あとで」は入れない（理由: 体は goal を読んで、やってもやらなくてもよいおまけ・後回しの物と受け取り、計画に入れない）。'
    + '例: ツルハシを作っている時の「ついでに棒も作っておこう」→ message（goal「ツルハシのために、棒を作る」。棒はツルハシの材料）。同じ時の「ついでに家も建てておいて」→ task（ツルハシに使わない別の物）。'
    + '例: いまケーキを作っている時に「ケーキ作るために、スケルトンを狩って骨粉を集めてきてほしいな」→ message（goal「ケーキのために、スケルトンを狩って骨粉を集め、小麦の成長に使う」）。'
    + '理由: task で足すと、別の仕事として列の最後に積まれ、元の依頼が終わるまで動かず、元の依頼の計画はそのまま進む（骨粉で育てようと言われたのに、ケーキは骨粉なしで進んでしまう）。言い方が頼みでも「ついでに」でも、中身がいまの依頼の一部なら、task にすると「ケーキのあとでやるね」と返して、元の計画だけが進む。message なら体がいまの計画に書き足し、足せない時は一番近い手に変えて進める。下の「別にしてほしい事は task」より、この規則を先にする。'
    + `いまの依頼とは別にほしい物（別の物を作る・集める・建てる）、置く・渡す、「先に」と言われた時は、これまでどおり kind=task。迷う時は「言われたことを、いまの計画の中に書き足せるか」で選ぶ。違っていたら、${who}が「やめて」と言ってくれれば直せる。`
    + 'message にした時の返事は「いまの作業に取り入れるね」の形にし、「あとでやるね」「ケーキのあとの」のような順番の言葉は入れない（理由: 取り入れは、いますぐ計画に入る）。';
}

/** The conditions of the wish stay in the goal. */
export const KEEP_CONDITIONS_RULE =
  'goal には、頼まれた条件（いつ・どうやって・何のため・場所・「〜しないで」）を落とさず入れる（例: 「寝ずに」「次の夜」「近くに適当に」「骨粉は作物の成長に使う」）。'
  + '理由: 体の作業を進める側は、この goal と、渡される言葉の原文だけを手がかりにする。条件が goal から落ちると、体は条件のない作業をしてしまう（「寝ずに」が落ちて、夜に寝てしまうなど）。';

/** What is said back when nothing is handed over: no promise, since nothing moves. */
export function noPromiseRule(nothing: string): string {
  return `${nothing}（雑談・体に頼まない時）は、「〜するね」「やっておくね」「寝てみるね」のような約束を返事に入れない。`
    + '理由: 体に何も渡らないと、約束しても体は動かず、頼んだ人が待ち続ける。体でしてほしいことが言われたのに約束だけしたくなった時は、約束せずに頼みとして渡す。';
}

/**
 * The block of the owner's voice turn where the request goes by the tool (his private room): the three rules above, in the same words
 * the intent field's guide gives, and what the tool is for. `who` is the one who speaks.
 */
export function toolRequestGuide(who: string, fieldGuideShown = false): string[] {
  // The intent guide is in the prompt too (the same rules, in the same words): only the two ways are told apart.
  if (fieldGuideShown) {
    return [
      '[マイクラの体への頼みごと（道具でも頼める）]',
      '頼みは、返答欄の kind=task と、道具 minecraft.request のどちらでも体に渡る（同じ頼みになる）。どちらか一方だけにする（理由: 両方で頼むと、同じ頼みが二つ列に積まれる）。道具で頼んだ時は、返答欄の kind は none にする。',
    ];
  }
  return [
    '[マイクラの体への頼みごと（道具 minecraft.request で頼む）]',
    `${who}が体でしてほしいこと（作る・集める・取ってくる・掘る・倒す・行く・建てるなど）を言ったら、聞き返さずに道具 minecraft.request で頼む。ここで体に頼むのは、この道具だけ。`,
    adviceIsRequestRule(who, '道具 minecraft.request で頼む'),
    KEEP_CONDITIONS_RULE,
    noPromiseRule('道具を使わない返事にする時'),
    '道具で頼んだ時の返事は、引き受ける短い一言にとどめ、もう終わったとは言わない。',
  ];
}
