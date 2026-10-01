/**
 * Owner-mode call in which the owner said that someone else is with him and the call was
 * not switched to 「友人も一緒」. Speakers are not separated: from that moment the reply may be
 * heard by another person, so the turn is answered and stored as "someone else was present".
 */

const PERSON = '(?:お友達|お友だち|友達|友だち|ともだち|友人|彼女|彼氏|恋人|同僚|先輩|後輩|家族|奥さん|旦那|妻|夫|お母さん|お父さん|母|父|兄|姉|弟|妹|知り合い|知人)';

/** Past, future, hypothetical, negated or reported wording is not "here now". */
const NOT_NOW = new RegExp([
  'しない', 'じゃない', 'ではない', 'いない', 'いません', 'やめ', 'なくて', 'なかった',
  '昨日', '先週', '先月', 'この前', 'こないだ', 'さっき', '前に', '今度', '明日', '来週', 'いつか', 'そのうち',
  'もし', 'たら', 'なら', '場合',
  'って言って', 'らしい',
  '紹介して(?:ほしい|欲しい|くれ|もらっ|もらい|もらう|あげ)', '紹介され', '紹介する方法', '紹介の仕方',
  '(?:した|してた|していた|いた|来てた|だった|ました|でした)$',
].join('|'), 'u');

const HERE_NOW = new RegExp([
  `${PERSON}(?:が|も)(?:いる|います|来てる|来ています|来た|隣|そば|横|近く|一緒)`,
  `${PERSON}(?:と|も)一緒`,
  `${PERSON}と(?:いる|います|ご飯|ごはん|食事|お茶|カフェ|飲んで|食べて)`,
  `${PERSON}に(?:も)?(?:自己紹介|挨拶|あいさつ)して`,
  `${PERSON}.{0,8}紹介(?:する|します|したい|させて|してもいい|していい)`,
  `紹介(?:したい|してもいい|していい).{0,8}${PERSON}`,
].join('|'), 'u');

/** The owner's words say that another person is with him right now. Deterministic; no model. */
export function ownerSaysCompanionPresent(transcript: string): boolean {
  const value = transcript.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  if (!value || value.length > 60) return false;
  return HERE_NOW.test(value) && !NOT_NOW.test(value);
}

/**
 * Appended to the owner voice prompt while someone else may be listening. The prompt
 * above it already holds only what may be said in front of them.
 */
export const companionPresentInstructions = [
  '[Someone else is listening — 同席者あり]',
  '- ライ氏 said that another person is with him, and the call is still 本人だけ. Everything you say may be heard by that person.',
  '- This prompt therefore contains only memories that hold no protected personal information. His schedule, health, money, work details, relationships, goals, notes, tasks and development work are not available to you now. Do not recall them from earlier turns, guess them, or hint at them.',
  '- If asked for any of that, say in one short sentence that you will tell him when you two are alone, and suggest switching to 「友人も一緒」 with the control at the bottom of the call screen. You cannot switch by yourself.',
  '- You cannot tell voices apart. Do not assume that every sentence is ライ氏\'s.',
].join('\n');
