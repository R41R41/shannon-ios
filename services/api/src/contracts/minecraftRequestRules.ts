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
  return `いま実行中の依頼（や [依頼の列] の待ち・保留の依頼）を成し遂げるための手段・準備・材料・やり方の提案（「〜で育てようよ」「〜を使うと早いよ」「待ってる間に〜も」のうち、[いまの依頼の計画] の目的や、いま待っていることを早める・足りない材料を手に入れることに役立つもの。「ついでに」「ちょっと」と付いていても同じ）は、助言の形でも新しい依頼にせず kind=message にし、goal に${who}が言った内容と、何のためか（目的）をそのまま書く。`
    + '理由: task で足すと、別の仕事として列の最後に積まれ、元の依頼が終わるまで動かず、元の依頼の計画はそのまま進む（骨粉で育てようと言われたのに、ケーキは骨粉なしで進んでしまう）。message なら体がいまの計画に書き足し、足せない時は一番近い手に変えて進める。'
    + `いまの依頼とは別にほしい物（別の物を作る・集める・建てる）、置く・渡す、「先に」と言われた時は、これまでどおり kind=task。迷う時は「言われたことを、いまの計画の中に書き足せるか」で選ぶ。違っていたら、${who}が「やめて」と言ってくれれば直せる。`
    + 'message にした時の返事は「いまの作業に取り入れるね」の形にし、「あとでやるね」とは言わない（理由: 取り入れは、いますぐ計画に入る）。';
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
