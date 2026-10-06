import { filterMeaningfulInterests, isMeaningfulInterest, isMemoryEvidenceVisible, memoryControlFor, memoryIdentifier, visibleMemoryText, type CompanionStateSnapshot } from '@shannon/cognition';

export function worldVisibleInterests(snapshot: CompanionStateSnapshot): string[] {
  return filterMeaningfulInterests(snapshot.interests.flatMap(interest => {
    const text = visibleMemoryText(snapshot, memoryIdentifier('interest', interest), interest);
    return text ? [text] : [];
  }));
}

export function isWorldFocusVisible(snapshot: CompanionStateSnapshot, text: string): boolean {
  if (!isMemoryEvidenceVisible(snapshot, text)) return false;
  return !snapshot.interests.some(interest => {
    const control = memoryControlFor(snapshot, memoryIdentifier('interest', interest));
    return control && (control.status !== 'active' || (control.overrideText && control.overrideText !== interest))
      && normalized(text).includes(normalized(interest));
  });
}

/** A deliberately small bilingual vocabulary, not a claim of semantic understanding. */
function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/\b(?:photography|photos?)\b|画像|フォト/gu, '写真')
    .replace(/\b(?:memories|memory|remember)\b/gu, '記憶')
    .replace(/\bagents?\b/gu, 'エージェント')
    .replace(/\b(?:movies?|films?)\b/gu, '映画');
}

export function topicMatchesSource(topic: string | null | undefined, title: string, summary = ''): boolean {
  if (!topic || !isMeaningfulInterest(topic)) return false;
  const phrase = normalized(topic);
  const text = normalized(`${title} ${summary}`);
  if (containsTerm(text, phrase)) return true;
  const tokens = phrase.replace(/([a-z0-9])(?=[ぁ-んァ-ヶ一-龠])/gu, '$1 ')
    .split(/[\s、,・/の]+/u).filter(value => isMeaningfulInterest(value));
  // A compound interest needs at least two terms; generic "AI" alone is not
  // sufficient evidence that an article concerns "AI agent memory".
  const distinct = [...new Set(tokens)];
  return distinct.length > 0 && distinct.filter(token => containsTerm(text, token)).length >= Math.min(2, distinct.length);
}

function containsTerm(text: string, term: string): boolean {
  if (!/^[a-z0-9 .+#-]+$/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'u').test(text);
}

/** Keep personality wording only when visibly anchored; never invent shared recollection. */
export function groundedWorldOpening(opening: string | undefined, title: string, interest: string | null): string {
  const text = opening?.replace(/\s+/gu, ' ').trim().slice(0, 280);
  const claimsSharedPast = text && /昨日|前に|この前|さっき|覚えて|(?:話|会話).*(?:つなが|繋が|重な)|(?:君|あなた).*(?:好き|興味)/u.test(text);
  const anchored = text && (normalized(text).includes(normalized(title))
    || (interest && normalized(text).includes(normalized(interest))));
  return text && anchored && !claimsSharedPast ? text : 'これ、少し気になりました。';
}
