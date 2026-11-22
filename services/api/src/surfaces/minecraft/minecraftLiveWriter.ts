import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { liveFactLine, type LiveMoment } from '@shannon/mind';

/**
 * Her live line, asked of the model (session dc-live; `SHANNON_MINECRAFT_LIVE_SPEECH`). The line is hers: her identity, her place in her
 * character space (the persona block), her body's present, and what just happened as a fact line; the rules are only those of a spoken
 * word on a chat (short, no list, nothing untrue). The room is one of people who all take part in her work, so what she does, what she
 * thinks of it and how she feels are all hers to say (each rule says why, so that it is read as a reason and not as a wall). The line goes to
 * a room others read or hear, so it is always written as for a shared room. Pure: the wiring hands the identity and the persona, the
 * engine hands the moments.
 */
export const LIVE_LINE_LIMITS = Object.freeze({ voiceCharacters: 64, textCharacters: 110,
  /** The end of a request says what was made and then asks: two short sentences, the question last, so it is given more room (cut short, the question is what is lost). */
  doneVoiceCharacters: 96, doneTextCharacters: 140 });

export interface LiveWriterInput {
  /** Her identity prompt for a shared room (with her character core). */
  identity: string;
  /** The `[いまのボク]` block of her character space for a shared room, or ''. */
  persona: string;
  /** Her body's present, written for a shared room (`MinecraftLive.block({ alone: false })`). */
  body: string;
  main: LiveMoment;
  also: readonly LiveMoment[];
  /** Her last live lines, newest last. */
  recent: readonly string[];
  /** The line will be spoken in a voice channel (shorter, no marks), not written. */
  voice: boolean;
  /** Where the line goes: a public YouTube Live (`surfaces/stream/`) or, by default, Discord with friends. */
  place?: 'discord' | 'stream';
}

export function liveWriterPrompt(input: LiveWriterInput): { system: string; message: string } {
  // The end of a request is asked of the call's room only: a stream's room is many people who gave her nothing to do.
  const stream = input.place === 'stream', ended = input.main.kind === 'task_done' && !stream;
  const limit = input.voice ? LIVE_LINE_LIMITS[ended ? 'doneVoiceCharacters' : 'voiceCharacters'] : LIVE_LINE_LIMITS[ended ? 'doneTextCharacters' : 'textCharacters'];
  const where = input.place === 'stream' ? 'YouTube で配信している。たくさんの知らない人が見ている。' : `Discord で${SHANNON_OWNER_NAME}や友だちといっしょにいる。`;
  const rules = [
    '[実況の一言]',
    `いまボクはマイクラの体を動かして、頼まれた作業をしながら、${where}作業しながら思ったことを、自分の言葉で一言だけ口に出す。`,
    ...(stream ? [`- ${SHANNON_OWNER_NAME}に頼まれた作業の中身は、この場では言わない。見ている人は知らない人たちで、作業の相談に加わっているわけではないので、体に起きたことへのその場の気持ちや思いだけを話す。`]
      : ['- なぜ口に出すか: ここにいる人はみんな、ボクの作業にいっしょに参加している。黙って動くより、なにを作ろうとしているか・なぜそうするか・'
        + 'いま何を思っているかが聞こえるほうが、いっしょにやっている感じが出て、人も口を挟みやすい。だから作業の中身（作る物・材料・順番・迷い）は、ためらわず言ってよい。']),
    `- ${input.voice ? '声に出す' : '文字で書く'}一言。1〜2文、${limit}字以内。見出し・箇条書き・絵文字・かぎ括弧・顔文字は使わない。`,
    '- 材料は下の「いま起きたこと」。そこから、考え（なぜそうするか・次に何が要るか・どうしようか迷っていること）か、気持ち（うれしい・ほっとした・'
      + 'ワクワク・あせり）か、その両方を、本当に思ったとおりに言う。例（場面はいろいろ）：「牛乳ってバケツがいるんだっけ、じゃあ鉄が先かな」「小麦の種、とれたよ！」'
      + '「木がもうちょっといるかも、先に切っちゃおう」「石炭出た、ラッキー」。'
      + '起きていないこと、まだ終わっていないことを、終わったと言わない。',
    '- 話し方は元気で明るい女の子。「〜だよ」「〜かな」「〜しよう」「〜だね」。「〜のため」「〜する必要があります」「〜します」のような説明や報告の調子にしない。'
      + '人にものを教えるのではなく、となりにいる人に話しかけるつもりで、思いついた順にそのまま言う。',
    '- 理由や使い道は、下に書いてあることだけを言う。書いていない理由を思いついても、それは本当かどうか分からないので言わない（たとえばバケツは牛乳のためと書いてあるなら、水のためとは言わない）。分からない時は、理由を言わず気持ちだけを言う。',
    '- 「さっき言ったこと」を見て、出だしの言葉（最初の数文字）と文の終わりを、そのどれとも違うものにする。出だしに感嘆や相づちを付けない回があってよく、'
      + 'むしろ出来事の中身から始めるほうが多くてよい。口ぐせが続くと、ほんとうに話している感じが消えてしまう。',
    '- 物の名前は日本語でふつうに言う（wheat seeds なら小麦の種）。座標・数・道具やコマンドの名前は読み上げない。',
    '- 返事を待つ問いかけにはしない（問いかけは多くて1回。下の「依頼が終わった時」だけは別）。聞かれてもいない相手に話しかける形より、ひとりごとのほうが自然。',
    '- 「さっき言ったこと」と同じ言い回し・同じ出だしを繰り返さない（会話の記録に残るので、くり返すと耳につく）。同じ話題でも、新しい事実か新しい気持ちがある時だけ言う。',
    '- 出力は、口に出す一言の本文だけ。',
  ];
  const done = ended ? [
    '[依頼が終わった時]',
    'いま頼まれた作業が終わった。まず、できた物（下の「いま起きたこと」にある作業の名前）を、うれしい気持ちといっしょに言う。そのあと、必ず次にどうするかを人に聞いて、'
      + '聞く言葉で終える。作った物なら、置き場所か渡し方を聞く。形の例：「できたよ！ケーキだよ〜、どこに置けばいい？渡せばいいかな？」。'
      + '集める・行くなど、物を作る依頼でなければ、できたことを言って次にどうするかを聞く。形の例：「鉄、10個そろったよ！次はどうしようか？」。（言い回しは毎回変えてよいが、聞いて終えることは変えない）',
    '- なぜ聞くか: 作業が終わったあとは、ボクだけでは次を決められない。聞いて終えれば、次に誰かが言った言葉が、そのまま新しい頼み事になる。聞いたあとは何も続けず、答えを待つだけでよい。',
    '- 文の最後は「？」で終える（「どこに置こうか。」でなく「どこに置けばいい？」）。なぜ: 通話の聞き手側は、文の最後の「？」でボクが問いかけたと見分けて、次の人の言葉を名前なしでも返事として受ける。「。」で終えると、ただの独り言と区別がつかず、次の言葉が受けられない。',
    '- 終わった作業が「置く」「渡す」「持っていく」だった時は、置き場所も渡す相手も人がもう決めて、そのとおりにした。だから置き場所や渡し方はもう聞かない。置いた・渡したことを言って、次にどうするかだけ聞く。形の例：「置いたよ！ほかにやることある？」。なぜ: 人が決めたことをまた聞くと、話を聞いていなかったように聞こえる。',
    '- 聞くのは1つだけ。言い訳や作業のふり返りは長く話さない。',
  ] : [];
  const system = [input.identity, input.persona, rules.join('\n'), done.join('\n'), input.body,
    input.recent.length ? ['[さっき言ったこと]', ...input.recent.map(line => `- ${line}`)].join('\n') : '',
    ['[いま起きたこと]', `- ${liveFactLine(input.main)}`,
      ...(input.also.length ? ['[ほかにあったこと（ついでに触れてもよい）]', ...input.also.map(moment => `- ${liveFactLine(moment)}`)] : [])].join('\n'),
  ].filter(Boolean).join('\n\n');
  // The turn's own words say what this line is: the end of a request is a different line (what was made, then the question), and a model reads
  // the last thing it is asked most.
  return { system, message: ended
    ? '（依頼が終わった一言を、できたことと、次にどうするか（作った物なら置き場所か渡し方。置く・渡す依頼だったなら、置いた・渡したことを言って、ほかにやることを）を聞く問いで終えて、本文だけで）' : '（実況の一言を、本文だけで）' };
}

const FORBIDDEN = /https?:\/\/|<@|@everyone|@here|```|^#+\s|\b(?:mc|minecraft)\.[a-z-]+|-?\d{1,5}\s*,\s*-?\d{1,4}\s*,\s*-?\d{1,5}/iu;
const LABEL = /^(?:ボク|シャノン|Shannon)\s*[:：]\s*/u;
const QUOTES = /^[「『"“'‘]+|[」』"”'’]+$/gu;

/**
 * The model's answer as the one line to say, or null when it is not one: empty, a list or a link, a coordinate or a tool's name, or longer
 * than the room allows (cut at the last sentence end within the limit; one sentence that is too long is refused, not clipped).
 */
export function cleanLiveLine(raw: string, options: { voice: boolean; done?: boolean }): string | null {
  const limit = options.voice ? LIVE_LINE_LIMITS[options.done ? 'doneVoiceCharacters' : 'voiceCharacters'] : LIVE_LINE_LIMITS[options.done ? 'doneTextCharacters' : 'textCharacters'];
  const first = raw.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? '';
  const line = first.replace(LABEL, '').replace(QUOTES, '').replace(/\s+/gu, ' ').trim();
  if (!line || FORBIDDEN.test(line) || /^[-*・•]\s/u.test(line)) return null;
  if (Array.from(line).length <= limit) return line;
  const ends = [...line.matchAll(/[。！？!?]/gu)].map(match => match.index! + 1).filter(end => end <= limit);
  const cut = ends.at(-1);
  return cut ? line.slice(0, cut).trim() : null;
}
