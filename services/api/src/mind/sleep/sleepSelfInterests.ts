import { disclosureFor, type SelfInterest, type SelfInterestProposal } from '@shannon/cognition';
import type { DailyUserMessage } from './store/backgroundJobStore.js';

export const SELF_INTEREST_SLEEP_INSTRUCTIONS = `
自己関心selfInterestsは、シャノン自身が追いたい題材の部分変更案。ユーザーについてのinterestsとは別。
提示した現在の自己関心だけをpatch/removeできる。人格・本能・目的・報酬の式を変更しない。
addは最大2、removeは最大2。既存項目のweight変更は夜の開始から±0.1以内、新規は0.5。
固定・禁止・忘却・自動更新停止の項目は変更しない。全体を書き直さない。
各案のevidenceは今回の入力に完全一致するユーザー発言。過去の自己関心の理由や睡眠の出力を根拠にしない。
不確かな案は出さず空にする。`;
export const SELF_INTEREST_SLEEP_SCHEMA = {
  type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['add', 'patch', 'remove'] }, itemId: { type: ['string', 'null'], maxLength: 120 },
    title: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 600 }, reason: { type: 'string', maxLength: 240 },
    weight: { type: 'number', minimum: 0, maximum: 1 }, evidence: { type: 'string', maxLength: 240 },
  }, required: ['kind', 'itemId', 'title', 'description', 'reason', 'weight', 'evidence'] },
};
export interface SleepSelfInterestDraft {
  proposal: Omit<SelfInterestProposal, 'candidateId'>;
  evidence: string;
}
/** Reject fabricated IDs/quotes before they can become candidates. Canonical evidence is rechecked by the writer. */
export function parseSleepSelfInterests(value: unknown, messages: readonly DailyUserMessage[], current: readonly SelfInterest[]): SleepSelfInterestDraft[] {
  if (!Array.isArray(value) || value.length > 6) return [];
  return value.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    if (!['add', 'patch', 'remove'].includes(String(row.kind)) || typeof row.title !== 'string' || typeof row.evidence !== 'string'
      || typeof row.reason !== 'string' || typeof row.description !== 'string' || typeof row.weight !== 'number') return [];
    const originals = messages.filter(message => message.sourceExperienceId && message.content.includes(row.evidence as string));
    if (!row.evidence.trim() || !originals.length) return [];
    const before = typeof row.itemId === 'string' ? current.find(item => item.id === row.itemId) : undefined;
    if (row.kind !== 'add' && (!before || row.title !== before.title)) return [];
    return [{ evidence: row.evidence, proposal: { kind: row.kind as SelfInterestProposal['kind'], title: row.title,
      description: row.description, weight: row.weight, reason: row.reason, disclosure: disclosureFor(`${row.title}\n${row.description}\n${row.reason}`),
      evidenceRefs: [...new Set(originals.map(message => message.sourceExperienceId!))],
      ...(before ? { itemId: before.id, expectedRevision: before.revision, ownerGeneration: before.ownerGeneration } : {}) } }];
  });
}
