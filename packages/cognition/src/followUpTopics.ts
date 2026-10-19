/**
 * What he talked about, kept as topics to come back to (owner 2026-10-19, item 11: in a week of a trip to Fukuoka, Starbucks,
 * Splatoon, a cold and a friend's birthday she followed up once, on the cold; and her 「最近の関心」 were 「よかった、ちゃん、すごい、
 * かわいい」). Pure: topics are read from his words at the turn (never kept), and are nouns of a place, a thing he did or the state of
 * his health.
 */
const KANJI_KATAKANA = /[\p{Script=Han}\p{Script=Katakana}A-Za-z]/u;
const NOISE = new Set(['今日', '明日', '昨日', '今夜', '今朝', '最近', '本当', '全部', '自分', '時間', '感じ', '気持ち', '元気', '調子', '大丈夫',
  'シャノン', 'ライ氏', '名前', '会話', '返事', '画面', '頭', '体', '手', '胸', '髪', '腰', '声', '心配', '安心', '我慢', '無理', '期待', '想像', '用意',
  '確認', '説明', '質問', '連絡', '失礼', '邪魔']);

/** A topic of talk: a noun with kanji, katakana or letters, not ending in kana (an adjective or a verb), not a word of every day. */
export function isTopicNoun(value: string): boolean {
  const text = value.normalize('NFKC').trim();
  const characters = Array.from(text);
  if (characters.length < 2 || characters.length > 16 || NOISE.has(text) || !KANJI_KATAKANA.test(text)) return false;
  return !/\p{Script=Hiragana}$/u.test(text);
}

/**
 * A word that may be a topic of hers (`deriveResonantInterest`): a topic noun, or a word all in hiragana that does not end as an
 * adjective, a verb or a name's suffix (うどん, ねこ; never よかった, すごい, かわいい, ちゃん).
 */
export function isTopicWord(value: string): boolean {
  const text = value.normalize('NFKC').trim();
  if (/^[\p{Script=Hiragana}ー]+$/u.test(text)) {
    return Array.from(text).length >= 2 && !NOISE.has(text) && !/(?:い|かった|った|た|だ|る|ね|よ|な|ちゃん|さん|くん|です|ます)$/u.test(text);
  }
  return isTopicNoun(text);
}

const PLACE =/([\p{Script=Han}\p{Script=Katakana}ー]{2,10})(?:に|へ)(?:行(?:く|った|って|きた)|来(?:た|て)|着い|いる|いた)/gu;
const BACK_FROM = /([\p{Script=Han}\p{Script=Katakana}ー]{2,10})から(?:帰|戻)/gu;
const DOING = /([\p{Script=Katakana}ー]{3,12}|[\p{Script=Han}]{2,6})(?:が忙し|を?して(?:た|る|い)|を?やって|が好き|にハマ|を?見て|を?食べ|を?飲ん)/gu;
const LIFE = /(風邪|発熱|頭痛|腹痛|体調|誕生日|旅行|出張|試験|面接|引っ越し|発表|プレゼン|締め切り|ライブ|映画|病院)/gu;

/** The topics of one message of his, in order, without repeats. */
export function topicsOf(message: string): string[] {
  const text = message.normalize('NFKC');
  const found: string[] = [];
  for (const pattern of [PLACE, BACK_FROM, DOING, LIFE]) {
    for (const match of text.matchAll(pattern)) {
      const topic = (match[1] ?? '').replace(/^(?:今日|昨日|明日|今週|来週|先週|今月|来月|週末|今度|今)/u, '');
      if (isTopicNoun(topic) && !found.includes(topic)) found.push(topic);
    }
  }
  return found;
}

export interface FollowUpTopic { topic: string; at: string }

/** How far back topics are offered, and how many. */
export const FOLLOW_UP_LIMITS = Object.freeze({ days: 3, topics: 3 });

/**
 * The topics he talked about before today (newest first, at most `FOLLOW_UP_LIMITS.topics`) and not again today: what she may ask a
 * follow-up about. `dayStart`: the start of her day (3:00 in his zone).
 */
export function followUpTopics(messages: readonly { text: string; at: string }[], dayStart: string): FollowUpTopic[] {
  const today = new Set(messages.filter(message => message.at >= dayStart).flatMap(message => topicsOf(message.text)));
  const earlier = [...messages].filter(message => message.at < dayStart).sort((a, b) => b.at.localeCompare(a.at));
  const topics: FollowUpTopic[] = [];
  for (const message of earlier) {
    for (const topic of topicsOf(message.text)) {
      if (today.has(topic) || topics.some(item => item.topic === topic)) continue;
      topics.push({ topic, at: message.at });
      if (topics.length >= FOLLOW_UP_LIMITS.topics) return topics;
    }
  }
  return topics;
}

/** The line for a greeting turn: what he talked about before, to ask after once if it fits ('' when there is none). */
export function followUpLine(topics: readonly FollowUpTopic[], timeZone = 'Asia/Tokyo'): string {
  if (!topics.length) return '';
  const day = (at: string) => {
    try { return new Intl.DateTimeFormat('ja-JP', { timeZone, month: 'numeric', day: 'numeric' }).format(new Date(at)); } catch { return at.slice(5, 10); }
  };
  return `[話の続き] 少し前にライ氏が話していたこと: ${topics.map(item => `${item.topic}（${day(item.at)}）`).join('、')}。`
    + '話の流れに合えば、このうち一つだけ、その後どうなったかを自然に聞いてよい（毎回はしない。今の話を優先する）。';
}
