/**
 * The short sounds she makes first in a voice channel while the real reply is still being written (dc-voice, 2026-10-20: 「話し終わり
 * から最初の声まで2秒以内」). The body keeps each as audio (`GET /v1/platform/voice/fillers`, then `/voice/speech` once per text) and
 * plays the one the `decision` line names. She is told which one she said, so her reply goes on from it instead of repeating it.
 *
 * A filler is a backchannel, not an answer: it is never chosen for words that are short enough to answer at once, for an order to stop
 * or a warning, or for a heavy feeling (an apology, thanks), where a bare 「うん。」 would sound careless.
 */
export interface VoiceFiller {
  id: string;
  /** Spoken as it is. */
  text: string;
  /** ElevenLabs acting tags for the clip; empty for none. */
  style: string;
  /** The kind of words it follows. */
  after: ReadonlyArray<'question' | 'statement' | 'request' | 'named'>;
}

export const VOICE_FILLERS: readonly VoiceFiller[] = Object.freeze([
  { id: 'un', text: 'うん。', style: '', after: ['statement', 'named'] },
  { id: 'unun', text: 'うんうん。', style: '', after: ['statement'] },
  { id: 'hee', text: 'へえ。', style: '', after: ['statement'] },
  { id: 'naruhodo', text: 'なるほど。', style: '', after: ['statement'] },
  { id: 'a', text: 'あ、', style: '', after: ['statement', 'question', 'named'] },
  { id: 'etto', text: 'えっと、', style: '', after: ['question', 'request'] },
  { id: 'sou', text: 'そうだねぇ。', style: '', after: ['question'] },
  { id: 'n', text: 'ん〜、', style: '', after: ['question', 'request'] },
  { id: 'hai', text: 'はーい。', style: '', after: ['named', 'request'] },
  { id: 'ok', text: 'わかった。', style: '', after: ['request'] },
]);

const BY_ID: ReadonlyMap<string, VoiceFiller> = new Map(VOICE_FILLERS.map(filler => [filler.id, filler]));

export const voiceFillerById = (id: string): VoiceFiller | null => BY_ID.get(id) ?? null;

/** Words that need an answer at once, or a careful one: no filler before them. */
const URGENT = /止まって|やめて|待って|危ない|あぶない|逃げて|助けて|死ん|ストップ|今すぐ|すぐ(?:に)?[^\s]{0,6}(?:して|来)/u;
const HEAVY = /ごめん|すみません|申し訳|ありがとう|ありがと|おめでとう|悲しい|つらい|辛い|疲れた|しんどい/u;
const QUESTION = /[?？]|(?:か|かな|かい|っけ|でしょ|だろ|よね|の)[。.!！…]*$|何|なに|どう|いつ|どこ|誰|だれ|どれ|なぜ|どっち/u;
const REQUEST = /(?:ください|くれる|くれない|もらえる|お願い|教えて|見せて|聞かせて|して|やって)[よねな]?[。.!！…]*$/u;

export type FillerSituation = 'question' | 'statement' | 'request' | 'named';

/** What kind of words these are, for the choice (the shared-table rules decide whether she answers at all). */
export function fillerSituation(transcript: string, reason: string): FillerSituation {
  if (reason === 'request' || REQUEST.test(transcript)) return 'request';
  if (reason === 'question' || QUESTION.test(transcript)) return 'question';
  if (reason === 'named') return 'named';
  return 'statement';
}

/** The characters that count as speech: no spaces or punctuation. */
const spoken = (text: string): number => Array.from(text.replace(/[\s、。,.!！?？…「」『』（）()]/gu, '')).length;

/**
 * A filler for these words, or null. `previous` is the one she used last (not repeated); `random` is injected for tests.
 * Short words (under eight spoken characters) are answered at once, so no filler.
 */
export function selectVoiceFiller(input: { transcript: string; reason: string; previous?: string | undefined; random?: () => number }): VoiceFiller | null {
  const text = input.transcript.trim();
  if (spoken(text) < 8 || URGENT.test(text) || HEAVY.test(text)) return null;
  const situation = fillerSituation(text, input.reason);
  const fitting = VOICE_FILLERS.filter(filler => filler.after.includes(situation) && filler.id !== input.previous);
  if (!fitting.length) return null;
  const roll = (input.random ?? Math.random)();
  return fitting[Math.min(fitting.length - 1, Math.floor(roll * fitting.length))]!;
}
