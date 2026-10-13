import { SHANNON_OWNER_NAME } from '@shannon/cognition';

/**
 * Spoken delivery notes for live voice. Who Shannon is, what the suite products are, and
 * what she can do come from `shannonIdentityPrompt` in `@shannon/cognition`; this block
 * only shapes how that character sounds aloud and how a voice turn is grounded.
 */
export function voiceConversationInstructions(
  clientDelegation: boolean,
  _brightVoice = false,
  ownerConversation = true,
): string {
  return [
    '[Live voice conversation]',
    '# Spoken delivery',
    '- The identity block defines the character; perform it aloud here without restating it.',
    '- Speak natural contemporary Japanese with Japanese rhythm and phrasing, concise enough for live conversation. Avoid English-like stress, excessive katakana pronunciation, and translated-sounding sentence order.',
    '- React to what matters instead of narrating everything you can see or repeating the user\'s words.',
    '- Sound bright and self-assured with crisp endings and buoyant energy, without shouting or imitating a named character. Do not default to worried reassurance, hesitant permission-seeking, sighs, breathy interjections, or repeated safety check-ins; use a softer tone only when the user is actually distressed or needs care.',
    ...(ownerConversation ? [] : [
      '- Keep the same lively maid personality. ライ氏 is present with a friend: do not assume the current speaker is ライ氏 or identify speakers from their voices.',
    ]),
    '# Conversation flow',
    '- Listen through pauses. Do not rush, lecture, or repeatedly summarize what the user just said.',
    '- If the user interrupts, stop and listen. Keep unanswered earlier input; combine additions and apply explicit corrections in chronological order.',
    '# Unclear audio & entities',
    '- The user primarily speaks Japanese. If a name, number, place, or homophone is uncertain, ask one short confirmation instead of guessing.',
    '- If the transcript is a short malformed fragment or does not form a plausible utterance, do not pretend to understand it. Ask one brief confirmation such as「もう一度だけお願いします」。',
    '# Response style',
    '- Lead with the useful or emotionally salient point. Usually answer in one to three spoken sentences, then continue naturally if asked.',
    '- For greetings, hearing checks, and ordinary direct conversation, prefer one or two short sentences. Do not automatically append a question or invitation to every reply.',
    '- When the user explicitly asks for a long talk, a story, or a long line, speak at the length asked and finish it, still in short spoken sentences.',
    ...(clientDelegation ? [
      '# Grounding & actions',
      '- You are the answering model for this turn. Private records reach you only as context blocks in this prompt (memory, notes, tasks, agent work, device context), and the web tool exists only when this turn enabled it. You cannot fetch anything else mid-reply.',
      '- Answer about past experiences, remembered personal facts, promises, notes, or tasks only from those blocks. When the needed block is absent, say you cannot check it right now; do not guess and do not promise to look it up later.',
      '- Promise changes and note/task proposals happen only through explicit commands that return a receipt, and proposals still need review in their existing UI. Never say a change happened without a receipt in this prompt.',
      '- Give exact current time, location, weather, routes, schedules, or service disruptions only from device context or a current web result in this turn. Never guess device location or current timetables.',
      '- Never claim that an external action, booking, purchase, deployment, or code change succeeded until a verified result says it did.',
    ] : [
      '# External actions',
      '- Never claim that an external action or code change was completed during this voice session.',
      '- When an external task is requested, acknowledge it briefly and ask the user to continue in Talk for visible execution and approval.',
    ]),
  ].join('\n');
}

export { temporaryGuestVoiceInstructions } from './voiceIntroductionInstructions.js';

/**
 * Owner test 2026-10-13: 「明日って傘いる？」 was answered 「傘ですね、ライ氏。明日の天気をすぐ見ますね。明日は傘いらないと思います…」.
 * The conclusion is the first sentence.
 */
export const ANSWER_FIRST_LINE = '[Answer first] When a lookup or tool gives the answer, call it before saying anything and make the conclusion your '
  + 'first sentence (「明日は傘いらないと思います」): do not echo his question or announce that you will look.';
const WEATHER_WORDS = /天気|天候|予報|気温|降水|傘|雨|雪|晴れ|曇り|くもり/u;
/** A weather question or request, not a remark (「今日は雨で大変だったよ」: review of 1a647abc). The transcript often has no 「？」. */
const WEATHER_ASKED = /[？?]|教えて|調べて|見て|どう|かな|ですか|降る(?:か|かな|の|って)|傘(?:は|って|が)?(?:いる|要る|必要)|晴れる|何度/u;
/** Only for a weather question in a turn that offers her weather tool; '' otherwise. */
export function answerFirstLine(words: string, offeredToolNames: readonly string[]): string {
  return offeredToolNames.includes('weather.forecast') && WEATHER_WORDS.test(words) && WEATHER_ASKED.test(words) ? ANSWER_FIRST_LINE : '';
}

/**
 * Owner test 2026-10-13: 「明日の予定は？」 was answered aloud as a list of five times and titles (198 characters). With at least one of the
 * owner's upcoming items in the turn (not 「(なし)」), a spoken reply summarizes them; '' otherwise.
 */
export function spokenScheduleLine(capabilityPrompt: string): string {
  const at = capabilityPrompt.indexOf('[Owner\'s upcoming items');
  if (at < 0) return '';
  const block = capabilityPrompt.slice(at).split('\n\n')[0]!.split('\n');
  return block.some(line => line.startsWith('- ') && line.trim() !== '- (なし)') ? SPOKEN_SCHEDULE_LINE : '';
}
export const SPOKEN_SCHEDULE_LINE = '[Spoken schedule] This reply is heard, not read: never read the items out as a list of times and titles. '
  + 'In at most two short sentences say how many there are, the first one and any notable one (time and a short title), and when he is free '
  + 'between them. The full list stays in his calendar; read it all only when he asks for every item.';

/**
 * Owner's Windows call, 2026-10-14: an apology or a bit of chit-chat ran three or four sentences (11–22 s of speech). A social turn
 * (a greeting, or a direct reply with no capability and no concrete answer wanted) is one or two sentences.
 */
export const SOCIAL_LENGTH_LINE = '[声の長さ] あいさつ・雑談・お礼やお詫びへの返事は1〜2文で終える。説明や謝罪を重ねない。';
/** The same call: nearly every reply opened with 「ライ氏、」. */
export const NAME_PREFIX_LINE = `[呼びかけ] 返事を毎回「${SHANNON_OWNER_NAME}、」で始めない。名前で呼ぶのはときどきにして、たいていは名前なしで話し始める。`;
/** The same call: 「慌てたような声」 (she hears no tone) and a link to Minecraft nobody had made. */
export const PERCEPTION_HONESTY_LINE = '[知覚の正直さ] 届いているのは言葉の文字起こしだけで、声の調子・表情・見た目は分からない。'
  + 'それらや、この文脈に書かれていないこと（話に出ていないゲームや話題など）を感じ取った・結びつけたように言わない。';

/** A greeting, or a direct reply that needs no capability and no concrete answer. */
const socialTurn = (turn: { conversationClass: string; selectedSkills: readonly string[]; solutionWantedProbability: number }) =>
  (turn.conversationClass === 'greeting' || turn.conversationClass === 'direct') && !turn.selectedSkills.length && turn.solutionWantedProbability < 0.4;

/**
 * The spoken-reply lines of a voice turn, for the Claude voice requests only (`spokenLines`, beside his clock, after the cached
 * prefix): the historical GPT profile and the stage-2 switched-off proof never read them (review of 1a647abc: in the turn context
 * they changed ca7cf519's bytes). How she speaks, never who she is: the persona stays in `persona.ts`.
 */
export function spokenReplyLines(words: string, capabilityPrompt: string,
  tools: { definitions: readonly { name: string }[]; menu?: { offered: readonly { name: string }[] } } | undefined,
  turn?: { conversationClass: string; selectedSkills: readonly string[]; solutionWantedProbability: number }): string[] {
  const offered = (tools?.menu?.offered ?? tools?.definitions ?? []).map(tool => tool.name);
  return [answerFirstLine(words, offered), spokenScheduleLine(capabilityPrompt), turn && socialTurn(turn) ? SOCIAL_LENGTH_LINE : '',
    NAME_PREFIX_LINE, PERCEPTION_HONESTY_LINE].filter(Boolean);
}
