import {
  buildTurnCognitivePrompt,
  buildIntentPrompt,
  buildCompanionStatePrompt,
  selectPrimaryIntent,
  selectContextualMemories,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type ContextualMemory,
  type ShannonExperienceChannel,
  type ShannonCognitiveFrame,
  type ShannonIntent,
  type ShannonSituationSnapshot,
} from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';
import { MemoryWithholding } from './memoryVisibility.js';

export interface TurnCognitiveContext {
  situation: ShannonSituationSnapshot;
  memories: readonly ContextualMemory[];
  frame: ShannonCognitiveFrame;
  prompt: string;
}

/**
 * Builds the fresh, read-only cognition slice that must exist before an answer
 * is generated. Durable refinement still runs later and never blocks this path.
 */
export function prepareTurnCognitiveContext(
  snapshot: CompanionStateSnapshot,
  conversationStore: ConversationStore,
  input: {
    scopeKey: string;
    message: string;
    occurredAt: string;
    channel: ShannonExperienceChannel;
    participants?: readonly string[];
    locationLabels?: readonly string[];
    currentGoal?: string;
    timeZone?: string;
    threadId?: string;
    intents?: readonly ShannonIntent[];
    provisionalIntent?: ShannonIntent | null;
  },
): TurnCognitiveContext {
  // Current locations come only from an explicit utterance, never an old memory.
  const locations = input.locationLabels ?? [...input.message.matchAll(/(?:今は?|現在)[、\s]*([^、。\s]{2,24}?)(?:にいる|に来て|に着|です)/gu)].map(match => match[1]!);
  const intentCandidates = [...input.intents ?? [], ...(input.provisionalIntent ? [input.provisionalIntent] : [])]
    .filter((intent, index, rows) => rows.findIndex(candidate => candidate.id === intent.id) === index);
  const primaryIntent = selectPrimaryIntent(
    input.message,
    input.threadId ?? '',
    intentCandidates,
    input.occurredAt,
  );
  const currentGoal = input.currentGoal ?? primaryIntent?.desiredOutcome ?? snapshot.prospectiveMemories.find(memory =>
    memory.status === 'pending' && visibleMemoryText(snapshot, memory.id, memory.summary)
    && memory.summary.split(/[、のをは]/u).some(piece => piece.length >= 3 && input.message.includes(piece)))?.summary;
  const recentExperiences = conversationStore.experienceCandidates(input.scopeKey);
  const withholding = new MemoryWithholding(snapshot, conversationStore, input.scopeKey, recentExperiences);
  const candidates = [
    ...recentExperiences.filter(item => !withholding.withholdsExperience(item)),
    ...fullTextCandidates(withholding, conversationStore, input, new Set(recentExperiences.map(item => item.id))),
    ...snapshot.userFacts.map(fact => ({ id: fact.id, summary: fact.statement, observedAt: fact.observedAt })),
    ...snapshot.relationships.map(item => ({ id: item.id, summary: item.statement, observedAt: item.observedAt })),
    ...snapshot.prospectiveMemories.filter(memory => !memory.sourceExperienceId || visibleMemoryText(snapshot, memory.sourceExperienceId, memory.summary))
      .map(memory => ({ id: memory.id, summary: memory.summary, observedAt: memory.createdAt })),
  ].flatMap(candidate => {
    const text = visibleMemoryText(snapshot, candidate.id, candidate.summary);
    const promise = snapshot.prospectiveMemories.find(memory => memory.id === candidate.id);
    const summary = promise ? `[約束 status=${promise.status}; 期限=${promise.dueAt ?? promise.dueDate ?? promise.dueHint ?? '未定'}] ${text}` : text;
    return text ? [{ ...candidate, summary: summary! }] : [];
  });
  const memories = selectContextualMemories({
    text: input.message,
    occurredAt: input.occurredAt,
    ...(input.participants?.length ? { participants: input.participants } : {}),
    ...(locations.length ? { locationLabels: locations } : {}),
    ...(currentGoal ? { goal: currentGoal } : {}),
  }, candidates);
  const situation: ShannonSituationSnapshot = Object.freeze({
    occurredAt: input.occurredAt,
    channel: input.channel,
    localTime: new Intl.DateTimeFormat('ja-JP', { timeZone: input.timeZone ?? 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'short' }).format(new Date(input.occurredAt)),
    ...(input.participants?.length ? { participants: Object.freeze([...input.participants]) } : {}),
    ...(locations.length ? { locationLabels: Object.freeze([...locations]) } : {}),
    ...(currentGoal ? { currentGoal } : {}),
  });
  const frame: ShannonCognitiveFrame = Object.freeze({
    situation,
    ...(primaryIntent ? { primaryIntent } : {}),
    supportingIntentIDs: Object.freeze(intentCandidates.filter(intent => intent.status === 'active' && intent.id !== primaryIntent?.id).slice(0, 4).map(intent => intent.id)),
    recalledMemoryIDs: Object.freeze(memories.map(memory => memory.id)),
    responseMode: responseMode(input.message),
  });
  return Object.freeze({
    situation,
    memories: Object.freeze(memories),
    frame,
    prompt: turnPrompt(snapshot, situation, memories, frame),
  });
}

/** Rebuilds the read-only turn slice after a later recall stage added candidates. */
export function withRecalledMemories(
  context: TurnCognitiveContext,
  snapshot: CompanionStateSnapshot,
  memories: readonly ContextualMemory[],
  supplementalPrompt = '',
  additionalRecalledIds: readonly string[] = [],
): TurnCognitiveContext {
  const frame: ShannonCognitiveFrame = Object.freeze({
    ...context.frame, recalledMemoryIDs: Object.freeze([...new Set([...memories.map(memory => memory.id), ...additionalRecalledIds])]),
  });
  return Object.freeze({
    situation: context.situation,
    memories: Object.freeze([...memories]),
    frame,
    prompt: [turnPrompt(snapshot, context.situation, memories, frame), supplementalPrompt].filter(Boolean).join('\n\n'),
  });
}

function turnPrompt(
  snapshot: CompanionStateSnapshot,
  situation: ShannonSituationSnapshot,
  memories: readonly ContextualMemory[],
  frame: ShannonCognitiveFrame,
): string {
  return [buildTurnCognitivePrompt(situation, memories), buildIntentPrompt(frame),
    // KnowledgeStore projections may not yet contain the commitment extension.
    buildCompanionStatePrompt({ ...snapshot, interests: [], userFacts: [], relationships: [], activeMemories: [] }, { maximumCharacters: 1_200 }),
  ].join('\n\n');
}

/**
 * Deterministic FTS recall over the whole experience log and other threads'
 * rolling summaries. It is read-only and calls no model. An experience whose
 * reply used a forgotten item, and a summary built from a withheld turn, are
 * dropped; unrelated ones stay.
 */
function fullTextCandidates(
  withholding: MemoryWithholding,
  conversationStore: ConversationStore,
  input: { scopeKey: string; message: string; threadId?: string },
  known: ReadonlySet<string>,
): Array<{ id: string; summary: string; observedAt: string }> {
  const hits = conversationStore.searchMemory?.(input.scopeKey, input.message) ?? [];
  return hits.filter(hit => !known.has(hit.id) && (hit.kind === 'experience'
    ? !withholding.withholdsExperience(hit)
    : hit.kind === 'thread' && hit.threadId !== input.threadId
      && !withholding.withholdsThreadSummary(hit.threadId ?? hit.sourceId, hit.summary, hit.observedAt)))
    .map(hit => ({
      id: hit.id,
      summary: hit.kind === 'thread' ? `[別の会話の要約] ${hit.summary}` : hit.summary,
      observedAt: hit.observedAt,
    }));
}

function responseMode(message: string): ShannonCognitiveFrame['responseMode'] {
  if (/(?:予約|購入|送信|公開|配布|デプロイ|削除|変更|登録|実装|修正)(?:して|をお願い)/u.test(message)) return 'propose-action';
  if (/^(?:それ|これ|あれ|その件)(?:を)?(?:お願い|進めて|続けて)[。.!！]?$/u.test(message.trim())) return 'clarify';
  return 'answer';
}
