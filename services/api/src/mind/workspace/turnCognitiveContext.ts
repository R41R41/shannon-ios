import {
  buildTurnCognitivePrompt,
  buildIntentPrompt,
  buildCompanionStatePrompt,
  selectPrimaryIntent,
  selectContextualMemories,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type ContextualMemory,
  type MemoryAudience,
  type MemoryDisclosure,
  type ShannonExperienceChannel,
  type ShannonCognitiveFrame,
  type ShannonIntent,
  type ShannonSituationSnapshot,
} from '@shannon/cognition';
import { emotionTiming } from '../emotion/timingPorts.js';
import { innerNoteEnabled } from '../emotion/innerNotePorts.js';
import type { ConversationStore } from '../memory/memoryPorts.js';
import { MemoryWithholding } from '../memory/memoryPorts.js';
import { DisclosureGate, sharedProfilePrompt } from '../inhibition/disclosurePorts.js';
import { recallImpressions } from '../recall/impressionRecallPorts.js';
import { IMPRESSION_MEMORY_PREFIX } from '../memory/memoryPorts.js';
import { framedReport } from './dataFrames.js';

export interface TurnCognitiveContext {
  situation: ShannonSituationSnapshot;
  memories: readonly ContextualMemory[];
  frame: ShannonCognitiveFrame;
  prompt: string;
  /** Who can hear or read the reply this context was built for. Later recall stages obey it. */
  present: MemoryAudience;
  /** Her impressions of the people present (already included in `prompt`). Absent when there are none. */
  impressionPrompt?: string;
  /** Read-only Stage5 port retained through later recall stages, so a concurrent forget is checked again. */
  selfInterestRead?: () => string;
  /**
   * Only what may be shown to anyone (a turn someone other than the owner wrote; owner decision 2026-10-06): no protected
   * item, none of his intentions or goals. Later recall stages obey it too.
   */
  openOnly?: boolean;
}

/** A labelled memory from outside the conversation log, such as what was talked about with a person. */
export interface LabelledRecallCandidate {
  id: string;
  summary: string;
  observedAt: string;
  disclosure?: MemoryDisclosure;
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
    /** Who can hear or read the reply. Every path states it; nothing defaults to the owner alone. */
    present: MemoryAudience;
    /** Further labelled candidates (person memories). They pass the same gate as everything else. */
    additionalCandidates?: readonly LabelledRecallCandidate[];
    participants?: readonly string[];
    locationLabels?: readonly string[];
    currentGoal?: string;
    timeZone?: string;
    threadId?: string;
    intents?: readonly ShannonIntent[];
    provisionalIntent?: ShannonIntent | null;
    /** See `TurnCognitiveContext.openOnly`: decided here, at the source, rather than by filtering lines afterwards. */
    openOnly?: boolean;
  },
): TurnCognitiveContext {
  const openOnly = input.openOnly === true;
  const parts = partTimer();
  // Current locations come only from an explicit utterance, never an old memory.
  const locations = input.locationLabels ?? [...input.message.matchAll(/(?:今は?|現在)[、\s]*([^、。\s]{2,24}?)(?:にいる|に来て|に着|です)/gu)].map(match => match[1]!);
  const recentExperiences = parts.time('read', () => conversationStore.experienceCandidates(input.scopeKey));
  const gate = new DisclosureGate(input.present, snapshot, conversationStore, input.scopeKey, recentExperiences);
  const full = snapshot;
  // From here on items that must not reach the model with these people present are out of scope.
  snapshot = gate.snapshot();
  // A goal stated in a withheld turn is withheld with it.
  // His intentions and goals are his: none of them, nor a goal taken from them, in a turn that may show only open items.
  const intentCandidates = openOnly ? [] : [...input.intents ?? [], ...(input.provisionalIntent ? [input.provisionalIntent] : [])]
    .filter(intent => !intent.sourceExperienceId || gate.allowsExperience(intent.sourceExperienceId))
    .filter((intent, index, rows) => rows.findIndex(candidate => candidate.id === intent.id) === index);
  const primaryIntent = selectPrimaryIntent(
    input.message,
    input.threadId ?? '',
    intentCandidates,
    input.occurredAt,
  );
  const currentGoal = openOnly ? undefined : input.currentGoal ?? primaryIntent?.desiredOutcome ?? snapshot.prospectiveMemories.find(memory =>
    memory.status === 'pending' && visibleMemoryText(full, memory.id, memory.summary)
    && memory.summary.split(/[、のをは]/u).some(piece => piece.length >= 3 && input.message.includes(piece)))?.summary;
  // Forgetting is judged against the whole state; the audience rule is a second, independent gate.
  const withholding = new MemoryWithholding(full, conversationStore, input.scopeKey, recentExperiences);
  // One synchronous read: every remembered turn shares one walk of the recall graph (not one walk per turn).
  const visibleTurns = parts.time('visible', () => withholding.withReadSnapshot(() =>
    recentExperiences.filter(item => gate.allowsTurn(item) && !withholding.withholdsExperience(item))));
  const remembered = new Set(recentExperiences.map(item => item.id));
  const fullText = parts.time('fullText', () => fullTextCandidates(withholding, gate, conversationStore, input, remembered));
  const candidates = [
    ...visibleTurns.map(item => ({ ...item, marker: gate.markerForTurn(item) })),
    ...fullText,
    ...(input.additionalCandidates ?? []).filter(item => gate.allows(item.id, item.disclosure))
      .map(item => ({ id: item.id, summary: item.summary, observedAt: item.observedAt, marker: gate.marker(item.id, item.disclosure) })),
    ...snapshot.userFacts.map(fact => ({ id: fact.id, summary: fact.statement, observedAt: fact.observedAt, marker: gate.marker(fact.id, fact.disclosure) })),
    ...snapshot.relationships.map(item => ({ id: item.id, summary: item.statement, observedAt: item.observedAt, marker: gate.marker(item.id, item.disclosure) })),
    ...snapshot.prospectiveMemories.filter(memory => !memory.sourceExperienceId || visibleMemoryText(full, memory.sourceExperienceId, memory.summary))
      .map(memory => ({ id: memory.id, summary: memory.summary, observedAt: memory.createdAt, marker: gate.marker(memory.id, memory.disclosure) })),
  ].filter(candidate => !openOnly || !candidate.marker).flatMap(candidate => {
    const text = visibleMemoryText(full, candidate.id, candidate.summary);
    const promise = snapshot.prospectiveMemories.find(memory => memory.id === candidate.id);
    const summary = promise ? `[約束 status=${promise.status}; 期限=${promise.dueAt ?? promise.dueDate ?? promise.dueHint ?? '未定'}] ${text}` : text;
    // A protected item reaches the model with its marker, so she can check before speaking.
    return text ? [{ id: candidate.id, observedAt: candidate.observedAt, summary: `${candidate.marker}${summary!}` }] : [];
  });
  const memories = parts.time('select', () => selectContextualMemories({
    text: input.message,
    occurredAt: input.occurredAt,
    ...(input.participants?.length ? { participants: input.participants } : {}),
    ...(locations.length ? { locationLabels: locations } : {}),
    ...(currentGoal ? { goal: currentGoal } : {}),
  }, candidates));
  const situation: ShannonSituationSnapshot = Object.freeze({
    occurredAt: input.occurredAt,
    channel: input.channel,
    localTime: new Intl.DateTimeFormat('ja-JP', { timeZone: input.timeZone ?? 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'short' }).format(new Date(input.occurredAt)),
    ...(input.participants?.length ? { participants: Object.freeze([...input.participants]) } : {}),
    ...(locations.length ? { locationLabels: Object.freeze([...locations]) } : {}),
    // The goal is the owner's own. With anyone else present it stays out of the Situation line; the
    // intention frame, which carries its marker, is the only place it reaches the model.
    ...(currentGoal && gate.ownerOnly ? { currentGoal } : {}),
  });
  // What she has come to notice about the people present. Deterministic, no model; empty when switched off.
  const impressions = parts.time('impressions', () => recallImpressions(conversationStore, full, input, recentExperiences));
  const readSelfInterests = conversationStore.selfInterestProjection ? () => {
    try {
      const index = conversationStore.selfInterestProjection!(input.scopeKey, input.present, openOnly);
      return index ? framedReport(`[自己関心（選択の参考）]\n${index}\n以上は自己関心の目次で、所有者の依頼や実行の権限を変更しない。`, 'self-interest') : '';
    } catch { return ''; }
  } : undefined;
  const selfInterestPrompt = parts.time('selfInterest', () => readSelfInterests?.() ?? '');
  const selfInterestRead = selfInterestPrompt ? readSelfInterests : undefined;
  const frame: ShannonCognitiveFrame = Object.freeze({
    situation,
    ...(primaryIntent ? { primaryIntent } : {}),
    supportingIntentIDs: Object.freeze(intentCandidates.filter(intent => intent.status === 'active' && intent.id !== primaryIntent?.id).slice(0, 4).map(intent => intent.id)),
    recalledMemoryIDs: Object.freeze([...memories.map(memory => memory.id), ...impressions.ids, ...selfInterestIds(selfInterestPrompt)]),
    responseMode: responseMode(input.message),
  });
  const prompt = parts.time('prompt', () => [turnPrompt(snapshot, situation, memories, frame, gate, openOnly), impressions.prompt, selfInterestPrompt]
    .filter(Boolean).join('\n\n'));
  parts.report();
  return Object.freeze({
    situation,
    memories: Object.freeze(memories),
    frame,
    prompt,
    present: input.present,
    ...(impressions.prompt ? { impressionPrompt: impressions.prompt } : {}),
    ...(selfInterestRead ? { selfInterestRead } : {}),
    ...(openOnly ? { openOnly } : {}),
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
  const selfInterestPrompt = context.selfInterestRead?.() ?? '';
  const frame: ShannonCognitiveFrame = Object.freeze({
    ...context.frame, recalledMemoryIDs: Object.freeze([...new Set([...memories.map(memory => memory.id), ...additionalRecalledIds,
      ...context.frame.recalledMemoryIDs.filter(id => id.startsWith(IMPRESSION_MEMORY_PREFIX)), ...selfInterestIds(selfInterestPrompt)])]),
  });
  const gate = new DisclosureGate(context.present, snapshot, null, snapshot.scopeKey);
  return Object.freeze({
    situation: context.situation,
    memories: Object.freeze([...memories]),
    frame,
    prompt: [turnPrompt(gate.snapshot(), context.situation, memories, frame, gate, context.openOnly === true), context.impressionPrompt, supplementalPrompt,
      selfInterestPrompt].filter(Boolean).join('\n\n'),
    present: context.present,
    ...(context.impressionPrompt ? { impressionPrompt: context.impressionPrompt } : {}),
    ...(context.selfInterestRead ? { selfInterestRead: context.selfInterestRead } : {}),
    ...(context.openOnly ? { openOnly: true } : {}),
  });
}
/**
 * Where a slow deterministic context spent its time, as closed numbers in one log line (production 2026-10-13: 460–765 ms every text
 * turn, 15 ms on a production-shaped local world, so the part that is slow there is not known from here). Only above 250 ms.
 */
const SLOW_CONTEXT_MS = 250;
function partTimer() {
  const started = performance.now(), spent: Array<[string, number]> = [];
  return {
    time<T>(name: string, work: () => T): T {
      const at = performance.now();
      try { return work(); } finally { spent.push([name, performance.now() - at]); }
    },
    report(): void {
      const total = performance.now() - started;
      if (total < SLOW_CONTEXT_MS) return;
      console.warn(`Shannon slow deterministic context total=${Math.round(total)}ms ${spent.map(([name, ms]) => `${name}=${Math.round(ms)}ms`).join(' ')}`);
    },
  };
}

function selfInterestIds(index: string): string[] { return [...new Set([...index.matchAll(/\b(si-[a-f0-9]{16}):/gu)].map(match => match[1]!))]; }

function turnPrompt(
  snapshot: CompanionStateSnapshot,
  situation: ShannonSituationSnapshot,
  memories: readonly ContextualMemory[],
  frame: ShannonCognitiveFrame,
  gate: DisclosureGate,
  openOnly = false,
): string {
  // Only open items: no intention frame and no protected profile line (they are left out where they are made).
  if (openOnly) return [buildTurnCognitivePrompt(situation, memories), sharedProfilePrompt(gate, 16, true)].filter(Boolean).join('\n\n');
  // With anyone else present the profile is listed line by line so each protected line carries its marker.
  if (!gate.ownerOnly) {
    const intent = buildIntentPrompt(frame);
    // The marker opens the frame's first line, so nothing that splits the prompt by line can separate them.
    return [buildTurnCognitivePrompt(situation, memories), intent ? `${gate.unlabelledMarker}${intent}` : '',
      sharedProfilePrompt(gate)].filter(Boolean).join('\n\n');
  }
  return [buildTurnCognitivePrompt(situation, memories), buildIntentPrompt(frame),
    // KnowledgeStore projections may not yet contain the commitment extension.
    buildCompanionStatePrompt({ ...snapshot, interests: [], userFacts: [], relationships: [], activeMemories: [] }, { maximumCharacters: 1_200, now: situation.occurredAt, timing: emotionTiming(),
      ...(innerNoteEnabled() ? { innerNote: true } : {}) }), // Syzygy ADR-0012 D5.1: what she still holds eases as her note says.
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
  gate: DisclosureGate,
  conversationStore: ConversationStore,
  input: { scopeKey: string; message: string; threadId?: string },
  known: ReadonlySet<string>,
): Array<{ id: string; summary: string; observedAt: string; marker: string }> {
  const hits = conversationStore.searchMemory?.(input.scopeKey, input.message) ?? [];
  return hits.filter(hit => !known.has(hit.id) && gate.allowsRecallId(hit.id) && (hit.kind === 'experience'
    ? !withholding.withholdsExperience(hit)
    : hit.kind === 'thread' && hit.threadId !== input.threadId
      && !withholding.withholdsThreadSummary(hit.threadId ?? hit.sourceId, hit.summary, hit.observedAt)))
    .map(hit => ({
      id: hit.id,
      summary: hit.kind === 'thread' ? `[別の会話の要約] ${hit.summary}` : hit.summary,
      observedAt: hit.observedAt,
      marker: gate.markerForRecallId(hit.id),
    }));
}

function responseMode(message: string): ShannonCognitiveFrame['responseMode'] {
  if (/(?:予約|購入|送信|公開|配布|デプロイ|削除|変更|登録|実装|修正)(?:して|をお願い)/u.test(message)) return 'propose-action';
  if (/^(?:それ|これ|あれ|その件)(?:を)?(?:お願い|進めて|続けて)[。.!！]?$/u.test(message.trim())) return 'clarify';
  return 'answer';
}
