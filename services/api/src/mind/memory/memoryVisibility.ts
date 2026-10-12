import { renderedCompaction } from '@shannon/mind';
import {
  OWNER_AUDIENCE,
  isMemoryEvidenceVisible,
  isOwnerOnly,
  memoryControlFor,
  memoryWithholdingRules,
  ruleWithholdsText,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type MemoryAudience,
  type MemoryWithholdingRule,
  type ShannonKnowledgeDocument,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience, StoredConversationMessage } from './store/conversationStore.js';
import type { ShannonConversationItem } from '../../infra/models/chatModel.js';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';

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
  private readonly recalledDecisions = new Map<string, boolean>();
  /** The part of a recalled id's verdict that does not depend on the time of the reply that recalled it (one walk per id). */
  private readonly provenanceDecisions = new Map<string, boolean>();
  private readonly readDecisions = new Map<string, boolean>();
  private externalReadsPossible = true;
  private queryDepth = 0;
  /** Memoize overlapping provenance only within one synchronous read; the next use rechecks native availability. */
  private query<T>(work: () => T): T {
    if (this.queryDepth === 0) {
      this.recalledDecisions.clear(); this.provenanceDecisions.clear(); this.readDecisions.clear();
      this.externalReadsPossible = this.store?.hasReadSourceProvenance?.(this.scopeKey) !== false;
    }
    this.queryDepth += 1;
    try { return work(); } finally { this.queryDepth -= 1; }
  }


  /** Related synchronous checks share one graph walk; a subsequent read starts fresh. */
  withReadSnapshot<T>(work: () => T, preloaded: readonly ShannonExperience[] = []): T {
    for (const row of preloaded) this.experiences.set(row.id, row);
    return this.query(work);
  }

  constructor(
    private readonly state: CompanionStateSnapshot,
    private readonly store: ConversationStore | null,
    private readonly scopeKey: string,
    private candidates?: readonly ShannonExperience[],
    private readonly readSourceVisible = store?.readSourceVisible?.bind(store),
    /** The withheld turns among `candidates` under this same `state`, when a caller already derived them (`withheldExperiences`). */
    withheld?: readonly ShannonExperience[],
  ) {
    this.rules = memoryWithholdingRules(state);
    for (const candidate of candidates ?? []) this.experiences.set(candidate.id, candidate);
    if (withheld && candidates) this.hiddenExperiences = withheld;
  }

  /** The turns this state withholds among the candidates (derived once; a caller with the same state and candidates may pass it on). */
  withheldExperiences(): readonly ShannonExperience[] { return this.hidden(); }

  /** True when no forgotten, rejected or corrected item exists: nothing can be withheld. */
  get inactive(): boolean { return this.rules.length === 0; }

  /** Experiences that are the source of a withheld item or quote its evidence. */
  private hidden(): readonly ShannonExperience[] {
    this.hiddenExperiences ??= this.inactive || !this.store ? [] : (this.candidates ??= this.store.experienceCandidates(this.scopeKey))
      .filter(item => !visibleMemoryText(this.state, item.id, item.summary) || !isMemoryEvidenceVisible(this.state, item.userMessage));
    return this.hiddenExperiences;
  }

  /** A recalled ID that is itself withheld: the reply was generated from the withheld content. */
  private recalledWithheld(id: string, observedAt: string, seen = new Set<string>()): boolean {
    if (seen.has(id) || seen.size >= 5000) return true;
    const key = JSON.stringify([id, observedAt]), known = this.recalledDecisions.get(key);
    if (known !== undefined) return known;
    seen.add(id);
    try {
      const result = this.computeRecalled(id, observedAt, seen); this.recalledDecisions.set(key, result); return result;
    } finally { seen.delete(id); }
  }
  private computeRecalled(id: string, observedAt: string, seen: Set<string>): boolean {
    if (id.startsWith('thread:')) return false;
    if (id.startsWith('knowledge:')) {
      const document = this.knowledge().get(id.slice('knowledge:'.length));
      return Boolean(document?.sourceExperienceIds.some(source => this.recalledWithheld(source, observedAt, seen)));
    }
    const blocked = (memoryId: string | undefined) => {
      const control = memoryId ? memoryControlFor(this.state, memoryId) : undefined;
      if (!control) return false;
      // A corrected item is the corrected text after its boundary; only earlier turns saw the original.
      return control.status !== 'active' || Boolean(control.overrideText && observedAt <= (control.contextInvalidatedAt ?? control.updatedAt));
    };
    if (blocked(id)) return true;
    const control = memoryControlFor(this.state, id);
    if (control?.status === 'active' && control.overrideText && observedAt > (control.contextInvalidatedAt ?? control.updatedAt)) return false;
    if (this.provenanceWithheld(id, seen)) return true;
    const derived = this.state.userFacts.find(item => item.id === id) ?? this.state.relationships.find(item => item.id === id)
      ?? this.state.prospectiveMemories.find(item => item.id === id);
    return Boolean(derived && (blocked(derived.sourceExperienceId)
      || (derived.evidence && !isMemoryEvidenceVisible(this.state, derived.evidence))));
  }

  /**
   * Withheld by what the remembered turn itself is, read or recalled: judged at the turn's own time, so it is the same for every
   * reply that recalled it. 2026-10-13: keyed by the recalling reply's time, one research step walked the recall graph for 10 s.
   */
  private provenanceWithheld(id: string, seen: Set<string>): boolean {
    const known = this.provenanceDecisions.get(id);
    if (known !== undefined) return known;
    const result = this.computeProvenance(id, seen);
    this.provenanceDecisions.set(id, result);
    return result;
  }
  private computeProvenance(id: string, seen: Set<string>): boolean {
    if (this.hidden().some(item => item.id === id)) return true;
    const experience = this.experience(id);
    if (experience?.readSourceIds?.some(source => !this.readSourceVisible?.(this.scopeKey, source, experience.observedAt))) return true;
    return Boolean(experience?.recalledMemoryIds?.some(source => this.recalledWithheld(source, experience.observedAt, seen)));
  }

  /** Source availability is independent of memory-control rules and must survive derived summaries. */
  private unavailableRead(id: string, seen = new Set<string>()): boolean {
    if (!this.externalReadsPossible) return false;
    if (seen.has(id) || seen.size >= 5000) return true;
    const known = this.readDecisions.get(id); if (known !== undefined) return known;
    seen.add(id);
    try {
      const experience = id.startsWith('knowledge:') ? null : this.experience(id);
      const result = id.startsWith('knowledge:')
        ? Boolean(this.knowledge().get(id.slice(10))?.sourceExperienceIds.some(ref => this.unavailableRead(ref, seen)))
        : Boolean(experience && ((experience.readSourceIds ?? []).some(ref => !this.readSourceVisible?.(this.scopeKey, ref, experience.observedAt))
          || (experience.recalledMemoryIds ?? []).some(ref => this.unavailableRead(ref, seen))));
      this.readDecisions.set(id, result); return result;
    } finally { seen.delete(id); }
  }
  private messageReadUnavailable(message: StoredConversationMessage): boolean {
    return Boolean((message.sourceExperienceId && this.unavailableRead(message.sourceExperienceId))
      || message.recalledMemoryIds?.some(id => this.unavailableRead(id)));
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

  private primeMessages(messages: readonly StoredConversationMessage[]): void {
    const missing = messageExperienceIds(messages).filter(id => !this.experiences.has(id));
    for (const id of missing) this.experiences.set(id, null);
    for (const row of experienceRows(this.store, this.scopeKey, missing)) this.experiences.set(row.id, row);
  }

  private recalledFor(reply: WithholdableReply): readonly string[] | undefined {
    return reply.recalledMemoryIds ?? (reply.experienceId ? this.experience(reply.experienceId)?.recalledMemoryIds : undefined);
  }

  withholdsReply(reply: WithholdableReply): boolean { return this.query(() => this.replyWithheld(reply)); }
  private replyWithheld(reply: WithholdableReply): boolean {
    if (this.inactive && !this.externalReadsPossible) return false;
    if (this.rules.some(rule => ruleWithholdsText(rule, reply.text, reply.observedAt))) return true;
    return Boolean(this.recalledFor(reply)?.some(id => this.recalledWithheld(id, reply.observedAt)));
  }

  /** A stored message that must not be re-fed to a model. The transcript itself stays intact. */
  withholdsMessage(message: StoredConversationMessage): boolean { return this.query(() => this.messageWithheld(message)); }
  private messageWithheld(message: StoredConversationMessage): boolean {
    if (this.messageReadUnavailable(message)) return true;
    if (!isMemoryEvidenceVisible(this.state, message.content)) return true;
    if (this.hidden().some(item => message.sourceExperienceId === item.id
      || message.content === item.userMessage || message.content === item.shannonReply)) return true;
    return message.role === 'assistant' && this.withholdsReply({
      text: message.content, observedAt: message.observedAt,
      ...(message.recalledMemoryIds ? { recalledMemoryIds: message.recalledMemoryIds } : {}),
    });
  }

  /** An experience summary as a recall, search or embedding candidate. Only its Shannon side is matched by term. */
  withholdsExperience(experience: { id: string; summary: string; observedAt?: string; recalledMemoryIds?: readonly string[] }): boolean { return this.query(() => this.experienceWithheld(experience)); }
  private experienceWithheld(experience: { id: string; summary: string; observedAt?: string; recalledMemoryIds?: readonly string[] }): boolean {
    const full = this.experience(experience.id);
    if (full?.readSourceIds?.some(source => !this.readSourceVisible?.(this.scopeKey, source, full.observedAt))) return true;
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
  withholdsThreadSummary(threadId: string, text?: string, observedAt?: string): boolean { return this.query(() => this.threadSummaryWithheld(threadId, text, observedAt)); }
  private threadSummaryWithheld(threadId: string, text?: string, observedAt?: string): boolean {
    if (this.inactive && !this.externalReadsPossible) return false;
    const lineage = this.store?.threadSummaryLineage?.(this.scopeKey, threadId);
    if (!lineage) return !this.inactive;
    this.primeMessages(lineage.messages);
    if (lineage.messages.some(message => this.messageReadUnavailable(message))) return true;
    if (this.inactive) return false;
    const cached = this.summaryDecisions.get(threadId);
    const summaryAt = observedAt ?? lineage.updatedAt ?? '';
    const restated = Boolean(text && this.rules.some(rule => !rule.wide && ruleWithholdsText(rule, text, summaryAt)));
    if (restated || cached !== undefined) return restated || cached === true;
    const started = lineage.chainStartedAt;
    const relevant = new Set(this.rules.filter(rule => !started || rule.boundary >= started).map(rule => rule.memoryId));
    const scoped = relevant.size === this.rules.length ? this : relevant.size === 0 ? null : new MemoryWithholding(
      { ...this.state, memoryControls: this.state.memoryControls.filter(control => relevant.has(control.memoryId)) },
      this.store, this.scopeKey, this.candidates ??= this.store?.experienceCandidates(this.scopeKey), this.readSourceVisible);
    const tainted = Boolean(scoped && scoped.withReadSnapshot(() => lineage.messages.some(message => scoped.withholdsMessage(message))));
    this.summaryDecisions.set(threadId, tainted);
    return tainted;
  }

  /**
   * The replay summary, judged like the rolling summary: by its own text, and by the thread's
   * turns for every item that stopped being usable after its chain started. The worker then
   * rebuilds it from visible messages only and starts a new chain.
   */
  withholdsReplaySummary(threadId: string, summary: { summary: string; chainStartedAt: string; updatedAt: string }): boolean { return this.query(() => this.replaySummaryWithheld(threadId, summary)); }
  private replaySummaryWithheld(threadId: string, summary: { summary: string; chainStartedAt: string; updatedAt: string }): boolean {
    if (this.inactive && !this.externalReadsPossible) return false;
    const lineage = this.store?.threadSummaryLineage?.(this.scopeKey, threadId);
    if (!lineage) return !this.inactive;
    this.primeMessages(lineage.messages);
    if (lineage.messages.some(message => this.messageReadUnavailable(message))) return true;
    if (this.inactive) return false;
    if (this.rules.some(rule => !rule.wide && ruleWithholdsText(rule, summary.summary, summary.updatedAt))) return true;
    const relevant = new Set(this.rules.filter(rule => rule.boundary >= summary.chainStartedAt).map(rule => rule.memoryId));
    if (!relevant.size) return false;
    const scoped = relevant.size === this.rules.length ? this : new MemoryWithholding(
      { ...this.state, memoryControls: this.state.memoryControls.filter(control => relevant.has(control.memoryId)) },
      this.store, this.scopeKey, this.candidates ??= this.store?.experienceCandidates(this.scopeKey), this.readSourceVisible);
    return scoped.withReadSnapshot(() => lineage.messages.some(message => scoped.withholdsMessage(message)));
  }

  /** The stored rolling summary of a thread when it may be given to a model. */
  usableThreadSummary(threadId: string): string | undefined {
    if (!this.store || this.withholdsThreadSummary(threadId)) return undefined;
    const summary = this.store.threadSummary(this.scopeKey, threadId);
    return summary && !this.withholdsThreadSummary(threadId, summary) ? summary : undefined;
  }

  /** Shannon knowledge derived from a withheld turn, or restating a withheld item, is not used. */
  withholdsKnowledge(document: ShannonKnowledgeDocument): boolean { return this.query(() => this.knowledgeWithheld(document)); }
  private knowledgeWithheld(document: ShannonKnowledgeDocument): boolean {
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

/** A stored message that may be replayed, and the form the model receives it in. */
export interface VisibleMessage { message: StoredConversationMessage; item: ShannonConversationItem }

function messageExperienceIds(messages: readonly StoredConversationMessage[]): string[] {
  return [...new Set(messages.flatMap(message => [
    ...(message.sourceExperienceId ? [message.sourceExperienceId] : []), ...message.recalledMemoryIds ?? [],
  ]))];
}

function experienceRows(store: ConversationStore | null, scopeKey: string, ids: readonly string[]): ShannonExperience[] {
  const rows: ShannonExperience[] = [];
  for (let index = 0; index < ids.length && store?.experiencesById; index += 200) {
    rows.push(...store.experiencesById(scopeKey, ids.slice(index, index + 200)));
  }
  return rows;
}

function visibleMessages(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string,
  stored: readonly StoredConversationMessage[], present: MemoryAudience,
): VisibleMessage[] {
  // Owner-only replay still needs canonical private-source provenance. Share one row batch and graph walk for the window.
  const withholding = new MemoryWithholding(state, store, scopeKey);
  const requiresRows = !isOwnerOnly(present) || !withholding.inactive || store.hasReadSourceProvenance?.(scopeKey) !== false;
  const candidates = requiresRows ? experienceRows(store, scopeKey, messageExperienceIds(stored)) : [];
  const gate = new DisclosureGate(present, state, store, scopeKey, candidates);
  return withholding.withReadSnapshot(() => stored
    .filter(message => gate.allowsMessage(message) && !withholding.withholdsMessage(message))
    // A protected turn is replayed with its marker so she can check before repeating it aloud.
    .map(message => ({ message, item: { role: message.role, content: message.role === 'user' ? `${gate.markerForMessage(message)}${message.content}` : message.content } })), candidates);
}

/**
 * Keep the durable transcript intact, but don't re-feed forgotten evidence, and with
 * anyone else present re-feed only the turns they may hear. This is the small window
 * (the store's model window, 20 messages) for helpers that decide or route; the reply
 * model's history comes from `conversationReplay`.
 */
export function visibleConversationHistory(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadID: string,
  present: MemoryAudience,
): readonly ShannonConversationItem[] {
  const count = store.history(scopeKey, threadID).length;
  if (!count) return [];
  return visibleMessages(state, store, scopeKey, store.conversationHistory(scopeKey, threadID).slice(-count), present).map(entry => entry.item);
}

/**
 * The newest `limit` stored messages of a thread under the same filtering, oldest first.
 * `reachedLimit` says that older stored messages may exist beyond them.
 */
export function visibleReplayMessages(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadID: string,
  present: MemoryAudience, limit: number,
): { messages: readonly VisibleMessage[]; reachedLimit: boolean } {
  const stored = store.recentMessages?.(scopeKey, threadID, limit) ?? store.conversationHistory(scopeKey, threadID).slice(-limit);
  return { messages: visibleMessages(state, store, scopeKey, stored, present), reachedLimit: stored.length >= limit };
}

/**
 * The prior summary of a thread for the model, or nothing when it was built from a withheld
 * turn. With anyone else present it is also nothing when the thread holds a turn they must
 * not hear, and otherwise carries the marker for unlabelled text.
 */
export function usableThreadSummary(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string,
  present: MemoryAudience,
): string | undefined {
  const gate = new DisclosureGate(present, state, store, scopeKey);
  if (!gate.allowsThreadSummary(threadId)) return undefined;
  const summary = new MemoryWithholding(state, store, scopeKey).usableThreadSummary(threadId);
  return summary && gate.unlabelledMarker ? `${gate.unlabelledMarker}${summary}` : summary;
}

/**
 * The replay summary of a thread under the same rules as `usableThreadSummary`: nothing when
 * it was built from a turn that is now withheld or restates a withheld item; with anyone else
 * present nothing when the thread holds a turn they must not hear, and otherwise marked.
 */
export function usableReplaySummary(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string,
  present: MemoryAudience,
): string | undefined {
  return replaySummaryFor(state, store, scopeKey, threadId, present, 'text')?.text;
}

/**
 * The replay summary a turn may be given, and whether it is the structured one (Syzygy ADR-0008 stage 3, F7): a template is
 * rendered for its channel (text at most 900 characters, voice 目的・途中・次・重要な文脈 at most 400); without one, the stored
 * 600-character summary as it was.
 */
export function replaySummaryFor(
  state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string, present: MemoryAudience, channel: 'text' | 'voice',
): { text: string; structured: boolean } | undefined {
  const stored = store.replaySummary?.(scopeKey, threadId);
  if (!stored?.summary) return undefined;
  const gate = new DisclosureGate(present, state, store, scopeKey);
  if (!gate.allowsThreadSummary(threadId)) return undefined;
  if (new MemoryWithholding(state, store, scopeKey).withholdsReplaySummary(threadId, stored)) return undefined;
  const summary = stored.template ? renderedCompaction(stored.template, channel) : stored.summary;
  if (!summary) return undefined;
  return { text: gate.unlabelledMarker ? `${gate.unlabelledMarker}${summary}` : summary, structured: Boolean(stored.template) };
}

export function isForgottenCommitmentEvidence(state: CompanionStateSnapshot, evidence: string): boolean {
  return !isMemoryEvidenceVisible(state, evidence);
}

/**
 * The raw messages a structured replay summary stands for (Syzygy ADR-0008 stage 3, F7: `covers_from_id`..`covers_to_id`), as the
 * owner alone would be replayed them now (a message forgotten since is not opened). Empty without a structured summary.
 */
export function replaySummaryRawRange(state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string, limit = 400): readonly StoredConversationMessage[] {
  const template = store.replaySummary?.(scopeKey, threadId)?.template;
  if (!template?.coversFromId || !template.coversToId) return [];
  const messages = visibleReplayMessages(state, store, scopeKey, threadId, OWNER_AUDIENCE, limit).messages.map(entry => entry.message);
  const ids = messages.map(message => message.id);
  const start = ids.indexOf(template.coversFromId);
  const end = ids.indexOf(template.coversToId);
  if (end < 0) return [];
  return Object.freeze(messages.slice(Math.max(0, start), end + 1));
}
