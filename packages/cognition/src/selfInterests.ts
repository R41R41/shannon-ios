import type { MemoryAudience, MemoryDisclosure } from './types.js';

/** Approved ADR8 stage 5 bounds. Supplemental interests never edit persona or reward weights. */
export const SELF_INTEREST_LIMITS = Object.freeze({ items: 12, indexCharacters: 1_000, title: 80, description: 600, reason: 240,
  evidence: 16, additions: 2, removals: 2, initialWeight: 0.5, nightlyWeightDelta: 0.1 });
export type SelfInterestAction = 'undo' | 'pin' | 'unpin' | 'ban' | 'unban' | 'forget' | 'resume';
export interface SelfInterest {
  id: string; topicKey: string; title: string; description: string; reason: string; weight: number;
  evidenceRefs: readonly string[]; disclosure: MemoryDisclosure | null; revision: number; ownerGeneration: number;
  pinned: boolean; banned: boolean; forgotten: boolean; frozen: boolean; retired: boolean; createdAt: string; updatedAt: string;
}
export interface SelfInterestProposal {
  candidateId: string; kind: 'add' | 'patch' | 'remove'; itemId?: string; title?: string; description?: string; weight?: number;
  reason: string; evidenceRefs: readonly string[]; disclosure: MemoryDisclosure | null;
  expectedRevision?: number; ownerGeneration?: number; relatedIds?: readonly string[];
}
export interface SelfInterestOwnerCommand {
  operationId: string; itemId: string; expectedRevision: number; action: SelfInterestAction; changeId?: string;
}
export interface SelfInterestChange {
  changeId: string; seq: number; itemId: string; actor: 'sleep' | 'owner'; kind: string; reason: string;
  before: SelfInterest | null; after: SelfInterest; nightKey: string | null; createdAt: string;
}
export interface SelfInterestSnapshot {
  revision: number; items: readonly SelfInterest[]; changes: readonly SelfInterestChange[];
  capacity: { used: number; limit: number; indexUsed: number; indexLimit: number };
  pending: { total: number; held: number; capacityBlocked: number; provenanceUnknown: number };
  nextCursor: number | null;
}
export interface SelfInterestEvidenceView {
  status: 'available' | 'hidden' | 'unavailable'; total: number; omitted: number;
  items: readonly { id: string; text: string; truncated: boolean }[];
}
export interface SelfInterestDetail {
  revision: number; item: SelfInterest; changes: readonly SelfInterestChange[]; nextCursor: number | null;
  evidence: SelfInterestEvidenceView;
}
export const selfInterestTopicKey = (title: string): string => title.normalize('NFKC').trim().toLowerCase()
  .replace(/[\p{P}\p{Z}\s]+/gu, '').replace(/\+/gu, 'plus');
export function selfInterestWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
export const selfInterestActive = (item: SelfInterest): boolean => !item.retired && !item.banned && !item.forgotten;
export const selfInterestLine = (item: SelfInterest): string => `- ${item.id}: ${item.title}｜重み ${item.weight.toFixed(2)}${item.pinned ? '｜固定' : ''}${item.frozen ? '｜自動更新停止' : ''}`;
const indexHeader = (count: number) => `〈自己関心 ${count}/${SELF_INTEREST_LIMITS.items}〉\n`;
export const selfInterestIndexUsed = (items: readonly SelfInterest[]): number => {
  const active = items.filter(selfInterestActive);
  return active.length ? [...indexHeader(active.length) + active.map(selfInterestLine).join('\n')].length : 0;
};
/** Owner-local real night; old sleep batch dates cannot mint additional allowances. */
export function selfInterestNightKey(at: string, timeZone = 'Asia/Tokyo'): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error('SELF_INTEREST_BAD_TIME');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name: string) => Number(parts.find(item => item.type === name)?.value);
  const calendar = new Date(Date.UTC(part('year'), part('month') - 1, part('day') - (part('hour') < 3 ? 1 : 0)));
  return calendar.toISOString().slice(0, 10);
}
export type SelfInterestVisible = (item: SelfInterest, audience?: MemoryAudience) => boolean;
/** Bounded index, without silently deleting a stored item. Capacity is checked before adoption. */
export function selfInterestProjection(items: readonly SelfInterest[], visible: SelfInterestVisible, audience?: MemoryAudience,
  format: (item: SelfInterest) => string = selfInterestLine): string {
  const selected = items.filter(item => selfInterestActive(item) && visible(item, audience))
    .sort((a, b) => b.weight - a.weight || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (!selected.length) return '';
  const lines = selected.map(format);
  const body = indexHeader(selected.length) + lines.join('\n');
  // All-or-nothing if an incompatible historical index exceeds the current bound. No partial hidden clipping.
  if ([...body].length > SELF_INTEREST_LIMITS.indexCharacters) return '自己関心: 目次の容量を超えています。整理が必要です。';
  return body;
}
