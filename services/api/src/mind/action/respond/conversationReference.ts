import { isOwnerOnly, ownerSpoke, visibleMemoryText, type CompanionStateSnapshot } from '@shannon/cognition';
import type { ConversationStore, StoredConversationMessage } from '../../memory/store/conversationStore.js';

const REFERENCE_NOUN_SOURCE = '(?:話|内容|会話|発言|件|計画|予定|作業|タスク|アイデア|案)';
const REFERENCE_SOURCE = `(?:これ|それ|あれ|(?:この|その)${REFERENCE_NOUN_SOURCE}|(?:さっき|今|直前|先ほど|先程|前|昨日|先日|この前)の${REFERENCE_NOUN_SOURCE}|(?:さっき|今|先ほど|先程)(?:話した|言った)(?:こと|内容|やつ))`;
const BARE_REFERENCE = new RegExp(`^${REFERENCE_SOURCE}(?:のこと)?$`, 'u');
const REFERENCE_START = new RegExp(`^${REFERENCE_SOURCE}(?:$|を|について|の)`, 'u');
const REFERENCE_WITHIN = new RegExp(`${REFERENCE_SOURCE}(?:$|を|について|の)`, 'u');

export function isBareConversationReference(value: string): boolean {
  return BARE_REFERENCE.test(value.trim().replace(/[「」"。！!]/gu, ''));
}

export function hasUnresolvedConversationReference(value: string): boolean {
  return REFERENCE_START.test(value.trim().replace(/^[「"]/u, ''));
}

export function containsUnresolvedConversationReference(value: string): boolean {
  return REFERENCE_WITHIN.test(value.trim());
}

export type ResolvedConversationContent =
  | { content: string; sourceMessageIds: string[]; sourceExperienceId?: string; referenced: boolean }
  | { clarification: string };

/** Resolve only the immediately preceding, visible owner statement in this
 * thread. Never reinterpret assistant output as the owner's fact or silently
 * search other conversations. A missing/ambiguous referent requires a quote. */
export function resolveConversationContent(
  value: string, scopeKey: string, threadId: string, at: string,
  state: CompanionStateSnapshot, store: ConversationStore,
  maximumCharacters: number,
  purpose: 'note' | 'task' | 'memory' = 'note',
): ResolvedConversationContent {
  const content = value.trim();
  if (!containsUnresolvedConversationReference(content)) {
    return { content, sourceMessageIds: [], referenced: false };
  }
  const clarify = { clarification: 'どの内容を残すか、保存したい部分をそのまま教えてもらえますか？ この依頼では、新しい保存や変更はしていません。' };
  if (!isBareConversationReference(content) || /^(?:昨日|先日|この前)/u.test(content)) return clarify;
  const recent = store.conversationHistory(scopeKey, threadId).slice(-8);
  const source = recent.filter(message => message.role === 'user').at(-1);
  if (!source) return clarify;
  const text = source.content.trim();
  if (!keepableStatement(text, maximumCharacters)) return clarify;
  if (purpose === 'task' && (
    text.split(/[。！？!?\n]/u).filter(part => part.trim()).length > 1
    || /(?:または|もしくは|キャンセル|取り消|やめた|やめる|中止|不要|しない|できない|完了した|終わった|済んだ)/u.test(text)
  )) return clarify;
  const sourceExperienceId = boundOwnerTurn(source, scopeKey, threadId, at, state, store);
  if (!sourceExperienceId) return clarify;
  return { content: text, sourceMessageIds: [source.id], sourceExperienceId, referenced: true };
}

/** Text that can be kept as the owner's statement: not a question, a request, an open reference or an acknowledgement. */
export function keepableStatement(text: string, maximumCharacters: number): boolean {
  return !(text.length > maximumCharacters || text.length < 3 || hasUnresolvedConversationReference(text)
    || /[?？]|(?:教えて|調べて|どう思う|どちら|どっち|どこ|何を|何が|例えば|もし|仮に)/u.test(text)
    || /(?:タスクにして|タスクに追加して|(?:ノート|メモ|Aether|エーテル|ノートアプリ)に(?:して|残して|保存して)|メモして|覚えておいて|忘れないで|リマインドして)(?:ね|ください)?[。！!]?$/u.test(text)
    || /^(?:はい|うん|そう|ありがとう|了解|お願いします)[。！!]?$/u.test(text));
}

/**
 * The experience id of a stored owner message, bound to its exact turn and still visible, from the last fifteen minutes;
 * null otherwise. References are intentionally local in time. With `ownerAlone`, also a turn of the owner alone, in his words.
 */
export function boundOwnerTurn(
  source: StoredConversationMessage, scopeKey: string, threadId: string, at: string,
  state: CompanionStateSnapshot, store: ConversationStore, ownerAlone = false,
): string | null {
  const age = Date.parse(at) - Date.parse(source.observedAt);
  if (source.role !== 'user' || !Number.isFinite(age) || age < 0 || age > 15 * 60_000) return null;
  // Message IDs are bound to their exact stored turn; text/time matching alone
  // could select an identical sentence from a different conversation.
  if (!source.sourceExperienceId) return null;
  const text = source.content.trim();
  const sources = store.experienceCandidates(scopeKey, threadId).filter(experience =>
    experience.id === source.sourceExperienceId
    && experience.observedAt === source.observedAt && experience.userMessage.trim() === text);
  const experience = sources.length === 1 ? sources[0]! : null;
  if (!experience || !visibleMemoryText(state, experience.id, text)) return null;
  if (ownerAlone && !(isOwnerOnly(experience.disclosure?.audience) && ownerSpoke(experience.disclosure))) return null;
  return experience.id;
}

export function contentPreview(content: string): string {
  const oneLine = content.replace(/\s+/gu, ' ').trim();
  return oneLine.length > 64 ? `${oneLine.slice(0, 63)}…` : oneLine;
}
