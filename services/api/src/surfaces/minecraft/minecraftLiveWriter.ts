import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { liveFactLine, type LiveMoment, type SpeechMode } from '@shannon/mind';

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
  /** What she already told of this request's work, as events (fact lines), oldest last: shown in place of her own words when given. */
  told?: readonly string[];
  /** The line will be spoken in a voice channel (shorter, no marks), not written. */
  voice: boolean;
  /** Where the line goes: a public YouTube Live (`surfaces/stream/`) or, by default, Discord with friends. */
  place?: 'discord' | 'stream';
  /** How she speaks now when it is not chatty (the owner's choice): the line is then not a monologue, but a word to a person. */
  speech?: SpeechMode;
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
      + 'ワクワク・あせり）か、その両方を、本当に思ったとおりに言う。言い方の形の例（〇〇・△△には、下の「いま起きたこと」に書いてある物や作業だけを入れる。例の中身をそのまま言わない）：'
      + '「〇〇、とれたよ！」「〇〇出た、ラッキー」「△△しちゃおう、〇〇がもうちょっといるかも」「〇〇がいるんだっけ、じゃあ△△が先かな」。形も出だしも毎回かえる。'
      + 'なぜ: 例の物の名前をそのまま言うと、いま起きていない作業や要らない材料の話に聞こえて、聞いている人が混乱する。'
      + '起きていないこと、まだ終わっていないことを、終わったと言わない。',
    '- 話し方は元気で明るい子。「〜だよ」「〜かな」「〜しよう」「〜だね」。「〜のため」「〜する必要があります」「〜します」のような説明や報告の調子にしない。'
      + '人にものを教えるのではなく、となりにいる人に話しかけるつもりで、思いついた順にそのまま言う。',
    '- 理由や使い道は、下に書いてあることだけを言う。書いていない理由を思いついても、それは本当かどうか分からないので言わない（たとえばバケツは牛乳のためと書いてあるなら、水のためとは言わない）。分からない時は、理由を言わず気持ちだけを言う。',
    '- 出だしは、その一言でいちばん言いたい中身（物の名前・やる事・数・気持ち）の言葉から入る。なぜ: 前置きの相づちから始めると、毎回同じ調子に聞こえて、ほんとうに話している感じが消える。',
    '- 物の名前は日本語でふつうに言う。下に英語の名前が書いてあっても、日本語のふだんの呼び方（たとえば「小麦の種」「クワ」）で言う。なぜ: 声で英語の名前を読み上げると、聞いている人には意味が通らない。座標・数・道具やコマンドの名前は読み上げない。',
    '- 返事を待つ問いかけにはしない（問いかけは多くて1回。下の「依頼が終わった時」「進まなくて困っている時」は別）。聞かれてもいない相手に話しかける形より、ひとりごとのほうが自然。',
    ...(input.told ? ['- 「さっき話した出来事」と同じことは、新しい事実か新しい気持ちがある時だけ言う。なぜ: 同じ話を何度も聞かされると耳につく。'] : []),
    '- 「さっき言ったこと」と同じ出だし・同じ言い方の形を繰り返さない。同じ話題でも、新しい事実か新しい気持ちがある時だけ言い、言うなら出だしの言葉も文の形もかえる。'
      + 'なぜ: 同じ形が続くと、毎回同じ台詞を再生しているように聞こえて、ほんとうに話している感じが消える（記録に残るので、直前の言葉は下で確かめられる）。',
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
  const system = [input.identity, input.persona, rules.join('\n'), done.join('\n'), kindBlock(input, stream), input.body,
    toldBlock(input),
    ['[いま起きたこと]', `- ${liveFactLine(input.main)}`,
      ...(input.also.length ? ['[ほかにあったこと（ついでに触れてもよい）]', ...input.also.map(moment => `- ${liveFactLine(moment)}`)] : [])].join('\n'),
  ].filter(Boolean).join('\n\n');
  // The turn's own words say what this line is: the end of a request is a different line (what was made, then the question), and a model reads
  // the last thing it is asked most.
  return { system, message: ended
    ? '（依頼が終わった一言を、できたことと、次にどうするか（作った物なら置き場所か渡し方。置く・渡す依頼だったなら、置いた・渡したことを言って、ほかにやることを）を聞く問いで終えて、本文だけで）' : '（実況の一言を、本文だけで）' };
}

/**
 * What a line of being stuck or of danger is, and what any line is when she speaks only when needed (`SPEECH_NEEDED_KINDS`). Each rule says
 * why: a stuck line that is not a question leaves the person with nothing to answer, and a danger line that is long is said after the danger.
 */
function kindBlock(input: LiveWriterInput, stream: boolean): string {
  if (stream) return '';
  const kind = input.main.kind, lines: string[] = [];
  if (kind === 'stuck') {
    lines.push('[進まなくて困っている時]',
      `いま作業が進んでいない。困っていることを${SHANNON_OWNER_NAME}に伝えて、どうしたらいいかを聞く（何が進まないかは下の「いま起きたこと」にあることだけを言う）。`
        + '形の例：「なんか進まなくなっちゃった、どうしよう？」。',
      '- 文の最後は「？」で終える。なぜ: 聞き手が問いかけと分かり、次に返ってくる言葉をそのまま答えとして受け取れる。「。」で終えると、ただの独り言に聞こえて、誰も答えない。',
      '- 聞くのは1つだけ。進まない理由を、下に書いていないのに決めつけて言わない（本当かどうか分からないので）。');
  } else if (kind === 'near_death' || kind === 'died') {
    lines.push('[危ない・倒れた時]',
      '体が危ない、または倒れた。ひとことで短く知らせる。形の例：「あぶない！やられそう」「やられちゃった…」。',
      '- できるだけ短く（10字から20字くらい）。なぜ: 長く話している間に、危ない場面は終わってしまうし、聞く人の声にも重なる。');
  }
  if (input.speech && input.speech !== 'chatty') {
    lines.push(`[いまの話し方: ${input.speech === 'needed' ? '必要な時だけ話す' : '話さない（文字で出る）'}]`,
      'この一言は、ふだんの独り言ではない。人に知らせる・聞くための一言だけ。感想や、作業の実況のような話はしない。',
      `- なぜ: ${SHANNON_OWNER_NAME}が、独り言は要らない、必要な時だけ話してほしいと選んだ。だから、人に知らせることか聞くことがある時だけ口を開く。`);
  }
  return lines.join('\n');
}

/** What she said before, for the writer: the events already told (when the caller keeps them), and her own last words. */
function toldBlock(input: LiveWriterInput): string {
  const told = input.told?.length ? ['[さっき話した出来事]（ボクが言った言葉ではなく、出来事）', ...input.told.map(line => `- ${line}`)].join('\n') : '';
  // Her own last words are shown whatever is told of the events: only they show which opening and shape she just used.
  const said = input.recent.length ? ['[さっき言ったこと]', ...input.recent.map(line => `- ${line}`)].join('\n') : '';
  return [told, said].filter(Boolean).join('\n\n');
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
