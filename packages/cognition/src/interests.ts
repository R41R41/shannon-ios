const CONVERSATION_NOISE = new Set([
  'これ', 'それ', 'あれ', '今日', '昨日', '明日', '続き', 'こと', 'もの', '感じ', '気持ち',
  'うん', 'はい', 'そう', 'そうだね', 'なるほど', 'ありがとう', '了解', 'えっ', 'ちょっ', 'こん',
  'こんにちは', 'こんばんは', 'おはよう', 'シャノン', 'shannon', '名前',
]);

/** Conservative hygiene for extracted topics and old projections, not a semantic classifier. */
export function isMeaningfulInterest(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.normalize('NFKC').trim().toLowerCase();
  return text.length >= 2 && text.length <= 120 && !CONVERSATION_NOISE.has(text)
    && !/^(?:聞こえ|聴こえ|喋って|しゃべって|話してみて|思って|思う|言って|です|ます)/u.test(text)
    && !/(?:なんだ|るんだ|てるんだ|ですか|ますか|だよね|しよう|してみて|ください)[。!?！？]*$/u.test(text);
}

export function filterMeaningfulInterests(values: readonly unknown[]): string[] {
  return [...new Set(values.filter(isMeaningfulInterest).map(value => value.trim()))];
}
