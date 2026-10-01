import {
  discloseSnapshot,
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
 * The one gate every prompt-assembly path uses to decide what may reach the model
 * while `present` can hear or read the reply. It resolves an item's stored label and
 * the owner's own choice, then applies `mayDisclose` from `@shannon/cognition`.
 *
 * It reads SQLite only, calls no model and writes nothing. An item whose label cannot
 * be found is owner-only and sensitive.
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

  /** Only the owner can hear the reply: nothing is withheld by this gate. */
  get ownerOnly(): boolean { return isOwnerOnly(this.present); }

  /** The companion snapshot as it may be projected for the people present. */
  snapshot(): CompanionStateSnapshot { return discloseSnapshot(this.state, this.present); }

  /** An item that carries its own label: a fact, a relationship, a promise, a person memory. */
  allows(memoryId: string, stored: MemoryDisclosure | undefined): boolean {
    return this.ownerOnly || mayDisclose(resolveDisclosure(this.state, memoryId, stored), this.present);
  }

  /** A completed turn, by its experience ID. A turn that cannot be found is withheld. */
  allowsExperience(experienceId: string | undefined): boolean {
    if (this.ownerOnly) return true;
    if (!experienceId) return false;
    return this.allowsTurn(this.experience(experienceId) ?? { id: experienceId });
  }

  /**
   * A completed turn. Besides its own label, the memories recalled into its prompt must be
   * ones the people present may hear: a reply written with a protected memory in front of
   * it may restate that memory in words the keyword rules do not catch. The owner's own
   * ふつう on the turn overrides this.
   */
  allowsTurn(turn: Pick<ShannonExperience, 'id' | 'disclosure' | 'recalledMemoryIds'> | { id: string; disclosure?: undefined; recalledMemoryIds?: undefined }): boolean {
    if (this.ownerOnly) return true;
    if (!this.allows(turn.id, turn.disclosure)) return false;
    if (memoryControlFor(this.state, turn.id)?.sensitivity === 'ordinary') return true;
    return (turn.recalledMemoryIds ?? []).every(id => this.allowsSource(id));
  }

  /** One recalled source of a turn, judged by its own label only (no further recursion). */
  private allowsSource(id: string): boolean {
    // Summaries and Shannon's notes carry no label; a person memory cannot be resolved here. All are withheld.
    if (id.startsWith('thread:') || id.startsWith('knowledge:') || id.startsWith('person:')) return false;
    const item = this.state.userFacts.find(fact => fact.id === id) ?? this.state.relationships.find(fact => fact.id === id)
      ?? this.state.prospectiveMemories.find(fact => fact.id === id);
    return item ? this.allows(id, item.disclosure) : this.allows(id, this.experience(id)?.disclosure);
  }

  /** A stored thread message: it is judged as the turn it belongs to. Notes and other rows without a turn are unlabelled. */
  allowsMessage(message: Pick<StoredConversationMessage, 'sourceExperienceId'>): boolean {
    return this.allowsExperience(message.sourceExperienceId);
  }

  /**
   * Derived text with no label of its own: rolling thread summaries, Shannon's private
   * knowledge, the intention frame, interests. Usable only when the owner is alone.
   */
  allowsUnlabelled(): boolean { return this.ownerOnly; }

  /** A recall, full-text or semantic candidate by its recall identifier. */
  allowsRecallId(id: string): boolean {
    if (this.ownerOnly) return true;
    if (id.startsWith('thread:') || id.startsWith('knowledge:')) return false;
    const fact = this.state.userFacts.find(item => item.id === id) ?? this.state.relationships.find(item => item.id === id)
      ?? this.state.prospectiveMemories.find(item => item.id === id);
    return fact ? this.allows(id, fact.disclosure) : this.allowsExperience(id);
  }

  private experience(id: string): ShannonExperience | null {
    if (!this.experiences.has(id)) this.experiences.set(id, this.store?.experiencesById?.(this.scopeKey, [id])[0] ?? null);
    return this.experiences.get(id) ?? null;
  }
}

/**
 * What the people present may be told about ライ氏 from the profile: ordinary items and
 * items they already heard. Used where the full owner profile block must not appear.
 */
export function sharedProfilePrompt(disclosed: CompanionStateSnapshot, maximumItems = 12): string {
  const text = (id: string, original: string) => visibleMemoryText(disclosed, id, original);
  const lines = [
    ...disclosed.userFacts.flatMap(item => text(item.id, item.statement) ?? []),
    ...disclosed.relationships.flatMap(item => text(item.id, item.statement) ?? []),
    ...disclosed.prospectiveMemories.filter(item => item.status === 'pending')
      .flatMap(item => { const value = text(item.id, item.summary); return value ? [`約束: ${value}`] : []; }),
  ].slice(0, maximumItems);
  return [
    '[この場で使ってよいライ氏についての記憶]',
    '守るべき個人情報を含まないもの、または今ここにいる全員がすでに聞いたものだけが載っている。「ユーザー」はライ氏のこと。',
    ...(lines.length ? lines.map(line => `- ${line}`) : ['- (なし)']),
    'ここに載っていないライ氏の個人的なこと（予定・悩み・健康・お金・仕事の中身・過去の会話・人間関係）は、聞かれても答えず、推測もせず、ライ氏に直接聞いてもらう。',
  ].join('\n');
}
