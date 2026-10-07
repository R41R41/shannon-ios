import { createHash } from 'node:crypto';
import { looksSecret } from '@shannon/cognition';
import { checked, encodeSkill, injectionThreats, parseSkill, type SkillDocument } from './skillDocument.js';
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

/** A body as it may be stored: a valid SKILL.md, passing the check (privacy review B2: at build, restore, adopt and export). */
export function checkedSkillBody(draft: SkillDocument, check: SkillBodyCheck | null): { skill: SkillDocument; text: string } | { rejected: SkillRejection } {
  const valid = checked(draft);
  if ('problem' in valid) return { rejected: valid.problem };
  const text = encodeSkill(valid.skill);
  // What the owner said is 内緒 never enters a skill (ADR-0002, owner answer I-4).
  if (check === null) return { rejected: 'check_unavailable' };
  try { if (check.carries(text)) return { rejected: 'secret' }; } catch { return { rejected: 'check_unavailable' }; }
  return { skill: valid.skill, text };
}

/**
 * A stored or adopted text, checked again as it is: a SKILL.md that passes `checkedSkillBody`, and the text itself carries nothing
 * the check catches, nothing credential-shaped, no injection. `unavailable` when the check cannot be read now (fail closed).
 */
export function checkedSkillText(text: string, check: SkillBodyCheck | null): { ok: SkillDocument } | 'unsafe' | 'unavailable' {
  if (!text.trim() || text.length > 20_000 || looksSecret(text) || injectionThreats(text).length > 0) return 'unsafe';
  const parsed = parseSkill(text);
  if ('problem' in parsed) return 'unsafe';
  const body = checkedSkillBody(parsed.skill, check);
  if ('rejected' in body) return body.rejected === 'check_unavailable' ? 'unavailable' : 'unsafe';
  try { if (check!.carries(text)) return 'unsafe'; } catch { return 'unavailable'; }
  return { ok: body.skill };
}
