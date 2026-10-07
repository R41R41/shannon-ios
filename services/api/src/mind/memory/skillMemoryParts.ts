import { createHash } from 'node:crypto';
import { looksSecret } from '@shannon/cognition';
import { injectionThreats } from './skillDocument.js';
import type { SkillBodyCheck, SkillRejection } from './skillMemory.js';

/** Helpers of her skill memory (`skillMemory.ts`), kept apart so that file stays within its size. Core: memory. */
export const PATTERN_LIMITS = Object.freeze({ title: 60, body: 1_500 });

/** A pattern page's title and body as stored: present, within bounds, nothing credential-shaped, passing the check. */
export function checkedPage(title: string, body: string, check: SkillBodyCheck | null): { title: string; body: string } | { rejected: SkillRejection } {
  const cleanTitle = title.replace(/\s+/gu, ' ').trim();
  const cleanBody = body.trim();
  if (!cleanTitle || !cleanBody) return { rejected: 'empty' };
  if ([...cleanTitle].length > PATTERN_LIMITS.title || cleanBody.length > PATTERN_LIMITS.body) return { rejected: 'too_long' };
  if (looksSecret(`${cleanTitle}\n${cleanBody}`)) return { rejected: 'secret_like' };
  if (injectionThreats(`${cleanTitle}\n${cleanBody}`).length) return { rejected: 'threat' };
  if (check === null) return { rejected: 'check_unavailable' };
  try { if (check.carries(`${cleanTitle}\n${cleanBody}`)) return { rejected: 'secret' }; } catch { return { rejected: 'check_unavailable' }; }
  return { title: cleanTitle, body: cleanBody };
}

/** Sources as ids only (`experience:<id>`, `knowledge:<id>`, `pattern:<id>`, `choice:<id>`, `sequence:<symbols>`), at most 40. */
export function closedSources(sources: readonly string[]): string[] {
  return [...new Set(sources.filter(source => /^(?:experience|knowledge|pattern|choice|sequence):[A-Za-z0-9][A-Za-z0-9_.:>-]{0,160}$/u.test(source)))].slice(0, 40);
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function iso(at: string): string {
  const time = Date.parse(at);
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString();
}
