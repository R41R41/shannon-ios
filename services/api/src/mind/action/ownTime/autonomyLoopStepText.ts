import { STUDY_LIMITS } from './store/studyStore.js';

/**
 * The text helpers of her steps (`autonomyLoopSteps.ts`), moved out unchanged so that file stays under the line ceiling:
 * the check that a note does not copy its page, and the trimming of what the model wrote and of what the record shows.
 */
/** True when `body` repeats a run of at least `length` characters of `source`. */
export function sharesLongPassage(body: string, source: string, length: number): boolean {
  const compact = (value: string) => value.replace(/\s+/gu, '');
  const text = compact(body);
  const original = compact(source);
  if (text.length < length || original.length < length) return false;
  const step = Math.max(1, Math.floor(length / 4));
  for (let index = 0; index + length <= text.length; index += step) {
    if (original.includes(text.slice(index, index + length))) return true;
  }
  return original.includes(text.slice(-length));
}

export function story(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const body = value.replace(/\r\n?/gu, '\n').trim();
  return body.length >= 100 && body.length <= STUDY_LIMITS.storyBody ? body : null;
}

export function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

export function clip(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return '不明な宛先'; }
}
