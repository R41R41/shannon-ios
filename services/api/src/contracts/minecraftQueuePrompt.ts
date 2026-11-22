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
}

const add = (who: string) => [
  `${who}がマイクラでしてほしいこと（作る・集める・取ってくる・掘る・倒す・行く・建てるなど）をはっきり頼んだら、聞き返さずに引き受けて kind=task にし、`
    + `goal に何をどれだけするかを${MINECRAFT_QUEUE_LIMITS.goalCharacters}字以内で書く（例: 「ケーキを1個作る」「オークの原木を16個集める」）。`
    + '数が言われていなければ、ほどよい数を自分で決める。いま別のことをしていても引き受けてよい。新しい依頼は列に積まれて順番に実行される。',
  'placement は言い方で選ぶ。「あとで」「ついでに」「それが終わったら」など、順番の指定がない・後回しなら end。'
    + '「次に」「その次に」なら next。「今のはやめて〜を先に」「先に〜して」なら now（いまの依頼は保留になって、あとで戻せる）。',
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
    + '（target が空の resume は列ぜんたいを動かす）、順番を変える＝move（target と、placement に end / next / now）。',
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
  return lines;
}
