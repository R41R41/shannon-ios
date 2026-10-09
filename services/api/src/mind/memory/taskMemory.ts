import { isOwnerOnly, memoryControlFor, memoryIdentifier, searchMemoryDocuments, visibleMemoryText, type CompanionStateStore, type MemoryAudience } from '@shannon/cognition';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';
import { MemoryWithholding } from './memoryVisibility.js';
import type { ConversationStore } from './conversationContract.js';
import type { ShannonKnowledgeStore } from './store/sqliteShannonKnowledge.js';
import type { TaskMemory, TaskMemoryItem } from './taskMemoryPorts.js';

export interface TaskMemoryParts {
  state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore; ownerScope: string;
  ownerAlone(): boolean; now(): string; knowledge?: Pick<ShannonKnowledgeStore, 'listShannonKnowledge'>;
  readSourceVisible?(scope: string, id: string, observedAt: string): boolean;
}
/** Same canonical store, disclosure and forgetting gates as conversation recall. No cached private text. */
export function createTaskMemory(parts: TaskMemoryParts): TaskMemory {
  const knowledge = parts.knowledge ?? (typeof (parts.conversations as Partial<ShannonKnowledgeStore>).listShannonKnowledge === 'function'
    ? parts.conversations as ConversationStore & ShannonKnowledgeStore : undefined);
  const available = (scope: string, present: MemoryAudience) => scope === parts.ownerScope && isOwnerOnly(present) && parts.ownerAlone();
  const read: TaskMemory['read'] = (scope, ids, present) => {
    if (!available(scope, present)) return [];
    const state = parts.state.snapshot(scope), store = parts.conversations;
    const gate = new DisclosureGate(present, state, store, scope), withheld = new MemoryWithholding(state, store, scope, undefined, parts.readSourceVisible);
    return withheld.withReadSnapshot(() => {
    const canonical = new Map<string, ReturnType<NonNullable<ConversationStore['experiencesById']>>[number] | null>();
    const experienceOf = (id: string) => { if (!canonical.has(id)) canonical.set(id, store.experiencesById?.(scope, [id])[0] ?? null); return canonical.get(id) ?? null; };
    const lineage = new Map<string, boolean>();
    const lineageVisible = (id: string, seen = new Set<string>()): boolean => {
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
        && !(experience.readSourceIds ?? []).some(ref => !parts.readSourceVisible?.(scope, ref, experience.observedAt))
        && (experience.recalledMemoryIds ?? []).every(ref => lineageVisible(ref, seen));
    };
    const items: TaskMemoryItem[] = [];
    for (const id of [...new Set(ids)].slice(0, 40)) {
      let summary: string | undefined, at = '', evidence = '', applicability = 'recorded observation';
      let confidence: number | null = null;
      if (id.startsWith('thread:')) {
        const thread = id.slice(7), lineage = store.threadSummaryLineage?.(scope, thread);
        if (!lineage || !gate.allowsThreadSummary(thread) || withheld.withholdsThreadSummary(thread)) continue;
        summary = store.threadSummary(scope, thread); at = lineage.updatedAt ?? '';
        if (lineage.messages.some(message => message.sourceExperienceId && !lineageVisible(message.sourceExperienceId))) continue;
        applicability = 'conversation summary; original messages remain the evidence';
      } else if (id.startsWith('knowledge:')) {
        const doc = knowledge?.listShannonKnowledge(scope).find(row => row.id === id.slice(10));
        if (!doc || withheld.withholdsKnowledge(doc) || doc.sourceExperienceIds.some(ref => !lineageVisible(ref))) continue;
        summary = `${doc.title}\n${doc.bodyMarkdown}`; at = doc.updatedAt; applicability = doc.applicability; evidence = doc.sourceExperienceIds.join(',');
        if (doc.aetherReferences?.some(ref => !parts.readSourceVisible?.(scope, `aether-document://${encodeURIComponent(ref.documentId)}`, at))) continue;
      } else {
        const experience = experienceOf(id);
        const fact = state.userFacts.find(row => row.id === id) ?? state.relationships.find(row => row.id === id);
        const promise = state.prospectiveMemories.find(row => row.id === id);
        const active = state.activeMemories.find(row => row.id === id);
        const interest = state.interests.find(text => memoryIdentifier('interest', text) === id);
        if (experience) {
          if (!lineageVisible(id)) continue;
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
        confidence, conflicts: [], detailRef: id });
    }
    return items;
    });
  };
  const sources: TaskMemory['sources'] = (scope, ids) => {
    const found = new Set<string>(), pending = [...ids], state = parts.state.snapshot(scope);
    while (pending.length) {
      const id = pending.shift()!; if (found.has(id)) continue;
      found.add(id); if (found.size > 5000) throw new Error('TASK_MEMORY_LINEAGE_LIMIT');
      if (id.startsWith('thread:')) pending.push(...(parts.conversations.threadSummaryLineage?.(scope, id.slice(7))?.messages ?? [])
        .flatMap(message => message.sourceExperienceId ? [message.sourceExperienceId] : []));
      else if (id.startsWith('knowledge:')) pending.push(...(knowledge?.listShannonKnowledge(scope).find(row => row.id === id.slice(10))?.sourceExperienceIds ?? []));
      else {
        const experience = parts.conversations.experiencesById?.(scope, [id])[0];
        if (experience) pending.push(...experience.recalledMemoryIds ?? []);
        const scalar = [...state.userFacts, ...state.relationships, ...state.prospectiveMemories].find(row => row.id === id);
        if (scalar?.sourceExperienceId && !memoryControlFor(state, id)?.overrideText) pending.push(scalar.sourceExperienceId);
      }
    }
    return [...found];
  };
  const search: TaskMemory['search'] = (scope, query, present, limit = 8) => {
    if (!available(scope, present)) return [];
    const state = parts.state.snapshot(scope);
    const candidates = [...state.userFacts, ...state.relationships].map(item => ({ id: item.id, text: item.statement, observedAt: item.observedAt }));
    candidates.push(...state.activeMemories.map(item => ({ id: item.id, text: item.summary, observedAt: state.updatedAt })),
      ...state.interests.map(text => ({ id: memoryIdentifier('interest', text), text, observedAt: state.updatedAt })));
    candidates.push(...state.prospectiveMemories.map(item => ({ id: item.id, text: item.summary, observedAt: item.updatedAt })));
    const ids = [...(parts.conversations.searchMemory?.(scope, query, 40) ?? []).map(hit => hit.id),
      ...searchMemoryDocuments(query, candidates, 20).map(item => item.id)];
    return read(scope, ids, present).slice(0, Math.max(1, Math.min(12, limit)));
  };
  return { available, search, read, sources, async execute(name, input, context, signal) {
    if (signal?.aborted) return { status: 'cancelled', items: [], sourceIds: [] };
    if (!available(context.scopeKey, context.present)) return { status: 'withheld', items: [], sourceIds: [] };
    let items: TaskMemoryItem[];
    if (name === 'memory.search' && typeof input.query === 'string' && input.query.length <= 2000) {
      items = search(context.scopeKey, input.query, context.present);
    } else if (name === 'memory.read' && typeof input.id === 'string' && input.id.length <= 240) {
      items = read(context.scopeKey, [input.id], context.present);
    } else throw new Error('TASK_MEMORY_INPUT');
    const sourceIds = sources(context.scopeKey, items.map(item => item.id));
    if (signal?.aborted) return { status: 'cancelled', items: [], sourceIds: [] };
    if (!available(context.scopeKey, context.present) || (sourceIds.length > 0 && !context.observe(sourceIds))) return { status: 'withheld', items: [], sourceIds: [] };
    const fresh = read(context.scopeKey, items.map(item => item.id), context.present);
    if (fresh.length !== items.length || fresh.some((item, index) => JSON.stringify(item) !== JSON.stringify(items[index]))) return { status: 'withheld', items: [], sourceIds: [] };
    return { status: items.length ? 'ready' : 'no_match', items, sourceIds };
  } };
}
