import { SHANNON_PURSUIT_LIMITS, type ShannonPursuitKind, type ShannonPursuitLink, type ShannonPursuitOrigin, type ShannonPursuitStatus } from '@shannon/cognition';

/**
 * Shannon's own pursuits ledger (「シャノンのやりたいこと」). It is separate from the
 * owner's intention ledger (`cognitive_intents`) and never written by owner goals.
 *
 * The seed entries are the goal and motive of ADR-0002. They are inserted once per
 * owner scope and the table refuses to change or remove them; changing a seed means
 * changing `SHANNON_SEED_PURSUITS`, which is core.
 */
export interface PursuitDraft {
  kind: ShannonPursuitKind;
  title: string;
  why: string;
  origin: Exclude<ShannonPursuitOrigin, 'seed'>;
  links?: readonly ShannonPursuitLink[];
}

export type PursuitRejection =
  | 'PURSUIT_INVALID' | 'PURSUIT_DUPLICATE' | 'PURSUIT_LIMIT' | 'PURSUIT_NOT_FOUND' | 'PURSUIT_SEED_IMMUTABLE' | 'PURSUIT_CLOSED';

export const KINDS: readonly ShannonPursuitKind[] = ['goal', 'question', 'work'];
export const STATUSES: readonly ShannonPursuitStatus[] = ['active', 'resting', 'done', 'dropped'];

export function normalizedDraft(draft: PursuitDraft): Required<PursuitDraft> | null {
  if (!draft || typeof draft !== 'object') return null;
  if (!KINDS.includes(draft.kind) || (draft.origin !== 'conversation' && draft.origin !== 'self')) return null;
  const title = text(draft.title, SHANNON_PURSUIT_LIMITS.title);
  const why = text(draft.why, SHANNON_PURSUIT_LIMITS.why);
  const links = normalizedLinks(draft.links ?? []);
  if (!title || !why || !links) return null;
  return { kind: draft.kind, title, why, origin: draft.origin, links };
}

export function normalizedLinks(links: readonly ShannonPursuitLink[]): ShannonPursuitLink[] | null {
  if (!Array.isArray(links) || links.length > SHANNON_PURSUIT_LIMITS.links) return null;
  const result: ShannonPursuitLink[] = [];
  for (const link of links) {
    const label = text(link?.label, SHANNON_PURSUIT_LIMITS.linkLabel);
    const url = typeof link?.url === 'string' ? link.url.trim() : '';
    if (!label || !url || url.length > SHANNON_PURSUIT_LIMITS.linkUrl || !/^(?:https:\/\/|aether:\/\/|voyager:\/\/)\S+$/u.test(url)) return null;
    result.push({ label, url });
  }
  return result;
}

export function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

export function titleKey(title: string): string {
  return title.toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]+/gu, '');
}
