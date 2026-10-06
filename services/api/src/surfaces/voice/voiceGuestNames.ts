/**
 * How a friend's name is established in a 「友人も一緒」 call: only from the words said. The
 * friend states it, or the owner introduces them by name. Voices are never compared.
 * Conservative on purpose: a missed name leaves the call as "名前を聞いていない方".
 */

/** Katakana, kanji or Latin. A hiragana-only name needs an honorific or a naming verb next to it. */
const STRICT_NAME = '([ァ-ヶー]{2,10}|[一-龠々]{1,4}|[A-Za-z]{2,12})';
const NAME = '([ァ-ヶー]{2,10}|[ぁ-ん]{2,6}?|[一-龠々]{1,4}|[A-Za-z]{2,12})';
const HONORIFIC = '(?:さん|くん|ちゃん|君|氏|様)';
const SAYS = '(?:と言います|といいます|って言います|っていいます|と申します|ともうします)';
const END = '[。！!\\s]*$';
/** What may come before the speaker's own name: a greeting and a first-person word. Nothing else. */
const OPENING = '^(?:(?:はじめまして|初めまして|こんにちは|こんばんは|どうも|えっと|あ)[、。！!\\s]*)?(?:(?:私|わたし|僕|ぼく|俺|おれ|うち)(?:は|、)?[、\\s]*)?';
const RELATION = '(?:友達|友だち|友人|同僚|先輩|後輩|彼女|彼氏|知り合い)';
const INTRODUCES = '紹介(?:する|します|したい|させて)';

/** Said by the friend about themselves, from the start of the utterance. */
const SELF_INTRODUCTION = [
  new RegExp(`${OPENING}${NAME}${SAYS}`, 'u'),
  new RegExp(`${OPENING}${STRICT_NAME}(?:って|と)呼んで`, 'u'),
  new RegExp(`^(?:(?:私|わたし|僕|ぼく|俺|おれ)の)?名前は[、\\s]*${NAME}(?:です|だよ|${SAYS})`, 'u'),
  new RegExp(`^(?:はじめまして|初めまして|こんにちは|こんばんは|どうも)[、。！!\\s]*${STRICT_NAME}です`, 'u'),
];

/** 「ミキです」 counts only as the answer to Shannon asking for a name. */
const ANSWER = new RegExp(`^(?:(?:私|わたし|僕|ぼく|俺|おれ|うち)(?:は|、)?)?(?:${STRICT_NAME}(?:です|だよ|${SAYS})?|([ぁ-ん]{2,6}?)(?:です|だよ|${SAYS}))[。！!]?$`, 'u');
const NAME_QUESTION = /お?名前|なんて(?:呼|お呼び)|何て(?:呼|お呼び)|どう呼/u;

/** Said by the owner about the person next to him, as an introduction happening now. */
const OWNER_INTRODUCTION = [
  new RegExp(`^(?:こちら|この人|この方)(?:は|が)?[、\\s]*(?:${RELATION}の)?(?:${NAME}${HONORIFIC}|${STRICT_NAME})(?:です|だよ|って言う|っていう|といいます)?${END}`, 'u'),
  new RegExp(`^(?:こちら|この人|この方)[、\\s]*${STRICT_NAME}(?:って言う|っていう)`, 'u'),
  new RegExp(`${RELATION}の${NAME}${HONORIFIC}?を${INTRODUCES}`, 'u'),
  new RegExp(`^${NAME}${HONORIFIC}を${INTRODUCES}`, 'u'),
  new RegExp(`^${RELATION}の${NAME}${HONORIFIC}(?:です|だよ)${END}`, 'u'),
];

/** Reported, past or received introductions, and talk about someone who is not here. */
const NOT_AN_INTRODUCTION = /らしい|そうだ|って言ってた|と言ってた|もらっ|もらい|された|されて|してくれ|昨日|この前|先週|今度|日本語|英語|これは|それは|あれは/u;

/** Words the patterns can catch that are not a person's name. */
const NOT_A_NAME = new Set([
  'シャノン', 'しゃのん', 'ライ', 'らい', 'ボク', 'ぼく', 'わたし', 'おれ', 'うち', 'みんな', 'だれ', 'なに', 'どれ', 'それ', 'これ', 'あれ',
  'そう', 'はい', 'うん', 'いいえ', 'ええ', 'げんき', 'だいじょうぶ', 'よろしく', 'はじめて', 'ともだち', 'なんでも', 'ひみつ', 'ないしょ',
  'こそ', 'いい', 'いや', 'だめ', 'ちょっと', 'あとで', 'まだ', 'べつ', 'なし', 'むり', 'ほんと', 'そっち', 'こっち', 'ここ', 'いま',
  '元気', '大丈夫', '友達', '友人', '学生', '会社員', '秘密', '内緒', '初対面', '無理', '好き', '本当', '最高', '何', '誰', '私', '僕', '俺',
  '先生', '先輩', '後輩', '奥', '旦那', '彼', '彼女', '彼氏', '雨', '晴', '嫌', '駄目', '別', '今', '人', '方', '名前', '同僚',
  'オッケー', 'オーケー', 'ゲスト', 'フレンド', 'ダメ', 'ヒミツ', 'ナイショ',
]);

/** Display form of a name: no honorific, no surrounding space. */
export function cleanPersonName(value: string): string {
  return value.normalize('NFKC').trim().replace(new RegExp(`${HONORIFIC}$`, 'u'), '').slice(0, 40);
}

/** Matching key: honorific removed, hiragana folded to katakana, Latin lower-cased. */
export function personNameKey(value: string): string {
  return cleanPersonName(value).toLowerCase().replace(/[\s・]/gu, '')
    .replace(/[ぁ-ゖ]/gu, character => String.fromCharCode(character.charCodeAt(0) + 0x60));
}

function accepted(candidate: string | undefined): string | null {
  if (!candidate) return null;
  // A first-person word caught in front of the name is not part of it.
  const name = cleanPersonName(candidate).replace(/^(?:私|僕|俺|わたし|ぼく|おれ|うち)は?/u, '');
  return name && !NOT_A_NAME.has(name) && !NOT_A_NAME.has(name.toLowerCase()) ? name : null;
}

/**
 * The name established by one utterance, or null. `previousShannonTurn` is what Shannon
 * said just before: a bare 「ミキです」 is accepted only after she asked for a name.
 */
export function establishedGuestName(utterance: string, previousShannonTurn = ''): string | null {
  const text = utterance.normalize('NFKC').trim();
  if (!text || text.length > 80 || /[?？]\s*$/u.test(text) || NOT_AN_INTRODUCTION.test(text)) return null;
  const captured = (match: RegExpExecArray | null) => accepted(match?.slice(1).find(group => group !== undefined));
  for (const pattern of [...OWNER_INTRODUCTION, ...SELF_INTRODUCTION]) {
    const name = captured(pattern.exec(text));
    if (name) return name;
  }
  if (NAME_QUESTION.test(previousShannonTurn) && text.length <= 16) return captured(ANSWER.exec(text));
  return null;
}
