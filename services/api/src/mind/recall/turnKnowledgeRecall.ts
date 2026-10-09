import {
  buildShannonKnowledgePrompt,
  flattenKnowledgeHeadings,
  knowledgeExcerpt,
  memoryControlFor,
  selectKnowledgeSections,
  selectRelevantKnowledge,
  usableShannonKnowledge,
  type CompanionStateSnapshot,
  type SemanticRecallHit,
  type ShannonKnowledgeDocument,
} from '@shannon/cognition';
import type { MemoryModelGateway } from './memoryModels.js';
import type { ShannonKnowledgeStore } from '../memory/memoryPorts.js';
import { conversationStoreOf, MemoryWithholding } from '../memory/memoryPorts.js';
import { fencedRecall, type TreeKnowledgeRecall } from './treeRecall.js';

/** Documents longer than this are navigated by heading instead of projected whole. */
export const LONG_KNOWLEDGE_CHARACTERS = 1_500;

export interface KnowledgeRecallResult {
  ids: readonly string[];
  prompt: string;
  modelCalls: number;
  documents: readonly ShannonKnowledgeDocument[];
}

/** An experience is usable as provenance only while its memory control is active and uncorrected. */
export function isExperienceSourceVisible(snapshot: CompanionStateSnapshot, experienceId: string): boolean {
  const control = memoryControlFor(snapshot, experienceId);
  return !control || (control.status === 'active' && !control.overrideText);
}

/** Knowledge also stops being used while a source turn's reply is withheld, or while its text restates a withheld item. */
export function usableKnowledgeFor(store: ShannonKnowledgeStore, scopeKey: string, snapshot: CompanionStateSnapshot): readonly ShannonKnowledgeDocument[] {
  const usable = usableShannonKnowledge(store.listShannonKnowledge(scopeKey), id => isExperienceSourceVisible(snapshot, id));
  const withholding = new MemoryWithholding(snapshot, conversationStoreOf(store), scopeKey);
  return usable.filter(document => !withholding.withholdsKnowledge(document));
}

/**
 * Read-only knowledge selection for one turn. Deterministic term matching
 * always runs; semantic hits (already filtered to usable documents) may add
 * candidates; one long document may be navigated by a single model call when
 * the per-turn budget allows, otherwise sections are chosen deterministically.
 */
export async function recallShannonKnowledge(input: {
  store: ShannonKnowledgeStore;
  gateway: MemoryModelGateway | null;
  scopeKey: string;
  message: string;
  snapshot: CompanionStateSnapshot;
  semanticHits: readonly SemanticRecallHit[];
  complexTurn: boolean;
  remainingModelCalls: number;
  timeoutMilliseconds: number;
  signal?: AbortSignal;
  /**
   * Syzygy ADR-0008 stage 2, step 8 (`SHANNON_TREE_RECALL`): Jev's beam over the notes' heading trees (and, with the owner alone,
   * her skills and folder) in place of luna's `selectSections`. Absent, this function is what it was.
   */
  tree?: { recall: TreeKnowledgeRecall; ownerAlone: boolean; surface: 'text' | 'voice'; usable?: readonly ShannonKnowledgeDocument[] };
}): Promise<KnowledgeRecallResult> {
  const usable = input.tree?.usable ?? usableKnowledgeFor(input.store, input.scopeKey, input.snapshot);
  if (input.tree) return treeKnowledge(input, usable, input.tree);
  if (!usable.length) return { ids: [], prompt: '', modelCalls: 0, documents: [] };
  const byId = new Map(usable.map(document => [document.id, document]));
  const semantic = input.semanticHits
    .filter(hit => hit.id.startsWith('knowledge:') && hit.relevance >= 0.5)
    .flatMap(hit => byId.get(hit.id.slice('knowledge:'.length)) ?? []);
  const selected = [...new Map([...selectRelevantKnowledge(input.message, usable), ...semantic]
    .map(document => [document.id, document])).values()].slice(0, 3);
  let modelCalls = 0;
  const items = [];
  for (const document of selected) {
    const navigable = document.headings.length > 0
      && (document.bodyMarkdown.length > LONG_KNOWLEDGE_CHARACTERS || input.complexTurn);
    let sections = navigable ? selectKnowledgeSections(input.message, document) : [];
    if (navigable && input.gateway && modelCalls < input.remainingModelCalls) {
      modelCalls += 1;
      try {
        const deadline = AbortSignal.timeout(input.timeoutMilliseconds);
        const chosen = await input.gateway.selectSections(input.scopeKey, input.message, outline(document),
          input.signal ? AbortSignal.any([input.signal, deadline]) : deadline);
        if (chosen.length) sections = chosen;
      } catch {
        // Navigation failure keeps the deterministic section choice.
      }
    }
    const dates = input.store.experienceObservedAt(input.scopeKey, document.sourceExperienceIds);
    items.push({
      document,
      excerpt: knowledgeExcerpt(document, sections),
      sourceDates: [...new Set([...dates.values()].map(value => value.slice(0, 10)))].sort(),
    });
  }
  return {
    ids: selected.map(document => `knowledge:${document.id}`),
    prompt: buildShannonKnowledgePrompt(items),
    modelCalls,
    documents: selected,
  };
}

/** Tree recall's path: the notes chosen as before, Jev's beam for their sections and for what else helps, one fenced block. */
async function treeKnowledge(input: Parameters<typeof recallShannonKnowledge>[0], usable: readonly ShannonKnowledgeDocument[],
  tree: NonNullable<Parameters<typeof recallShannonKnowledge>[0]['tree']>): Promise<KnowledgeRecallResult> {
  const byId = new Map(usable.map(document => [document.id, document]));
  const semantic = input.semanticHits
    .filter(hit => hit.id.startsWith('knowledge:') && hit.relevance >= 0.5)
    .flatMap(hit => byId.get(hit.id.slice('knowledge:'.length)) ?? []);
  const selected = [...new Map([...selectRelevantKnowledge(input.message, usable), ...semantic].map(document => [document.id, document])).values()].slice(0, 3);
  // The beam walks the chosen notes first, then the rest by recency (at most twenty notes).
  const walked = [...new Map([...selected, ...[...usable].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))].map(document => [document.id, document])).values()].slice(0, 20);
  const found = await tree.recall.recall({ scopeKey: input.scopeKey, message: input.message, documents: walked, ownerAlone: tree.ownerAlone, surface: tree.surface,
    ...(input.signal ? { signal: input.signal } : {}) });
  const documents = [...new Map([...selected, ...(found?.documents ?? [])].map(document => [document.id, document])).values()].slice(0, 4);
  const items = documents.map(document => {
    const navigable = document.headings.length > 0 && (document.bodyMarkdown.length > LONG_KNOWLEDGE_CHARACTERS || input.complexTurn);
    const chosen = found?.sections.get(document.id);
    const sections = chosen?.length ? chosen : navigable ? selectKnowledgeSections(input.message, document) : [];
    const dates = input.store.experienceObservedAt(input.scopeKey, document.sourceExperienceIds);
    return { document, excerpt: knowledgeExcerpt(document, sections), sourceDates: [...new Set([...dates.values()].map(value => value.slice(0, 10)))].sort() };
  });
  return {
    ids: documents.map(document => `knowledge:${document.id}`),
    prompt: fencedRecall(buildShannonKnowledgePrompt(items), found ?? { skills: [], folder: [] }),
    modelCalls: 0,
    documents,
  };
}

function outline(document: ShannonKnowledgeDocument): Array<{ id: string; path: string; preview: string }> {
  const nodes = flattenKnowledgeHeadings(document.headings);
  const parents = new Map<string, string>();
  const walk = (list: typeof document.headings, prefix: string) => {
    for (const node of list) {
      parents.set(node.id, prefix ? `${prefix} > ${node.title}` : node.title);
      walk(node.children, parents.get(node.id)!);
    }
  };
  walk(document.headings, '');
  return nodes.map(node => ({
    id: node.id,
    path: parents.get(node.id) ?? node.title,
    preview: document.bodyMarkdown.slice(node.start, node.end).replace(/^#+[^\n]*\n?/u, '').replace(/\s+/gu, ' ').trim(),
  }));
}
