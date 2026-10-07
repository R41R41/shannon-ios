import { SELF_INTEREST_LIMITS, selfInterestActive, selfInterestIndexUsed, selfInterestNightKey, selfInterestTopicKey,
  selfInterestWeight, selfInterestProjection, selfInterestLine, memoryIdentifier, memoryControlFor, visibleMemoryText, isMemoryEvidenceVisible,
  isOwnerMemoryEvidence, mayDisclose, disclosureDecision, disclosureMarker, resolveDisclosure, OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE,
  type CompanionStateSnapshot, type MemoryAudience, type MemoryDisclosure, type SelfInterest, type SelfInterestChange,
  type SelfInterestOwnerCommand, type SelfInterestProposal, type SelfInterestSnapshot, type SelfInterestDetail, type SelfInterestEvidenceView } from '@shannon/cognition';
import { SQLiteSelfInterests, selfInterestId, selfInterestRequestHash, type InterestOwnerReceipt } from './store/sqliteSelfInterests.js';

export interface SelfInterestEvidence { id: string; text: string; disclosure?: MemoryDisclosure; owner: boolean }
export interface SelfInterestSources {
  snapshot(scopeKey: string): CompanionStateSnapshot;
  /** Exact canonical references, checked again at adoption/read time; null or incomplete is unavailable. */
  evidence(scopeKey: string, refs: readonly string[]): readonly SelfInterestEvidence[] | null;
}
export interface SelfInterestMemoryPort {
  revision(scopeKey: string): string;
  proposeWithin(scopeKey: string, proposal: SelfInterestProposal, at: string): string;
  holdUnverifiedWithin(scopeKey: string, proposal: SelfInterestProposal, at: string): string;
  nightWithin(scopeKey: string, at: string): string;
  ownerWithin(scopeKey: string, command: SelfInterestOwnerCommand, at: string): string;
  ownerResultWithin(scopeKey: string, operationId: string): SelfInterest | null;
  ownerObservationAllowed(scopeKey: string, title: string, refs: readonly string[]): boolean;
}
export interface SelfInterestContextPort {
  read(scopeKey: string, audience?: MemoryAudience): { index: string; secrets: readonly string[] } | null;
}

/** The supplementary self, reached only by the one memory writer. No connection, timer, model or independent lock here. */
export class SelfInterestMemory implements SelfInterestMemoryPort {
  constructor(readonly store: SQLiteSelfInterests, private readonly sources: SelfInterestSources, private readonly timeZone = 'Asia/Tokyo') {}
  revision(scopeKey: string): string { return String(this.store.revision(scopeKey)); }
  private evidence(scopeKey: string, refs: readonly string[]): readonly SelfInterestEvidence[] | null {
    if (!refs.length || refs.length > SELF_INTEREST_LIMITS.evidence) return null;
    const found = this.sources.evidence(scopeKey, refs);
    return found && refs.every(id => found.some(row => row.id === id)) ? found : null;
  }
  visible(scopeKey: string, item: Pick<SelfInterest, 'id' | 'title' | 'description' | 'reason' | 'evidenceRefs' | 'disclosure'>,
    audience: MemoryAudience = OWNER_AUDIENCE, openOnly = false): boolean {
    const state = this.sources.snapshot(scopeKey);
    if (!mayDisclose(resolveDisclosure(state, item.id, item.disclosure ?? undefined), audience)
      || !mayDisclose(resolveDisclosure(state, memoryIdentifier('interest', item.title), item.disclosure ?? undefined), audience)
      || !isMemoryEvidenceVisible(state, `${item.title}\n${item.description}\n${item.reason}`)
      || visibleMemoryText(state, item.id, item.title) === null || visibleMemoryText(state, memoryIdentifier('interest', item.title), item.title) === null) return false;
    const found = this.evidence(scopeKey, item.evidenceRefs);
    const labels = [resolveDisclosure(state, item.id, item.disclosure ?? undefined),
      resolveDisclosure(state, memoryIdentifier('interest', item.title), item.disclosure ?? undefined),
      ...(found ?? []).map(row => resolveDisclosure(state, row.id, row.disclosure))];
    return Boolean(found && (!openOnly || labels.every(label => disclosureDecision(label, UNKNOWN_GUEST_PRESENCE) === 'open'))
      && found.every(row => mayDisclose(resolveDisclosure(state, row.id, row.disclosure), audience) && visibleMemoryText(state, row.id, row.text) !== null));
  }
  ownerObservationAllowed(scopeKey: string, title: string, refs: readonly string[]): boolean {
    const rows = this.evidence(scopeKey, refs);
    const state = this.sources.snapshot(scopeKey);
    const key = selfInterestTopicKey(title);
    return Boolean(key && rows?.some(row => row.owner && visibleMemoryText(state, row.id, row.text) !== null
      && (row.text.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? []).some(sentence => isOwnerMemoryEvidence(sentence, row.text)
        && selfInterestTopicKey(sentence).includes(key) && /(?:興味がある|気になっている|気になる|関心がある)/u.test(sentence))));
  }
  proposeWithin(scopeKey: string, proposal: SelfInterestProposal, at: string): string {
    if (!proposal.evidenceRefs.length) return 'evidence_missing';
    if (proposal.kind !== 'add' && (!proposal.itemId || proposal.expectedRevision === undefined || proposal.ownerGeneration === undefined)) return 'malformed';
    this.store.propose(scopeKey, proposal, at);
    return 'proposed';
  }
  holdUnverifiedWithin(scopeKey: string, proposal: SelfInterestProposal, at: string): string {
    this.store.propose(scopeKey, proposal, at);
    this.store.settleCandidate(scopeKey, proposal.candidateId, 'held', 'provenance_unknown');
    return 'candidate_held';
  }
  private change(scopeKey: string, id: string, before: SelfInterest | null, after: SelfInterest, kind: string,
    actor: 'sleep' | 'owner', at: string, nightKey: string | null, reason: string): void {
    this.store.save(scopeKey, after);
    this.store.appendChange(scopeKey, { changeId: id, itemId: after.id, actor, kind, before, after, reason, nightKey, createdAt: at });
  }
  nightWithin(scopeKey: string, at: string): string {
    const night = selfInterestNightKey(at, this.timeZone);
    const budget = this.store.night(scopeKey, night) ?? { added: 0, removed: 0, baseline: Object.fromEntries(this.store.all(scopeKey).map(item => [item.id, item.weight])) };
    for (const candidate of this.store.adoptableCandidates(scopeKey)) {
      const p = candidate.proposal;
      let before = p.itemId ? this.store.get(scopeKey, p.itemId) : null;
      const reject = (code: string, held = false) => this.store.settleCandidate(scopeKey, p.candidateId, held ? 'held' : 'rejected', code);
      if (p.weight !== undefined && !selfInterestWeight(p.weight)) { reject('bad_weight'); continue; }
      if (p.kind !== 'add' && (!before || before.revision !== p.expectedRevision || before.ownerGeneration !== p.ownerGeneration)) { reject('stale'); continue; }
      const title = p.title ?? before?.title ?? '';
      const topic = selfInterestTopicKey(title);
      if (!topic || [...title].length > SELF_INTEREST_LIMITS.title) { reject('malformed'); continue; }
      const all = this.store.all(scopeKey);
      const related = all.filter(item => item.topicKey === topic || p.relatedIds?.includes(item.id)
        || (item.topicKey.length >= 3 && topic.length >= 3 && (item.topicKey.includes(topic) || topic.includes(item.topicKey))));
      if (related.some(item => item.banned || item.forgotten || item.frozen)) { reject('owner_control'); continue; }
      if (p.kind === 'add') {
        const previous = related.find(item => item.topicKey === topic);
        if (previous && !previous.retired) { reject('duplicate_topic'); continue; }
        // An owner-resumed, retired item keeps its identity, evidence history and weight baseline.
        before = previous ?? before;
      }
      if (before && (before.pinned || before.banned || before.forgotten || before.frozen || before.retired && p.kind !== 'add')) { reject('owner_control'); continue; }
      if (before && title !== before.title) { reject('rename_requires_add_remove'); continue; }
      const state = this.sources.snapshot(scopeKey);
      if ([memoryIdentifier('interest', title), before?.id].some(id => id && memoryControlFor(state, id)?.pinned)) { reject('owner_control'); continue; }
      const after: SelfInterest = before ? { ...before, description: p.description ?? before.description, reason: p.reason,
        evidenceRefs: p.evidenceRefs, disclosure: p.disclosure, updatedAt: at, revision: before.revision + 1,
        weight: p.kind === 'patch' ? p.weight ?? before.weight : before.weight, retired: p.kind === 'remove' } : {
        id: selfInterestId(p.candidateId), topicKey: topic, title, description: p.description ?? '', reason: p.reason, weight: SELF_INTEREST_LIMITS.initialWeight,
        evidenceRefs: p.evidenceRefs, disclosure: p.disclosure, revision: 1, ownerGeneration: 0, pinned: false, banned: false, forgotten: false, frozen: false,
        retired: false, createdAt: at, updatedAt: at };
      if (!this.visible(scopeKey, after)) { reject('source_hidden'); continue; }
      if (!selfInterestWeight(after.weight)) { reject('bad_weight'); continue; }
      const base = budget.baseline[after.id] ?? after.weight;
      if (Math.abs(after.weight - base) > SELF_INTEREST_LIMITS.nightlyWeightDelta + 1e-9) { reject('weight_limit'); continue; }
      if (p.kind === 'add' && budget.added >= SELF_INTEREST_LIMITS.additions || p.kind === 'remove' && budget.removed >= SELF_INTEREST_LIMITS.removals) { reject('night_limit', true); continue; }
      const projected = [...all.filter(item => item.id !== after.id), after];
      if (projected.filter(selfInterestActive).length > SELF_INTEREST_LIMITS.items || selfInterestIndexUsed(projected) > SELF_INTEREST_LIMITS.indexCharacters) { reject('over_capacity', true); continue; }
      this.change(scopeKey, `night:${selfInterestId(p.candidateId)}`, before, after, p.kind, 'sleep', at, night, p.reason);
      if (p.kind === 'add') budget.added += 1;
      if (p.kind === 'remove') budget.removed += 1;
      budget.baseline[after.id] ??= after.weight;
      this.store.settleCandidate(scopeKey, p.candidateId, 'accepted', 'adopted');
    }
    this.store.saveNight(scopeKey, night, budget);
    return 'night_adopted';
  }
  ownerWithin(scopeKey: string, command: SelfInterestOwnerCommand, at: string): string {
    const hash = selfInterestRequestHash(command);
    const old = this.store.receipt(scopeKey, command.operationId);
    if (old) return old.requestHash === hash ? old.code : 'operation_conflict';
    const before = this.store.get(scopeKey, command.itemId);
    const receipt = (code: string, item = before): string => { this.store.saveReceipt(scopeKey, command.operationId,
      { requestHash: hash, code, item, revision: this.store.revision(scopeKey) }); return code; };
    if (!before) return receipt('not_found');
    if (before.revision !== command.expectedRevision) return receipt('stale');
    let after = { ...before, revision: before.revision + 1, ownerGeneration: before.ownerGeneration + 1, updatedAt: at };
    switch (command.action) {
      case 'pin': after.pinned = true; break;
      case 'unpin': after.pinned = false; break;
      case 'ban': after.banned = true; break;
      case 'unban': after.banned = false; break;
      case 'forget': after.forgotten = true; break;
      case 'resume': after.frozen = false; break;
      case 'undo': {
        const change = command.changeId ? this.store.change(scopeKey, command.changeId) : null;
        if (!change || change.itemId !== before.id) return receipt('change_not_found');
        if (this.store.laterContentChange(scopeKey, before.id, change.seq)) return receipt('stale');
        // Owner controls do not prevent undo of the last content change; later content changes do.
        const content = (item: SelfInterest) => JSON.stringify([item.title, item.description, item.reason, item.weight, item.evidenceRefs, item.disclosure, item.retired]);
        if (content(change.after) !== content(before)) return receipt('stale');
        after = { ...(change.before ?? { ...before, retired: true }), id: before.id, topicKey: before.topicKey,
          revision: before.revision + 1, ownerGeneration: before.ownerGeneration + 1, updatedAt: at,
          pinned: before.pinned, banned: before.banned, forgotten: before.forgotten, frozen: true };
        if (!after.forgotten && !after.banned && !this.visible(scopeKey, after)) return receipt('source_hidden');
        break;
      }
    }
    if ((command.action === 'undo' || command.action === 'unban') && (this.store.all(scopeKey).filter(item => item.id !== after.id && selfInterestActive(item)).length + Number(selfInterestActive(after)) > SELF_INTEREST_LIMITS.items
      || selfInterestIndexUsed([...this.store.all(scopeKey).filter(item => item.id !== after.id), after]) > SELF_INTEREST_LIMITS.indexCharacters)) return receipt('over_capacity');
    this.change(scopeKey, `owner:${selfInterestId(command.operationId)}`, before, after, command.action, 'owner', at, null, `owner_${command.action}`);
    return receipt('changed', after);
  }
  receipt(scopeKey: string, operationId: string): InterestOwnerReceipt | null { return this.store.receipt(scopeKey, operationId); }
  operation(scopeKey: string, operationId: string): { code: string; item: SelfInterest | null; revision: number } | null {
    const receipt = this.store.receipt(scopeKey, operationId);
    if (!receipt) return null;
    const item = receipt.item;
    const current = item && this.store.get(scopeKey, item.id);
    return { code: receipt.code, revision: receipt.revision, item: item && (item.forgotten || current?.forgotten || !this.visible(scopeKey, item))
      ? { ...item, topicKey: '', title: '（表示しない関心）', description: '', reason: '', evidenceRefs: [], disclosure: null } : item };
  }
  ownerResultWithin(scopeKey: string, operationId: string): SelfInterest | null { return this.store.receipt(scopeKey, operationId)?.item ?? null; }
  private view(scopeKey: string, history: readonly SelfInterestChange[]): SelfInterestSnapshot {
    const all = this.store.all(scopeKey);
    const readable = (item: SelfInterest) => !item.forgotten && !all.find(current => current.id === item.id)?.forgotten && this.visible(scopeKey, item);
    const redact = (item: SelfInterest): SelfInterest => readable(item) ? item
      : { ...item, topicKey: '', title: '（表示しない関心）', description: '', reason: '', evidenceRefs: [], disclosure: null };
    const changes = history.slice(0, 100).map(change => ({ ...change, reason: change.actor === 'owner' ? change.reason : readable(change.after) ? change.reason : '',
      before: change.before ? redact(change.before) : null, after: redact(change.after) }));
    return { revision: this.store.revision(scopeKey), items: all.map(redact), changes,
      capacity: { used: all.filter(selfInterestActive).length, limit: SELF_INTEREST_LIMITS.items, indexUsed: selfInterestIndexUsed(all), indexLimit: SELF_INTEREST_LIMITS.indexCharacters },
      pending: this.store.candidateCounts(scopeKey), nextCursor: history.length > 100 ? changes.at(-1)!.seq : null };
  }
  snapshot(scopeKey: string, beforeSeq?: number): SelfInterestSnapshot {
    return this.view(scopeKey, this.store.changes(scopeKey, 101, beforeSeq));
  }
  detail(scopeKey: string, itemId: string, beforeSeq?: number): SelfInterestDetail | null {
    const view = this.view(scopeKey, this.store.changes(scopeKey, 101, beforeSeq, itemId));
    const item = view.items.find(row => row.id === itemId);
    return item ? { revision: view.revision, item, changes: view.changes, nextCursor: view.nextCursor, evidence: this.evidenceView(scopeKey, itemId) } : null;
  }
  private evidenceView(scopeKey: string, itemId: string): SelfInterestEvidenceView {
    const empty = (status: 'hidden' | 'unavailable'): SelfInterestEvidenceView => ({ status, total: 0, omitted: 0, items: [] });
    const item = this.store.get(scopeKey, itemId);
    if (!item || item.forgotten) return empty('hidden');
    const rows = this.evidence(scopeKey, item.evidenceRefs);
    if (!rows) return empty('unavailable');
    if (!this.visible(scopeKey, item)) return empty('hidden');
    const state = this.sources.snapshot(scopeKey);
    const items: { id: string; text: string; truncated: boolean }[] = [];
    let remaining = 1_600;
    for (const id of [...new Set(item.evidenceRefs)]) {
      if (remaining === 0) break;
      const row = rows.find(source => source.id === id)!;
      const text = visibleMemoryText(state, id, row.text);
      if (text === null || !mayDisclose(resolveDisclosure(state, id, row.disclosure), OWNER_AUDIENCE)) return empty('hidden');
      const characters = [...text.trim()];
      const limit = Math.min(240, remaining);
      const truncated = characters.length > limit;
      const excerpt = truncated ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('');
      items.push({ id, text: excerpt, truncated });
      remaining -= [...excerpt].length;
    }
    return { status: 'available', total: item.evidenceRefs.length, omitted: item.evidenceRefs.length - items.length, items };
  }
  context(scopeKey: string, audience: MemoryAudience = OWNER_AUDIENCE): { index: string; secrets: readonly string[] } {
    const secretLabel = (label: MemoryDisclosure | null | undefined) => label?.category === 'secret' || label?.category === 'unknown_audience'
      || label?.audience?.kind === 'people' && label.audience.unknownGuest === true;
    const secrets = this.store.all(scopeKey).filter(item => selfInterestActive(item) && this.visible(scopeKey, item, audience))
      .filter(item => !this.visible(scopeKey, item, UNKNOWN_GUEST_PRESENCE) || secretLabel(item.disclosure)
        || this.evidence(scopeKey, item.evidenceRefs)?.some(row => secretLabel(row.disclosure)))
      .flatMap(item => [item.title, item.description, item.reason]).filter(Boolean);
    return { index: this.projection(scopeKey, audience), secrets: [...new Set(secrets)] };
  }
  projection(scopeKey: string, audience: MemoryAudience = OWNER_AUDIENCE, openOnly = false): string {
    const state = this.sources.snapshot(scopeKey);
    return selfInterestProjection(this.store.all(scopeKey), item => this.visible(scopeKey, item, audience, openOnly), audience, item => {
      const labels = [resolveDisclosure(state, item.id, item.disclosure ?? undefined),
        resolveDisclosure(state, memoryIdentifier('interest', item.title), item.disclosure ?? undefined),
        ...(this.evidence(scopeKey, item.evidenceRefs) ?? []).map(row => resolveDisclosure(state, row.id, row.disclosure))];
      const markers = [...new Set(labels.map(label => disclosureMarker(label, audience)).filter(Boolean))];
      return [...markers, selfInterestLine(item)].join('\n');
    });
  }
}
