import {
  isMemoryEvidenceVisible,
  memoryControlFor,
  memoryWithholdingRules,
  ruleWithholdsText,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type MemoryAudience,
  type MemoryWithholdingRule,
  type ShannonKnowledgeDocument,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience, StoredConversationMessage } from './conversationStore.js';
import type { ShannonConversationItem } from './chatModel.js';
import { DisclosureGate } from './memoryDisclosure.js';

/** A Shannon reply (or the Shannon side of an experience summary) as the withholding rule sees it. */
export interface WithholdableReply {
  experienceId?: string;
  text: string;
  observedAt: string;
  /** IDs recalled into the prompt of this turn. Absent on turns recorded before provenance existed. */
  recalledMemoryIds?: readonly string[];
}

/**
 * What the owner's forgotten, rejected and corrected memories withhold from
 * model context. Nothing is deleted and nothing is stored: every answer is
 * derived from the current controls, so restoring an item lifts exactly what
 * it withheld.
 *
 * A reply is withheld when
 * - its turn is the source of a withheld item (or quotes that item's evidence),
 * - its prompt recalled a withheld item (recorded provenance), or
 * - it was written no later than the item stopped being usable and restates
 *   the item's key terms. An item with no decidable key term withholds every
 *   earlier reply instead.
 */
export class MemoryWithholding {
  readonly rules: readonly MemoryWithholdingRule[];
  private hiddenExperiences?: readonly ShannonExperience[];
  private knowledgeDocuments?: ReadonlyMap<string, ShannonKnowledgeDocument>;
  private readonly experiences = new Map<string, ShannonExperience | null>();
  private readonly summaryDecisions = new Map<string, boolean>();

  constructor(
    private readonly state: CompanionStateSnapshot,
    private readonly store: ConversationStore | null,
    private readonly scopeKey: string,
    private candidates?: readonly ShannonExperience[],
  ) {
    this.rules = memoryWithholdingRules(state);
  }

  /** True when no forgotten, rejected or corrected item exists: nothing can be withheld. */
  get inactive(): boolean { return this.rules.length === 0; }

  /** Experiences that are the source of a withheld item or quote its evidence. */
  private hidden(): readonly ShannonExperience[] {
    this.hiddenExperiences ??= this.inactive || !this.store ? [] : (this.candidates ??= this.store.experienceCandidates(this.scopeKey))
      .filter(item => !visibleMemoryText(this.state, item.id, item.summary) || !isMemoryEvidenceVisible(this.state, item.userMessage));
    return this.hiddenExperiences;
  }

  /** A recalled ID that is itself withheld: the reply was generated from the withheld content. */
  private recalledWithheld(id: string, observedAt: string): boolean {
    if (id.startsWith('thread:')) return false;
    if (id.startsWith('knowledge:')) {
      const document = this.knowledge().get(id.slice('knowledge:'.length));
      return Boolean(document?.sourceExperienceIds.some(source => this.recalledWithheld(source, observedAt)));
    }
    const blocked = (memoryId: string | undefined) => {
      const control = memoryId ? memoryControlFor(this.state, memoryId) : undefined;
      if (!control) return false;
      // A corrected item is the corrected text after its boundary; only earlier turns saw the original.
      return control.status !== 'active' || Boolean(control.overrideText && observedAt <= (control.contextInvalidatedAt ?? control.updatedAt));
    };
    if (blocked(id) || this.hidden().some(item => item.id === id)) return true;
    const derived = this.state.userFacts.find(item => item.id === id) ?? this.state.relationships.find(item => item.id === id)
      ?? this.state.prospectiveMemories.find(item => item.id === id);
    return Boolean(derived && (blocked(derived.sourceExperienceId)
      || (derived.evidence && !isMemoryEvidenceVisible(this.state, derived.evidence))));
  }

  private knowledge(): ReadonlyMap<string, ShannonKnowledgeDocument> {
    const source = this.store as (ConversationStore & { listShannonKnowledge?: (scopeKey: string, options?: { includeRetired?: boolean }) => readonly ShannonKnowledgeDocument[] }) | null;
    this.knowledgeDocuments ??= new Map((source?.listShannonKnowledge?.(this.scopeKey, { includeRetired: true }) ?? []).map(document => [document.id, document]));
    return this.knowledgeDocuments;
  }

  private experience(id: string): ShannonExperience | null {
    if (!this.experiences.has(id)) this.experiences.set(id, this.store?.experiencesById?.(this.scopeKey, [id])[0] ?? null);
    return this.experiences.get(id) ?? null;
  }

  private recalledFor(reply: WithholdableReply): readonly string[] | undefined {
    return reply.recalledMemoryIds ?? (reply.experienceId ? this.experience(reply.experienceId)?.recalledMemoryIds : undefined);
  }

  withholdsReply(reply: WithholdableReply): boolean {
    if (this.inactive) return false;
    if (this.rules.some(rule => ruleWithholdsText(rule, reply.text, reply.observedAt))) return true;
    return Boolean(this.recalledFor(reply)?.some(id => this.recalledWithheld(id, reply.observedAt)));
  }

  /** A stored message that must not be re-fed to a model. The transcript itself stays intact. */
  withholdsMessage(message: StoredConversationMessage): boolean {
    if (this.inactive) return false;
    if (!isMemoryEvidenceVisible(this.state, message.content)) return true;
    if (this.hidden().some(item => message.sourceExperienceId === item.id
      || message.content === item.userMessage || message.content === item.shannonReply)) return true;
    return message.role === 'assistant' && this.withholdsReply({
      text: message.content, observedAt: message.observedAt,
      ...(message.recalledMemoryIds ? { recalledMemoryIds: message.recalledMemoryIds } : {}),
    });
  }

  /** An experience summary as a recall, search or embedding candidate. Only its Shannon side is matched by term. */
  withholdsExperience(experience: { id: string; summary: string; observedAt?: string; recalledMemoryIds?: readonly string[] }): boolean {
    if (this.inactive) return false;
    if (visibleMemoryText(this.state, experience.id, experience.summary) === null) return true;
    const reply = experience.summary.split(' / シャノン: ');
    return this.withholdsReply({
      experienceId: experience.id, text: reply.length > 1 ? reply.slice(1).join(' ') : experience.summary,
      // An unknown time is treated as earlier than every boundary.
      observedAt: experience.observedAt ?? this.experience(experience.id)?.observedAt ?? '',
      ...(experience.recalledMemoryIds ? { recalledMemoryIds: experience.recalledMemoryIds } : {}),
    });
  }

  /**
   * A rolling summary has no span-level provenance, so it is judged by the
   * turns it was built from. It is withheld when its text restates a withheld
   * item, or when its chain started before an item stopped being usable and
   * the thread contains a turn that item withholds. The next turn of that
   * thread writes a fresh summary from visible history only.
   */
  withholdsThreadSummary(threadId: string, text?: string, observedAt?: string): boolean {
    if (this.inactive) return false;
    const lineage = this.store?.threadSummaryLineage?.(this.scopeKey, threadId);
    if (!lineage) return true;
    const cached = this.summaryDecisions.get(threadId);
    const summaryAt = observedAt ?? lineage.updatedAt ?? '';
    const restated = Boolean(text && this.rules.some(rule => !rule.wide && ruleWithholdsText(rule, text, summaryAt)));
    if (restated || cached !== undefined) return restated || cached === true;
    const started = lineage.chainStartedAt;
    const relevant = new Set(this.rules.filter(rule => !started || rule.boundary >= started).map(rule => rule.memoryId));
    const scoped = relevant.size === this.rules.length ? this : relevant.size === 0 ? null : new MemoryWithholding(
      { ...this.state, memoryControls: this.state.memoryControls.filter(control => relevant.has(control.memoryId)) },
      this.store, this.scopeKey, this.candidates ??= this.store?.experienceCandidates(this.scopeKey));
    const tainted = Boolean(scoped && lineage.messages.some(message => scoped.withholdsMessage(message)));
    this.summaryDecisions.set(threadId, tainted);
    return tainted;
  }

  /** The stored rolling summary of a thread when it may be given to a model. */
  usableThreadSummary(threadId: string): string | undefined {
    if (!this.store || this.withholdsThreadSummary(threadId)) return undefined;
    const summary = this.store.threadSummary(this.scopeKey, threadId);
    return summary && !this.withholdsThreadSummary(threadId, summary) ? summary : undefined;
  }

  /** Shannon knowledge derived from a withheld turn, or restating a withheld item, is not used. */
  withholdsKnowledge(document: ShannonKnowledgeDocument): boolean {
    if (this.inactive) return false;
    if (this.rules.some(rule => !rule.wide && ruleWithholdsText(rule, `${document.title}\n${document.bodyMarkdown}`, document.updatedAt))) return true;
    return document.sourceExperienceIds.some(id => {
      const experience = this.experience(id);
      return experience ? this.withholdsExperience(experience) || !isMemoryEvidenceVisible(this.state, experience.userMessage) : false;
    });
  }
}

/** The stores used in production implement the conversation store as well; a bare index does not. */
export function conversationStoreOf(value: unknown): ConversationStore | null {
  const candidate = value as Partial<ConversationStore> | null;
  return candidate && typeof candidate.experienceCandidates === 'function' && typeof candidate.conversationHistory === 'function'
    && typeof candidate.threadSummary === 'function' ? candidate as ConversationStore : null;
}

/**
 * Keep the durable transcript intact, but don't re-feed forgotten evidence, and with
 * anyone else present re-feed only the turns they may hear.
 */
export function visibleConversationHistory(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadID: string,
  present: MemoryAudience,
): readonly ShannonConversationItem[] {
  const count = store.history(scopeKey, threadID).length;
  if (!count) return [];
  const withholding = new MemoryWithholding(state, store, scopeKey);
  const gate = new DisclosureGate(present, state, store, scopeKey);
  return store.conversationHistory(scopeKey, threadID).slice(-count)
    .filter(message => gate.allowsMessage(message) && !withholding.withholdsMessage(message))
    // A protected turn is replayed with its marker so she can check before repeating it aloud.
    .map(message => ({ role: message.role, content: message.role === 'user' ? `${gate.markerForMessage(message)}${message.content}` : message.content }));
}

/**
 * The prior summary of a thread for the model, or nothing when it was built from a withheld
 * turn. Only text chat, which is the owner alone, uses it; `present` is stated so a future
 * caller has to decide.
 */
export function usableThreadSummary(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string,
  present: MemoryAudience,
): string | undefined {
  const summary = new MemoryWithholding(state, store, scopeKey).usableThreadSummary(threadId);
  const marker = new DisclosureGate(present, state, store, scopeKey).unlabelledMarker;
  return summary && marker ? `${marker}${summary}` : summary;
}

export function isForgottenCommitmentEvidence(state: CompanionStateSnapshot, evidence: string): boolean {
  return !isMemoryEvidenceVisible(state, evidence);
}
