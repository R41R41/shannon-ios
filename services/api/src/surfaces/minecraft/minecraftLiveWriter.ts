import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { liveFactLine, type LiveMoment } from '@shannon/mind';

/**
 * Her live line, asked of the model (session dc-live; `SHANNON_MINECRAFT_LIVE_SPEECH`). The line is hers: her identity, her place in her
 * character space (the persona block), her body's present, and what just happened as a fact line; the rules are only those of a spoken
 * word on a chat (short, no list, nothing untrue, nothing of the owner's private matters). The line goes to a room others read or hear,
 * so it is always written as for a shared room. Pure: the wiring hands the identity and the persona, the engine hands the moments.
 */
export const LIVE_LINE_LIMITS = Object.freeze({ voiceCharacters: 54, textCharacters: 100 });

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
}

export function liveWriterPrompt(input: LiveWriterInput): { system: string; message: string } {
  const limit = input.voice ? LIVE_LINE_LIMITS.voiceCharacters : LIVE_LINE_LIMITS.textCharacters;
  const rules = [
    '[実況の一言]',
    `いまボクはマイクラの体を動かしながら、Discord で${SHANNON_OWNER_NAME}や友だちといっしょにいる。体に起きたことについて、自分の言葉で一言だけ口に出す。`,
    `- ${input.voice ? '声に出す' : '文字で書く'}一言。1文、${limit}字以内。見出し・箇条書き・絵文字・かぎ括弧・顔文字は使わない。`,
    '- 下の「いま起きたこと」を材料に、本当に思ったことを言う。起きていないこと、まだ終わっていないことを、終わったと言わない。',
    '- 数字・座標・道具の名前をそのまま読み上げない。「〜します」のような報告の口調にせず、その場の気持ちで話す。',
    `- 誰かに答えている場面ではない。返事を待つ形にしない（問いかけは多くて1回）。${SHANNON_OWNER_NAME}に頼まれた作業の中身は、この場では言わない。`,
    '- 「さっき言ったこと」と同じ言い回し・同じ話題の繰り返しはしない。',
    '- 出力は、口に出す一言の本文だけ。',
  ];
  const system = [input.identity, input.persona, rules.join('\n'), input.body,
    input.recent.length ? ['[さっき言ったこと]', ...input.recent.map(line => `- ${line}`)].join('\n') : '',
    ['[いま起きたこと]', `- ${liveFactLine(input.main)}`,
      ...(input.also.length ? ['[ほかにあったこと（ついでに触れてもよい）]', ...input.also.map(moment => `- ${liveFactLine(moment)}`)] : [])].join('\n'),
  ].filter(Boolean).join('\n\n');
  return { system, message: '（実況の一言を、本文だけで）' };
}

const FORBIDDEN = /https?:\/\/|<@|@everyone|@here|```|^#+\s|\b(?:mc|minecraft)\.[a-z-]+|-?\d{1,5}\s*,\s*-?\d{1,4}\s*,\s*-?\d{1,5}/iu;
const LABEL = /^(?:ボク|シャノン|Shannon)\s*[:：]\s*/u;
const QUOTES = /^[「『"“'‘]+|[」』"”'’]+$/gu;

/**
 * The model's answer as the one line to say, or null when it is not one: empty, a list or a link, a coordinate or a tool's name, or longer
 * than the room allows (cut at the last sentence end within the limit; one sentence that is too long is refused, not clipped).
 */
export function cleanLiveLine(raw: string, options: { voice: boolean }): string | null {
  const limit = options.voice ? LIVE_LINE_LIMITS.voiceCharacters : LIVE_LINE_LIMITS.textCharacters;
  const first = raw.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? '';
  const line = first.replace(LABEL, '').replace(QUOTES, '').replace(/\s+/gu, ' ').trim();
  if (!line || FORBIDDEN.test(line) || /^[-*・•]\s/u.test(line)) return null;
  if (Array.from(line).length <= limit) return line;
  const ends = [...line.matchAll(/[。！？!?]/gu)].map(match => match.index! + 1).filter(end => end <= limit);
  const cut = ends.at(-1);
  return cut ? line.slice(0, cut).trim() : null;
}
