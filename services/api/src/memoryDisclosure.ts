import {
  UNLABELLED_DISCLOSURE_MARKER,
  discloseSnapshot,
  disclosureMarker,
  isOwnerOnly,
  mayDisclose,
  memoryControlFor,
  resolveDisclosure,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type MemoryAudience,
  type MemoryDisclosure,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience, StoredConversationMessage } from './conversationStore.js';

/**
 * The one gate every prompt-assembly path uses for what reaches the model while `present`
 * can hear or read the reply. It resolves an item's stored label and the owner's own
 * choice, then applies `disclosureDecision` from `@shannon/cognition`:
 * withheld items never reach the model; guarded ones do, with a marker, and the model
 * checks before speaking; open ones are used as they are.
 *
 * It reads SQLite only, calls no model and writes nothing. An item whose label cannot
 * be found is owner-only and sensitive, that is, guarded.
 */
export class DisclosureGate {
  private readonly experiences = new Map<string, ShannonExperience | null>();

  constructor(
    readonly present: MemoryAudience,
    private readonly state: CompanionStateSnapshot,
    private readonly store: ConversationStore | null,
    private readonly scopeKey: string,
    candidates: readonly ShannonExperience[] = [],
  ) {
    for (const candidate of candidates) this.experiences.set(candidate.id, candidate);
  }

  /** Only the owner can hear the reply: nothing is withheld or marked by this gate. */
  get ownerOnly(): boolean { return isOwnerOnly(this.present); }

  private disclosed?: CompanionStateSnapshot;
  private withheldTurns?: readonly ShannonExperience[];
  private readonly summaries = new Map<string, boolean>();

  /**
   * The companion snapshot without the items that must not reach the model: withheld items,
   * items derived from a withheld turn, and interests that repeat words of a withheld turn.
   */
  snapshot(): CompanionStateSnapshot {
    if (this.ownerOnly) return this.state;
    if (this.disclosed) return this.disclosed;
    const base = discloseSnapshot(this.state, this.present);
    const fromAllowedTurn = (item: { sourceExperienceId?: string }) => !item.sourceExperienceId || this.allowsExperience(item.sourceExperienceId);
    const hidden = this.hiddenTexts();
    this.disclosed = Object.freeze({
      ...base,
      userFacts: Object.freeze(base.userFacts.filter(fromAllowedTurn)),
      relationships: Object.freeze(base.relationships.filter(fromAllowedTurn)),
      prospectiveMemories: Object.freeze(base.prospectiveMemories.filter(fromAllowedTurn)),
      interests: Object.freeze(base.interests.filter(interest => !hidden.some(text => text.includes(interest)))),
    });
    return this.disclosed;
  }

  /** Derived text that names something only a withheld item says (an interest inside today's focus, for example). */
  mentionsWithheld(text: string): boolean {
    if (this.ownerOnly) return false;
    const kept = new Set(this.snapshot().interests);
    return this.state.interests.some(interest => !kept.has(interest) && text.includes(interest));
  }

  /** Text of everything withheld that the gate can see: recent turns and labelled items. */
  private hiddenTexts(): readonly string[] {
    this.withheldTurns ??= [...new Map([...this.experiences.values(), ...(this.store?.experienceCandidates(this.scopeKey) ?? [])]
      .flatMap(turn => turn ? [[turn.id, turn] as const] : [])).values()].filter(turn => !this.allows(turn.id, turn.disclosure));
    const items = [...this.state.userFacts, ...this.state.relationships].filter(item => !this.allows(item.id, item.disclosure))
      .map(item => `${item.statement}\n${item.evidence ?? ''}`);
    return [...this.withheldTurns.map(turn => turn.userMessage), ...items];
  }

  /**
   * A rolling thread summary. It has no label, so it is judged by the turns of its thread:
   * withheld when any of them is. A store that cannot report the turns cannot clear it.
   */
  allowsThreadSummary(threadId: string): boolean {
    if (this.ownerOnly) return true;
    if (!this.summaries.has(threadId)) {
      const lineage = this.store?.threadSummaryLineage?.(this.scopeKey, threadId);
      this.summaries.set(threadId, Boolean(lineage) && lineage!.messages.every(message => this.allowsMessage(message)));
    }
    return this.summaries.get(threadId) === true;
  }

  /** An item that carries its own label: a fact, a relationship, a promise, a person memory. */
  allows(memoryId: string, stored: MemoryDisclosure | undefined): boolean {
    return this.ownerOnly || mayDisclose(resolveDisclosure(this.state, memoryId, stored), this.present);
  }

  /** 【機微:…】 for a guarded item, otherwise empty. */
  marker(memoryId: string, stored: MemoryDisclosure | undefined): string {
    return this.ownerOnly ? '' : disclosureMarker(resolveDisclosure(this.state, memoryId, stored), this.present);
  }

  /** The marker for text with no label of its own. Empty when the owner is alone. */
  get unlabelledMarker(): string { return this.ownerOnly ? '' : UNLABELLED_DISCLOSURE_MARKER; }

  /** A completed turn, by its experience ID. */
  allowsExperience(experienceId: string | undefined): boolean {
    if (this.ownerOnly) return true;
    if (!experienceId) return true;
    return this.allowsTurn(this.experience(experienceId) ?? { id: experienceId });
  }

  /**
   * A completed turn. Besides its own label, none of the memories recalled into its prompt
   * may be a withheld one: a reply written with a secret in front of it may restate that
   * secret in other words. The owner's own ふつう on the turn overrides this.
   */
  allowsTurn(turn: Pick<ShannonExperience, 'id' | 'disclosure' | 'recalledMemoryIds'> | { id: string; disclosure?: undefined; recalledMemoryIds?: undefined }): boolean {
    if (this.ownerOnly) return true;
    if (!this.allows(turn.id, turn.disclosure)) return false;
    if (memoryControlFor(this.state, turn.id)?.sensitivity === 'ordinary') return true;
    return (turn.recalledMemoryIds ?? []).every(id => this.allowsSource(id));
  }

  markerForTurn(turn: Pick<ShannonExperience, 'id' | 'disclosure'>): string { return this.marker(turn.id, turn.disclosure); }

  /** One recalled source of a turn, judged by its own label only (no further recursion). */
  private allowsSource(id: string): boolean {
    if (id.startsWith('thread:')) return this.allowsThreadSummary(id.slice('thread:'.length));
    if (id.startsWith('knowledge:')) return true;
    // A person memory cannot be resolved here and may be from an unnamed guest's call.
    if (id.startsWith('person:')) return false;
    const item = this.labelled(id);
    return item ? this.allows(id, item.disclosure) : this.allows(id, this.experience(id)?.disclosure);
  }

  /** A stored thread message: it is judged as the turn it belongs to. */
  allowsMessage(message: Pick<StoredConversationMessage, 'sourceExperienceId'>): boolean {
    return this.allowsExperience(message.sourceExperienceId);
  }

  markerForMessage(message: Pick<StoredConversationMessage, 'sourceExperienceId'>): string {
    if (this.ownerOnly) return '';
    const id = message.sourceExperienceId;
    const turn = id ? this.experience(id) : null;
    return turn ? this.markerForTurn(turn) : UNLABELLED_DISCLOSURE_MARKER;
  }

  /** A recall, full-text or semantic candidate by its recall identifier. */
  allowsRecallId(id: string): boolean {
    if (this.ownerOnly || id.startsWith('knowledge:')) return true;
    if (id.startsWith('thread:')) return this.allowsThreadSummary(id.slice('thread:'.length));
    const item = this.labelled(id);
    return item ? this.allows(id, item.disclosure) : this.allowsExperience(id);
  }

  markerForRecallId(id: string): string {
    if (this.ownerOnly) return '';
    if (id.startsWith('thread:') || id.startsWith('knowledge:')) return UNLABELLED_DISCLOSURE_MARKER;
    const item = this.labelled(id);
    return item ? this.marker(id, item.disclosure) : this.marker(id, this.experience(id)?.disclosure);
  }

  private labelled(id: string) {
    return this.state.userFacts.find(item => item.id === id) ?? this.state.relationships.find(item => item.id === id)
      ?? this.state.prospectiveMemories.find(item => item.id === id);
  }

  private experience(id: string): ShannonExperience | null {
    if (!this.experiences.has(id)) this.experiences.set(id, this.store?.experiencesById?.(this.scopeKey, [id])[0] ?? null);
    return this.experiences.get(id) ?? null;
  }
}

/**
 * The profile for a context with other people present: what Shannon knows about ライ氏,
 * each protected line marked. Items that must not reach the model are already removed.
 */
export function sharedProfilePrompt(gate: DisclosureGate, maximumItems = 16): string {
  const disclosed = gate.snapshot();
  const line = (id: string, original: string, stored: MemoryDisclosure | undefined, prefix = '') => {
    const text = visibleMemoryText(disclosed, id, original);
    return text ? [`- ${gate.marker(id, stored)}${prefix}${text}`] : [];
  };
  const lines = [
    ...disclosed.userFacts.flatMap(item => line(item.id, item.statement, item.disclosure)),
    ...disclosed.relationships.flatMap(item => line(item.id, item.statement, item.disclosure)),
    ...disclosed.prospectiveMemories.filter(item => item.status === 'pending')
      .flatMap(item => line(item.id, item.summary, item.disclosure, '約束: ')),
  ].slice(0, maximumItems);
  const interests = disclosed.interests.slice(0, 6);
  return [
    '[ライ氏についての記憶 — ほかの人がいる場]',
    '「ユーザー」はライ氏のこと。【機微:…】が付いた行は、この場の人がまだ知らない個人情報。',
    ...(lines.length ? lines : ['- (なし)']),
    ...(interests.length ? [`- ${gate.unlabelledMarker}最近の関心: ${interests.join('、')}`] : []),
  ].join('\n');
}
