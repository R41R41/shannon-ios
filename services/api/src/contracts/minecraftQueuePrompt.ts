import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { MINECRAFT_QUEUE_LIMITS } from './minecraftQueueContract.js';

/**
 * What she is told of the owner's list of requests for her Minecraft body (`minecraftIntent`): what each kind does to the list,
 * how his usual ways of saying it map onto them, and the list as it stands now. It is words for her judgment: nothing in the code
 * reads his sentence for a phrase. Shared by the game chat and the Discord voice (`minecraftBody.ts`, `platformVoicePrompt.ts`).
 */
export interface QueueGuideOptions {
  /** `[依頼の列]` lines (`queuePromptLines`); empty when the list is empty. */
  queueLines: readonly string[];
  /** Who is asking, as she should call them (default: the owner). Anyone in a voice channel may ask (owner decision 2026-11-21). */
  who?: string;
  /** The request that is running, in her words, or null. */
  running: string | null;
  /**
   * Whether the one asking is the owner (default: yes). Kept for the callers that pass it; it no longer changes the words (whoever
   * asks in the channel decides the order of their own request, and the guide is the same for any speaker).
   */
  owner?: boolean;
}

const add = (who: string) => [
  `${who}がマイクラでしてほしいこと（作る・集める・取ってくる・掘る・倒す・行く・建てるなど）をはっきり頼んだら、聞き返さずに引き受けて kind=task にし、`
    + `goal に何をどれだけするかを${MINECRAFT_QUEUE_LIMITS.goalCharacters}字以内で書く（例: 「ケーキを1個作る」「オークの原木を16個集める」）。`
    + '数が言われていなければ、ほどよい数を自分で決める。いま別のことをしていても引き受けてよい。新しい依頼は列に積まれて順番に実行される。',
  'placement は、順番に触れた言葉があるかで選ぶ。順番に触れない新しい頼み（「ベッドを作って」）・「あとで」「ついでに」「それが終わったら」は end（理由: 走っている作業を勝手に止めない）。'
    + '「次に」「その次に」は next。'
    + `「先に」「優先して」「〜からやって」「〜をやる前に」「今のはやめて〜を」は now。理由: 順番を決めるのは頼んだ${who}で、「先に」と言われたのに「いまの作業が終わってから」と返すと、順番を決める権利を取ってしまう。`
    + 'now はいまの依頼を保留にして先にやる形で、先の依頼が終われば保留は自動で戻る（失うものは無い）ので、ためらわない。'
    + `夜になった（暗い）・危険がある・${who}が「いますぐ」と言った時は、順番に触れていなくても now（例: 夜に「ベッドを作って」と頼まれたら now。夜の危険が理由で、寝る・寝ないは頼まれた内容と夜の目的で決まる）。`
    + '理由: いまの作業を続けると、夜は襲われて間に合わなくなる。返事にその理由を一言入れる。',
  '列にすでに同じ頼み（言い換えでも、[依頼の列] の待ち・保留の依頼と同じ内容）がある時は、kind=task にせず kind=move にして、target にその番号、placement=now（先にと言われた時）か next にする。'
    + '例: 「#8 待ち 「羊を飼ってベッドを作る」」がある時に「羊とベッドを先に」と言われたら、kind=move・target=#8・placement=now。'
    + '理由: task で足すと同じ依頼が二つになり、片方が終わっても残る。保留のものを先に動かす時も move の now。',
  `作った物を「置いて」「ちょうだい」「渡して」と${who}が言った時も kind=task にする。goal には、何をどこへ・誰へするかを、言われた言葉のまま残す`
    + '（例: 「ケーキをこのオークの木材ブロックの上に置く」「ケーキを渡す」）。「この」「あそこ」を座標や別の言葉に直さない。'
    + '理由: 「この」は、あとで依頼に取りかかる側が、言った人の視線を調べ（その人が見ているブロックを読む）、近くのブロックの名前と合わせて解く。ここで推測して書き換えると、その手掛かりが消える。',
];

const others = (who: string, idle: boolean) => [
  idle
    ? `いま実行中の依頼も待っている依頼も無い。${who}の頼みごとは、したいことが言われていれば kind=task にする（kind=message は使わない）。`
      + '理由: message は走っている依頼に言葉を足すだけなので、足す先が無いと体に届かず、頼んだ人がもう一度言い直すことになる。'
      + '直前に終わった依頼の成果物（作ったケーキなど）についての頼みも、終わった依頼は動かせないので新しい依頼（kind=task）。'
    : `いま実行中の依頼について${who}が言うこと（数や作り方を変えてほしい・続けてほしい・それでいい）は kind=message にし、`
      + 'goal に伝える言葉を書く。新しい依頼にはならず、いまの作業への伝言として渡る。'
      + `いまの作業に関わる事実を${who}が教えてくれた時（「持っている」「無い」「あっちにある」、間違いの指摘）も kind=message にし、goal に事実をそのまま書く。`
      + '理由: 体に届かないと、体が同じ間違いを繰り返し、人が何度も言い直すことになる。「お、いいね」のような相づちは none のまま。',
  '「全部止めて」「ちょっと待って」のように列ぜんたいを止めたい時は kind=stop。止めた列は、始めてと言われるまで次の依頼を動かさない。',
  '一つの依頼だけを扱う時は target に依頼の番号（[依頼の列] の #3 なら "#3"）を入れる。空ならいま実行中の依頼。'
    + 'もういい・やめて＝cancel、後回し・いったん保留＝hold（列は次へ進む）、保留や停止のものを戻す＝resume'
    + '（target が空の resume は列ぜんたいを動かす）、順番を変える＝move（target と、placement に end / next / now）。'
    + '「Xは後でいい」「Xはあとで」と言われたら、Xがいま走っていても hold（Xは止まり、列の次が動く）。この hold は、戻してと言われるまで戻らない。'
    + 'いまの依頼を止めて別のことを先にと言われた時は、その別のことを now にする（task か move）。いまの依頼の hold にはしない（now の保留は、先のことが終われば自動で戻る）。',
  '雑談・質問・何をしてほしいか本当に分からない時は kind=none で、goal・placement・target は空にする。',
];

/** The guide for her turn as lines (the heading first). */
export function minecraftQueueGuide(options: QueueGuideOptions): string[] {
  const lines = ['[マイクラの体への頼みごと]（返答の minecraftIntent）',
    '体は一度に一つの依頼だけを動かす。頼みごとは「依頼の列」に積まれ、順番に実行される。言葉がどれにあたるかは、あなたが判断する。'];
  if (options.running) lines.push(`いま体は「${options.running}」をしている。`);
  const who = options.who ?? SHANNON_OWNER_NAME;
  lines.push(...add(who), ...others(who, !options.running && options.queueLines.length === 0));
  if (options.queueLines.length) lines.push('[依頼の列]', ...options.queueLines);
  else lines.push('[依頼の列] いまは空');
  lines.push('task にした時の返事は、引き受ける短い一言にとどめ、もう終わったとは言わない。');
  lines.push('返事の言葉は、minecraftIntent でした順番と合わせる。now なら「先に（いま頼まれた物）を作るね。（いま体がしている作業）は止めておくよ、終わったら続ける」、end なら「（いま体がしている作業）のあとでやるね」の形。'
    + '（）の中は、いま頼まれた言葉と、上の「いま体は…」と [依頼の列] から取り、この形に書いた言葉のまま言わない。'
    + 'now にしたのに「そのあとに」と言ったり、end にしたのに「先にやるね」と言ったりしない。'
    + '待たせる理由が「いまの作業の途中だから」だけの時は、待たせない（待たせてよいのは、頼んだ人が「あとで」と言った時と、体がいまそれをできない時だけ）。'
    + 'いま体がしている作業の名前は、上の「いま体は…」と [依頼の列] の「実行中」から取る。これまでの自分の返事に出てくる作業名は、順番を入れ替えたあとは古いので使わない。');
  lines.push('引き受けた依頼は [依頼の列] にあるものだけ。列に無い依頼（列が空の時、保留のまま動いていない依頼、前の話に出ただけの作業）は引き受けていないので、「進めておくね」「どっちもやっておくよ」とも、「そのあとでやる予定」「つもり」とも言わない。'
    + '聞かれたら、列にあるものだけを言い、無いものは「いまは動いてないよ」と正直に言う（動かしてほしいと言われたら、そこで引き受ける）。'
    + '理由: 言ったのに体が動いていないと、頼んだ人は進んでいると思って待ち続け、あとで気づいて言い直すことになる。列に書いてあることが正しく、これまでの会話の中身は古いことがある。');
  return lines;
}
