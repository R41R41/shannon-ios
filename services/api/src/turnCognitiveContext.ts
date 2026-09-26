import {
  buildTurnCognitivePrompt,
  buildCompanionStatePrompt,
  selectContextualMemories,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type ContextualMemory,
  type ShannonExperienceChannel,
  type ShannonSituationSnapshot,
} from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';

export interface TurnCognitiveContext {
  situation: ShannonSituationSnapshot;
  memories: readonly ContextualMemory[];
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
  },
): TurnCognitiveContext {
  // Current locations come only from an explicit utterance, never an old memory.
  const locations = input.locationLabels ?? [...input.message.matchAll(/(?:今は?|現在)[、\s]*([^、。\s]{2,24}?)(?:にいる|に来て|に着|です)/gu)].map(match => match[1]!);
  const currentGoal = input.currentGoal ?? snapshot.prospectiveMemories.find(memory =>
    memory.status === 'pending' && visibleMemoryText(snapshot, memory.id, memory.summary)
    && memory.summary.split(/[、のをは]/u).some(piece => piece.length >= 3 && input.message.includes(piece)))?.summary;
  const candidates = [
    ...conversationStore.experienceCandidates(input.scopeKey),
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
  return Object.freeze({
    situation,
    memories: Object.freeze(memories),
    prompt: [buildTurnCognitivePrompt(situation, memories),
      // KnowledgeStore projections may not yet contain the commitment extension.
      buildCompanionStatePrompt({ ...snapshot, interests: [], userFacts: [], relationships: [], activeMemories: [] }, { maximumCharacters: 1_200 }),
    ].join('\n\n'),
  });
}
