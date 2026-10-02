import {
  SENSITIVITY_CATEGORY_LABELS, describeAudience, memoryControlFor, resolveDisclosure,
  type CompanionStateSnapshot, type CompanionStateStore, type MemoryControl,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from './conversationStore.js';
import { ImpressionEvidenceCheck, impressionSubject, impressionText, usableImpression } from './impressionRecall.js';
import {
  IMPRESSION_MEMORY_PREFIX, OWNER_PERSON_KEY, impressionConfidence, impressionMemoryId,
  type ImpressionSource, type PersonImpression,
} from './impressions.js';
import { actionControl, buildItem, disclosureView } from './memoryProjection.js';
import type { MemoryItem, MemoryMutation } from './memoryService.js';

/**
 * How the owner sees, corrects and forgets her impressions with the screens that already exist: his own
 * are listed under 「ふたりの関係」 of the memory dashboard, another person's under that person in 人.
 * Every change is the ordinary memory control under `impression:<id>`, so forgetting, restoring,
 * correcting and 機微／ふつう behave as they do for every other memory.
 */

const STATUS_WORDS: Readonly<Record<PersonImpression['status'], string>> = {
  candidate: 'まだ一度気づいただけで、印象として使っていません', active: '印象として使っています',
  fading: '最近は当てはまらないことがあり、弱まっています', retired: '当てはまらなくなったので使っていません',
};
const day = (at: string) => at.slice(0, 10);

function described(row: PersonImpression, state: CompanionStateSnapshot, check: ImpressionEvidenceCheck, source: ImpressionSource): string {
  const usable = usableImpression(row, state, check, row.personKey === OWNER_PERSON_KEY ? [] : source.people(state.scopeKey));
  const lost = !usable && (memoryControlFor(state, impressionMemoryId(row.id))?.status ?? 'active') === 'active';
  const counts = `気づいた回数 ${usable?.supportCount ?? row.supportCount}回${row.contraCount ? `・当てはまらなかった回数 ${row.contraCount}回` : ''}・最初 ${day(row.firstSeenAt)}・最後 ${day(usable?.lastSeenAt ?? row.lastSeenAt)}`;
  return `${lost ? 'もとになった会話が使えなくなったので、使っていません' : STATUS_WORDS[row.status]}（${counts}）`;
}

const listed = (row: PersonImpression, state: CompanionStateSnapshot) =>
  row.status !== 'retired' || Boolean(memoryControlFor(state, impressionMemoryId(row.id)));

/** The owner's own impressions as items of the memory dashboard. Listed whether or not impressions are switched on. */
export function ownerImpressionItems(
  store: Partial<ConversationStore> | null, state: CompanionStateSnapshot, now: string, recent: readonly ShannonExperience[] = [],
): MemoryItem[] {
  const source = store?.impressionStore?.();
  if (!source) return [];
  const rows = source.impressions(state.scopeKey).filter(row => row.personKey === OWNER_PERSON_KEY && listed(row, state));
  if (!rows.length) return [];
  const check = new ImpressionEvidenceCheck(state, store as ConversationStore, state.scopeKey, recent);
  if (check.rules.length) check.load(rows);
  const quotes = new Map(recent.map(turn => [turn.id, turn]));
  return rows.map(row => {
    const id = impressionMemoryId(row.id);
    const control = memoryControlFor(state, id);
    const shown = row.evidence.filter(item => item.stance === 'support' && check.visible(item.id)).flatMap(item => quotes.get(item.id) ?? []).slice(-3);
    return {
      ...buildItem({ id, kind: 'relationship', text: impressionText(row, impressionSubject(row, [])), confidence: impressionConfidence(row, now),
        observedAt: row.lastSeenAt }, control),
      createdAt: row.firstSeenAt,
      changeReason: control?.changeReason ?? described(row, state, check, source),
      evidence: shown.map(turn => ({ quote: Array.from(turn.userMessage).slice(0, 120).join(''), observedAt: turn.observedAt, source: 'conversation' as const })),
      disclosure: disclosureView(state, id, row.disclosure),
    };
  });
}

/**
 * The control one owner action writes for an impression. Its withheld text is the pattern alone, so the
 * forgetting boundary withholds earlier replies that restated it and nothing wider; no turn is named as
 * its evidence, so forgetting an impression never hides the conversations it was noticed in.
 */
function impressionControl(row: PersonImpression, memoryId: string, previous: MemoryControl | undefined, mutation: MemoryMutation, at: string): MemoryControl {
  if (mutation.action === 'complete' || mutation.action === 'dismiss' || mutation.action === 'snooze') throw new Error('MEMORY_COMMITMENT_REQUIRED');
  const changesText = mutation.action === 'forget' || mutation.action === 'reject' || mutation.action === 'correct';
  const item = { id: memoryId, kind: 'relationship', status: previous?.status ?? 'active', pinned: previous?.pinned ?? false } as MemoryItem;
  return {
    ...actionControl(item, previous, mutation, at),
    withheldText: previous?.withheldText ?? row.pattern,
    ...(changesText ? { contextInvalidatedAt: at } : previous?.contextInvalidatedAt ? { contextInvalidatedAt: previous.contextInvalidatedAt } : {}),
  };
}

export const isImpressionMemoryId = (memoryId: string) => memoryId.startsWith(IMPRESSION_MEMORY_PREFIX);

/** Applies an owner action from the memory dashboard to one of his own impressions. False: no such impression. */
export function mutateOwnerImpression(
  stateStore: CompanionStateStore, store: Partial<ConversationStore> | null, scopeKey: string, mutation: MemoryMutation, at: string,
): boolean {
  const row = store?.impressionStore?.().impressions(scopeKey).find(item => impressionMemoryId(item.id) === mutation.memoryId && item.personKey === OWNER_PERSON_KEY);
  if (!row) return false;
  const previous = memoryControlFor(stateStore.snapshot(scopeKey), mutation.memoryId);
  stateStore.apply(scopeKey, { type: 'memory-control-upserted', control: impressionControl(row, mutation.memoryId, previous, mutation, at) });
  return true;
}

/** One impression of a remembered person, in the shape 人 already renders under 「その人のこと」. */
export interface PersonImpressionView {
  id: string; kind: 'fact'; kindLabel: string; text: string; observedAt: string; audience: string;
  sensitivity: 'sensitive' | 'ordinary'; decidedBy: 'rule' | 'owner' | 'default'; reason: string; status: 'active' | 'forgotten';
}

export function personImpressionViews(
  source: ImpressionSource | undefined, state: CompanionStateSnapshot, personId: string, nameOf: (personId: string) => string | undefined,
): PersonImpressionView[] {
  const rows = source?.impressions(state.scopeKey).filter(row => row.personKey === personId && listed(row, state)) ?? [];
  if (!source || !rows.length) return [];
  const people = source.people(state.scopeKey);
  const check = new ImpressionEvidenceCheck(state, null, state.scopeKey);
  return rows.map(row => {
    const id = impressionMemoryId(row.id);
    const control = memoryControlFor(state, id);
    const resolved = resolveDisclosure(state, id, row.disclosure);
    return {
      id: row.id, kind: 'fact' as const, kindLabel: 'その人のこと',
      text: `シャノンの印象: ${impressionText(row, impressionSubject(row, people))}／${described(row, state, check, source)}`,
      observedAt: row.lastSeenAt, audience: describeAudience(resolved.audience, nameOf),
      sensitivity: resolved.sensitivity ?? 'sensitive', decidedBy: resolved.decidedBy === 'owner' ? 'owner' as const : 'rule' as const,
      reason: resolved.decidedBy === 'owner' ? 'ライ氏が選んだ扱い' : resolved.category ? `${SENSITIVITY_CATEGORY_LABELS[resolved.category]}（${resolved.reason ?? ''}）` : resolved.reason ?? '',
      status: (control?.status ?? 'active') === 'active' ? 'active' as const : 'forgotten' as const,
    };
  });
}

/** 人 › forget, restore, 機微／ふつう on an impression of a remembered person. Null: the id is not an impression. */
export function mutatePersonImpression(
  stateStore: CompanionStateStore, source: ImpressionSource | undefined, scopeKey: string, itemId: string,
  action: 'forget' | 'restore' | 'mark-sensitive' | 'mark-ordinary', at: string,
): boolean | null {
  const row = source?.impressions(scopeKey).find(item => item.id === itemId && item.personKey !== OWNER_PERSON_KEY);
  if (!row) return null;
  const memoryId = impressionMemoryId(row.id);
  const previous = memoryControlFor(stateStore.snapshot(scopeKey), memoryId);
  if (action === 'restore' && !previous) return false;
  stateStore.apply(scopeKey, { type: 'memory-control-upserted', control: impressionControl(row, memoryId, previous, { memoryId, action }, at) });
  return true;
}
