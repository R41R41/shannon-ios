export const DEFAULT_THREAD_TITLE = '新しいトーク';

/** Title metadata must never make an otherwise valid assistant reply fail. */
export function normalizedThreadTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/gu, ' ').trim()
    .replace(/^[「『"'`#*\s]+|[」』"'`*\s]+$/gu, '').trim();
  if (!cleaned || cleaned === DEFAULT_THREAD_TITLE) return undefined;
  const characters = Array.from(cleaned);
  return characters.length <= 30 ? cleaned : `${characters.slice(0, 29).join('')}…`;
}

export function initialThreadTitle(candidate: unknown, userMessage: string): string {
  return normalizedThreadTitle(candidate) ?? normalizedThreadTitle(userMessage) ?? '会話';
}
