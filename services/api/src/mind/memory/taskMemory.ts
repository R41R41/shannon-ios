import { searchOptions, matchesSearch, withinSearchRange } from '../../infra/search/searchQuery.js';
import { isOwnerOnly, memoryControlFor, memoryIdentifier, searchMemoryDocuments, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore, type MemoryAudience } from '@shannon/cognition';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';
import { DeepChains, deepWalk, settleDeepChains } from './recallChainDepth.js';
import { MemoryWithholding, type ReadSourceVisible } from './memoryVisibility.js';
import type { ConversationStore, ShannonExperience } from './conversationContract.js';
import type { ShannonKnowledgeStore } from './store/sqliteShannonKnowledge.js';
import type { TaskMemory, TaskMemoryItem, TaskMemoryReadSnapshot } from './taskMemoryPorts.js';

export interface TaskMemoryParts {
  state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore; ownerScope: string;
  ownerAlone(): boolean; now(): string; knowledge?: Pick<ShannonKnowledgeStore, 'listShannonKnowledge'>;
  readSourceVisible?: ReadSourceVisible;
}
/** Same canonical store, disclosure and forgetting gates as conversation recall. No cached private text. */
export function createTaskMemory(parts: TaskMemoryParts): TaskMemory {
  const knowledge = parts.knowledge ?? (typeof (parts.conversations as Partial<ShannonKnowledgeStore>).listShannonKnowledge === 'function'
    ? parts.conversations as ConversationStore & ShannonKnowledgeStore : undefined);
  const available = (scope: string, present: MemoryAudience) => scope === parts.ownerScope && isOwnerOnly(present) && parts.ownerAlone();
  /**
   * The state and withholding of a read, kept while the database is unchanged (its change mark: every write of the state, a turn,
   * a task experience or a skill moves it). Then the state is the same object (its withheld evidence is gathered once) and the
   * remembered turns and their withheld ones are not read again; every read still asks native read receipts afresh, and walks
   * afresh, since only the read's own decisions are memoized (`MemoryWithholding.query`). Minecraft run 6 (2026-10-14).
   */
  let kept: { key: string; snapshot: TaskMemoryReadSnapshot } | null = null;
  const readSnapshot = (scope: string): TaskMemoryReadSnapshot => {
    const mark = parts.conversations.changeMark?.() ?? null;
    const key = mark === null ? null : JSON.stringify([scope, mark]);
    if (key !== null && kept?.key === key) return kept.snapshot;
    const state = parts.state.snapshot(scope);
    const withholding = new MemoryWithholding(state, parts.conversations, scope, parts.conversations.experienceCandidates(scope), parts.readSourceVisible);
    const snapshot: TaskMemoryReadSnapshot = { state, withholding, experience: id => withholding.experienceRow(id) };
    // Reading the state may itself have written (a first state): keep it under the mark after the read.
    const after = parts.conversations.changeMark?.() ?? null;
    kept = key !== null && after === mark ? { key, snapshot } : null;
    return snapshot;
  };
  const read: TaskMemory['read'] = (scope, ids, present, shared) => {
    if (!available(scope, present)) return [];
    const state = shared?.state ?? parts.state.snapshot(scope), store = parts.conversations;
    const gate = new DisclosureGate(present, state, store, scope);
    const withheld = shared?.withholding ?? new MemoryWithholding(state, store, scope, undefined, parts.readSourceVisible);
    return withheld.withReadSnapshot(() => {
    const canonical = new Map<string, ReturnType<NonNullable<ConversationStore['experiencesById']>>[number] | null>();
    const experienceOf = (id: string) => {
      if (shared?.experience) return shared.experience(id);
      if (!canonical.has(id)) canonical.set(id, store.experiencesById?.(scope, [id])[0] ?? null); return canonical.get(id) ?? null;
    };
    const lineage = new Map<string, boolean>();
    const deepLineage = new DeepChains('lineage');
    // What `computeLineage` goes on to ask about, for the walk that settles a long chain (`recallChainDepth.ts`).
    const lineageEdges = (id: string): readonly string[] => {
      const experience = experienceOf(id);
      if (experience) return experience.recalledMemoryIds ?? [];
      if (id.startsWith('thread:')) {
        const messages = store.threadSummaryLineage?.(scope, id.slice(7))?.messages ?? [];
        return messages.flatMap(message => message.sourceExperienceId ? [message.sourceExperienceId] : []);
      }
      if (id.startsWith('knowledge:')) return knowledge?.listShannonKnowledge(scope).find(row => row.id === id.slice(10))?.sourceExperienceIds ?? [];
      const scalar = [...state.userFacts, ...state.relationships, ...state.prospectiveMemories].find(row => row.id === id);
      return scalar?.sourceExperienceId ? [scalar.sourceExperienceId] : [];
    };
    const lineageVisible = (id: string, seen?: Set<string>): boolean => {
      // A long chain of turns that each recalled the one before overflows the stack (`recallChainDepth.ts`): then it is settled from its far end.
      if (!seen) {
        const settle = () => settleDeepChains([id], lineageEdges, settled => lineageVisible(settled, new Set()), undefined, undefined, deepLineage);
        return deepWalk(() => lineageVisible(id, new Set()), settle, false, deepLineage, id);
      }
      if (seen.has(id) || seen.size >= 5000) return false;
      const known = lineage.get(id); if (known !== undefined) return known;
      seen.add(id);
      try { const result = computeLineage(id, seen); lineage.set(id, result); return result; } finally { seen.delete(id); }
    };
    const computeLineage = (id: string, seen: Set<string>): boolean => {
      const experience = experienceOf(id);
      if (withheld.withholdsReply({ text: '', observedAt: parts.now(), recalledMemoryIds: [id] })) return false;
      if (memoryControlFor(state, id)?.overrideText) return true;
      if (!experience) {
        if (id.startsWith('thread:')) {
          const lineage = store.threadSummaryLineage?.(scope, id.slice(7));
          return Boolean(lineage) && !withheld.withholdsThreadSummary(id.slice(7)) && lineage!.messages.every(message =>
            !message.sourceExperienceId || lineageVisible(message.sourceExperienceId, seen));
        }
        if (id.startsWith('knowledge:')) {
          const doc = knowledge?.listShannonKnowledge(scope).find(row => row.id === id.slice(10));
          return Boolean(doc) && !withheld.withholdsKnowledge(doc!) && doc!.sourceExperienceIds.every(ref => lineageVisible(ref, seen));
        }
        const scalar = [...state.userFacts, ...state.relationships, ...state.prospectiveMemories].find(row => row.id === id);
        if (scalar) return !scalar.sourceExperienceId || lineageVisible(scalar.sourceExperienceId, seen);
        return state.activeMemories.some(row => row.id === id) || state.interests.some(text => memoryIdentifier('interest', text) === id);
      }
      return gate.allowsTurn(experience) && !withheld.withholdsExperience(experience)
        && !(experience.readSourceIds ?? []).some(ref => !withheld.readSourceAvailable(ref, experience.observedAt))
        && (experience.recalledMemoryIds ?? []).every(ref => lineageVisible(ref, seen));
    };
    const items: TaskMemoryItem[] = [];
    for (const id of [...new Set(ids)].slice(0, 40)) {
      let summary: string | undefined, at = '', evidence = '', applicability = 'recorded observation';
      let confidence: number | null = null;
      let provenanceKind: 'experience' | 'thread' | 'knowledge' | 'state' = 'state';
      let readSourceIds: readonly string[] = [];
      if (id.startsWith('thread:')) {
        provenanceKind = 'thread';
        const thread = id.slice(7), lineage = store.threadSummaryLineage?.(scope, thread);
        if (!lineage || !gate.allowsThreadSummary(thread) || withheld.withholdsThreadSummary(thread)) continue;
        summary = store.threadSummary(scope, thread); at = lineage.updatedAt ?? '';
        if (lineage.messages.some(message => message.sourceExperienceId && !lineageVisible(message.sourceExperienceId))) continue;
        applicability = 'conversation summary; original messages remain the evidence';
      } else if (id.startsWith('knowledge:')) {
        provenanceKind = 'knowledge';
        const doc = knowledge?.listShannonKnowledge(scope).find(row => row.id === id.slice(10));
        if (!doc || withheld.withholdsKnowledge(doc) || doc.sourceExperienceIds.some(ref => !lineageVisible(ref))) continue;
        readSourceIds = (doc.aetherReferences ?? []).map(ref => `aether-document://${encodeURIComponent(ref.documentId)}`);
        summary = `${doc.title}\n${doc.bodyMarkdown}`; at = doc.updatedAt; applicability = doc.applicability; evidence = doc.sourceExperienceIds.join(',');
        if (doc.aetherReferences?.some(ref => !withheld.readSourceAvailable(`aether-document://${encodeURIComponent(ref.documentId)}`, at))) continue;
      } else {
        const experience = experienceOf(id);
        const fact = state.userFacts.find(row => row.id === id) ?? state.relationships.find(row => row.id === id);
        const promise = state.prospectiveMemories.find(row => row.id === id);
        const active = state.activeMemories.find(row => row.id === id);
        const interest = state.interests.find(text => memoryIdentifier('interest', text) === id);
        if (experience) {
          if (!lineageVisible(id)) continue;
          provenanceKind = 'experience'; readSourceIds = experience.readSourceIds ?? [];
          summary = experience.summary; at = experience.observedAt; evidence = experience.userMessage;
        } else if (fact) {
          if (!gate.allows(id, fact.disclosure) || (fact.sourceExperienceId && !lineageVisible(fact.sourceExperienceId))) continue;
          summary = fact.statement; at = fact.observedAt; confidence = fact.confidence; evidence = fact.evidence ?? '';
        } else if (promise) {
          if (!gate.allows(id, promise.disclosure) || (promise.sourceExperienceId && !lineageVisible(promise.sourceExperienceId))) continue;
          summary = promise.summary; at = promise.updatedAt; evidence = promise.evidence ?? ''; applicability = `promise ${promise.status}`;
        } else if (active) { summary = active.summary; at = state.updatedAt; applicability = 'active memory';
        } else if (interest) { summary = interest; at = state.updatedAt; applicability = 'current interest'; }
      }
      if (!summary) continue;
      const visible = visibleMemoryText(state, id, summary);
      if (!visible || withheld.withholdsReply({ text: visible, observedAt: parts.now(), recalledMemoryIds: [id] })) continue;
      if (memoryControlFor(state, id)?.overrideText) { evidence = ''; applicability = 'owner-corrected memory'; }
      items.push({ id, summary: visible.slice(0, 1200), observedAt: at, evidence: evidence.slice(0, 300), applicability,
        confidence, conflicts: [], detailRef: id, provenance: { kind: provenanceKind, sourceIds: sources(scope, [id], experienceOf, state), readSourceIds } });
    }
    return items;
    });
  };
  // Within one read, the read's own state (2026-10-13: a state read per recalled item, ~80 per report walk).
  const sources = (scope: string, ids: readonly string[], cachedExperience?: (id: string) => ShannonExperience | null,
    readState?: CompanionStateSnapshot) => {
    const found = new Set<string>(), pending = [...ids], state = readState ?? parts.state.snapshot(scope);
    while (pending.length) {
      const id = pending.shift()!; if (found.has(id)) continue;
      found.add(id); if (found.size > 5000) throw new Error('TASK_MEMORY_LINEAGE_LIMIT');
      if (id.startsWith('thread:')) pending.push(...(parts.conversations.threadSummaryLineage?.(scope, id.slice(7))?.messages ?? [])
        .flatMap(message => message.sourceExperienceId ? [message.sourceExperienceId] : []));
      else if (id.startsWith('knowledge:')) pending.push(...(knowledge?.listShannonKnowledge(scope).find(row => row.id === id.slice(10))?.sourceExperienceIds ?? []));
      else {
        const experience = cachedExperience ? cachedExperience(id) : parts.conversations.experiencesById?.(scope, [id])[0];
        if (experience) pending.push(...experience.recalledMemoryIds ?? []);
        const scalar = [...state.userFacts, ...state.relationships, ...state.prospectiveMemories].find(row => row.id === id);
        if (scalar?.sourceExperienceId && !memoryControlFor(state, id)?.overrideText) pending.push(scalar.sourceExperienceId);
      }
    }
    return [...found];
  };
  const search: TaskMemory['search'] = (scope, query, present, limit = 8, options, shared) => {
    if (!available(scope, present)) return [];
    const state = shared?.state ?? parts.state.snapshot(scope);
    const candidates = [...state.userFacts, ...state.relationships].map(item => ({ id: item.id, text: item.statement, observedAt: item.observedAt }));
    candidates.push(...state.activeMemories.map(item => ({ id: item.id, text: item.summary, observedAt: state.updatedAt })),
      ...state.interests.map(text => ({ id: memoryIdentifier('interest', text), text, observedAt: state.updatedAt })));
    candidates.push(...state.prospectiveMemories.map(item => ({ id: item.id, text: item.summary, observedAt: item.updatedAt })));
    const ids = [...(parts.conversations.searchMemory?.(scope, query, options ? 1200 : 40, options ? { ...options, offset: 0 } : undefined) ?? []).map(hit => hit.id),
      ...searchMemoryDocuments(query, candidates, 20).map(item => item.id)];
    if (!options) return read(scope, ids, present, shared).slice(0, Math.max(1, Math.min(12, limit)));
    const unique = [...new Set(ids)], found: TaskMemoryItem[] = [];
    for (let offset = 0; offset < unique.length; offset += 40) found.push(...read(scope, unique.slice(offset, offset + 40), present, shared));
    const visible = found.filter(item => (!options.kind || (options.kind === 'thread' ? item.id.startsWith('thread:') : options.kind === 'knowledge' ? item.id.startsWith('knowledge:') : !item.id.startsWith('thread:') && !item.id.startsWith('knowledge:') && Boolean(parts.conversations.experiencesById?.(scope, [item.id]).length)))
      && withinSearchRange(item.observedAt, options) && (!options.match || matchesSearch(item.summary, query, options)));
    if (options.order === 'newest' || options.order === 'oldest') visible.sort((a, b) => (options.order === 'oldest' ? (Date.parse(a.observedAt) - Date.parse(b.observedAt)) : (Date.parse(b.observedAt) - Date.parse(a.observedAt))) || a.id.localeCompare(b.id));
    return visible.slice(options.offset ?? 0, (options.offset ?? 0) + Math.max(1, Math.min(40, limit)));
  };
  return { available, search, read, sources: (scope, ids, shared) => sources(scope, ids, shared?.experience, shared?.state), readSnapshot, async execute(name, input, context, signal) {
    if (signal?.aborted) return { status: 'cancelled', items: [], sourceIds: [] };
    if (!available(context.scopeKey, context.present)) return { status: 'withheld', items: [], sourceIds: [] };
    let items: TaskMemoryItem[];
    if (name === 'memory.search' && typeof input.query === 'string' && input.query.length <= 2000) {
      const advanced = Object.keys(input).some(key => key !== 'query');
      const options = searchOptions(input);
      if (input.kind !== undefined && !['experience', 'thread', 'knowledge'].includes(String(input.kind))) throw new Error('SEARCH_KIND_INVALID');
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 40)) throw new Error('SEARCH_LIMIT_INVALID');
      items = search(context.scopeKey, input.query, context.present, typeof input.limit === 'number' ? input.limit : 8,
        advanced ? { ...options, ...(input.kind ? { kind: input.kind as 'experience' | 'thread' | 'knowledge' } : {}) } : undefined);
    } else if (name === 'memory.read' && typeof input.id === 'string' && input.id.length <= 240) {
      items = read(context.scopeKey, [input.id], context.present);
    } else throw new Error('TASK_MEMORY_INPUT');
    const sourceIds = sources(context.scopeKey, items.map(item => item.id));
    if (signal?.aborted) return { status: 'cancelled', items: [], sourceIds: [] };
    if (!available(context.scopeKey, context.present) || (sourceIds.length > 0 && !context.observe(sourceIds))) return { status: 'withheld', items: [], sourceIds: [] };
    const fresh = read(context.scopeKey, items.map(item => item.id), context.present);
    if (fresh.length !== items.length || fresh.some((item, index) => JSON.stringify(item) !== JSON.stringify(items[index]))) return { status: 'withheld', items: [], sourceIds: [] };
    return { status: items.length ? 'ready' : 'no_match', items, sourceIds, ...(name === 'memory.search' && Object.keys(input).some(key => key !== 'query') ? { search: { coverage: 'bounded_candidates' as const, candidateLimit: 1200, offset: Number(input.offset ?? 0), limit: Number(input.limit ?? 8) } } : {}) };
  } };
}
