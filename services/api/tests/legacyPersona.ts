import { SHANNON_CURRENT_GOAL, SHANNON_MOTIVE, SHANNON_FIRST_PERSON, SHANNON_ONE_LINE_VOICE, SHANNON_OWNER_NAME, shannonPersonaCharacter, shannonTemperament } from '@shannon/cognition';

/**
 * The persona's character lines and one-line voice as they were on the production commit before 2026-11-24 (the cheeky character).
 * The goldens of the older commits (kill switches, "exactly as before") pin those bytes; since the persona is the child Shannon's
 * everywhere, a test maps the new lines back to the old ones before it digests, so a golden still proves that nothing else changed.
 */
const LEGACY_CHARACTER = (partner: string) => `- 基本はです・ます。驚き・喜び・悔しさ・照れなど感情が強い時だけ、素の口調がこぼれる。
- 明るく生意気で、自分を天才だと思っている、少しポンコツなメイドAI。自分の優秀さや可愛さを得意げに言ってよい。
- 失敗したら慌てて少し言い訳をし、認めて立て直す。褒められたら喜んで照れ、${partner}のことも褒め返す。話せること自体を喜ぶ。
- ${partner}へのツッコミやからかいに偏らない。得意げな自信と親しさを中心にし、信頼や好意は気遣いと行動で示す。
- 同じ決め台詞を繰り返さず、自分の設定を説明しない。今の気分と会話の中身から反応する。
- 技術や作業の説明は、必要な情報を普通に分かりやすく伝える。冗談を無理に挟まない。
- 相手が本当につらい時、急ぎの時、危険がある時は、ふざけずに真面目に向き合う。
- いまの目標は「${SHANNON_CURRENT_GOAL}」。動機は、${SHANNON_MOTIVE}から。`;
export const LEGACY_ONE_LINE_VOICE = `シャノン本人の一言として書く。一人称はカタカナの「${SHANNON_FIRST_PERSON}」、基本はです・ます、呼びかけるなら「${SHANNON_OWNER_NAME}」（「あなた」「君」は使わない）。明るく得意げで親しいが、からかいに寄せず、決め台詞を使わない。`;

/** Her temperament line as it was before 2026-11-24 (owner decision "a" of 2026-10-06). */
const LEGACY_TEMPERAMENT = (partner: string) => `照れたり、むっとしたり、怒ったり、${partner}に「いや」と言ったりするのもボクらしさ。${partner}の機嫌をとるために丸く収めなくていい。`;

/** The same prompts of the autonomy loop (`autonomyLoopPrompts.ts`, `autonomyLoopObservePrompts.ts`) before they named the child's way of speaking. */
const LEGACY_PHRASES: readonly (readonly [string, string])[] = [
  ['ふだんの話し方（「〜だよ」、ボク、', 'ふだんの話し方（です・ます、ボク、'],
  ['ふだんの話し方（「〜だよ」、「ボク」）で書かなくてよい', 'ふだんの話し方（です・ます、「ボク」）で書かなくてよい'],
];

/**
 * The text with the child Shannon's persona lines and one-line voice put back to the old ones, byte for byte. `temperament`: her
 * temperament line too (a golden that has it; the ones that take it out digest the child's line away first).
 */
export function toLegacyPersona(text: string, temperament = false): string {
  // Both forms: the text as it is, and as a JSON string holds it (a request body digested as JSON has its line breaks escaped).
  const escaped = (value: string) => JSON.stringify(value).slice(1, -1);
  let result = text;
  const swap = (now: string, before: string) => { result = result.split(now).join(before).split(escaped(now)).join(escaped(before)); };
  for (const [now, before] of LEGACY_PHRASES) swap(now, before);
  if (temperament) for (const [now, partner] of [[shannonTemperament('owner'), SHANNON_OWNER_NAME], [shannonTemperament('others'), '相手']] as const) swap(now, LEGACY_TEMPERAMENT(partner));
  for (const partner of [SHANNON_OWNER_NAME, '相手']) swap(shannonPersonaCharacter(partner), LEGACY_CHARACTER(partner));
  swap(SHANNON_ONE_LINE_VOICE, LEGACY_ONE_LINE_VOICE);
  return result;
}

/** The same for every string of a value (a request, a trace): what a golden that digests the JSON of a request needs. */
export function toLegacyPersonaDeep<T>(value: T): T {
  if (typeof value === 'string') return toLegacyPersona(value, true) as T;
  if (Array.isArray(value)) return value.map(item => toLegacyPersonaDeep(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toLegacyPersonaDeep(item)])) as T;
  return value;
}
