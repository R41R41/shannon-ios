import { buildMemorySearchPlan, scoreMemorySearchText } from './memorySearch.js';

/**
 * Shannon's own derived knowledge (procedures, lessons, hypotheses). It is
 * internal to Shannon, never a user-confirmed fact, and ranks below explicit
 * user statements, Aether decisions, and the user profile.
 */
export type ShannonKnowledgeStatus = 'hypothesis' | 'confirmed' | 'retired';

/** Reference to an Aether section by identity and version only; Aether text is never copied. */
export interface AetherDecisionReference {
  documentId: string;
  version: number;
  sectionId?: string;
  decisionId?: string;
}

export interface KnowledgeHeadingNode {
  id: string;
  level: number;
  title: string;
  /** Character offsets of the section body inside the Markdown document. */
  start: number;
  end: number;
  children: readonly KnowledgeHeadingNode[];
}

export interface ShannonKnowledgeDocument {
  id: string;
  title: string;
  bodyMarkdown: string;
  headings: readonly KnowledgeHeadingNode[];
  status: ShannonKnowledgeStatus;
  applicability: string;
  sourceExperienceIds: readonly string[];
  aetherReferences: readonly AetherDecisionReference[];
  retiredReason?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export const SHANNON_KNOWLEDGE_LIMITS = Object.freeze({
  title: 120,
  applicability: 400,
  body: 8_000,
  sources: 40,
  aetherReferences: 20,
  /** A shared span this long with a source utterance counts as copied conversation text. */
  verbatimSpan: 24,
});

export function parseKnowledgeHeadingTree(markdown: string): readonly KnowledgeHeadingNode[] {
  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)].map((match, index) => ({
    id: `h${index + 1}`,
    level: match[1]!.length,
    title: match[2]!.trim().slice(0, 200),
    start: match.index!,
  }));
  type MutableNode = { id: string; level: number; title: string; start: number; end: number; children: MutableNode[] };
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];
  headings.forEach((heading, index) => {
    const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
    const node: MutableNode = { ...heading, end: next?.start ?? markdown.length, children: [] };
    while (stack.length && stack.at(-1)!.level >= node.level) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  });
  const freeze = (node: MutableNode): KnowledgeHeadingNode => Object.freeze({ ...node, children: Object.freeze(node.children.map(freeze)) });
  return Object.freeze(roots.map(freeze));
}

export function flattenKnowledgeHeadings(nodes: readonly KnowledgeHeadingNode[]): readonly KnowledgeHeadingNode[] {
  return nodes.flatMap(node => [node, ...flattenKnowledgeHeadings(node.children)]);
}

export interface KnowledgeDraft {
  title: string;
  bodyMarkdown: string;
  status: Exclude<ShannonKnowledgeStatus, 'retired'>;
  applicability: string;
  sourceExperienceIds: readonly string[];
  aetherReferences?: readonly AetherDecisionReference[];
}

export type KnowledgeDraftRejection =
  | 'missing-source' | 'unknown-source' | 'empty' | 'too-long' | 'verbatim-conversation' | 'secret-like';

/**
 * Safety gate for every write. A draft must cite visible source experiences,
 * must not copy conversation text or secrets, and a single-source success is
 * always stored as a hypothesis.
 */
export function normalizeKnowledgeDraft(
  draft: KnowledgeDraft,
  sources: ReadonlyMap<string, string>,
): { draft: KnowledgeDraft } | { rejected: KnowledgeDraftRejection } {
  const ids = [...new Set(draft.sourceExperienceIds.map(id => id.trim()).filter(Boolean))].slice(0, SHANNON_KNOWLEDGE_LIMITS.sources);
  if (!ids.length) return { rejected: 'missing-source' };
  if (ids.some(id => !sources.has(id))) return { rejected: 'unknown-source' };
  const title = draft.title.trim();
  const body = draft.bodyMarkdown.trim();
  const applicability = draft.applicability.trim();
  if (!title || !body || !applicability) return { rejected: 'empty' };
  if (title.length > SHANNON_KNOWLEDGE_LIMITS.title || body.length > SHANNON_KNOWLEDGE_LIMITS.body
    || applicability.length > SHANNON_KNOWLEDGE_LIMITS.applicability) return { rejected: 'too-long' };
  const written = `${title}\n${applicability}\n${body}`;
  if (looksSecret(written)) return { rejected: 'secret-like' };
  if (ids.some(id => sharesVerbatimSpan(written, sources.get(id)!, SHANNON_KNOWLEDGE_LIMITS.verbatimSpan))) {
    return { rejected: 'verbatim-conversation' };
  }
  const references = (draft.aetherReferences ?? []).filter(reference => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(reference.documentId)
    && Number.isSafeInteger(reference.version) && reference.version >= 1).slice(0, SHANNON_KNOWLEDGE_LIMITS.aetherReferences)
    .map(reference => Object.freeze({
      documentId: reference.documentId, version: reference.version,
      ...(reference.sectionId ? { sectionId: reference.sectionId } : {}),
      ...(reference.decisionId ? { decisionId: reference.decisionId } : {}),
    }));
  return { draft: Object.freeze({
    title, bodyMarkdown: body, applicability, sourceExperienceIds: Object.freeze(ids),
    aetherReferences: Object.freeze(references),
    // One observed success is a hypothesis; confirmation needs two distinct source experiences.
    status: draft.status === 'confirmed' && ids.length >= 2 ? 'confirmed' : 'hypothesis',
  }) };
}

function looksSecret(text: string): boolean {
  return /(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/u.test(text)
    || /(?:パスワード|password|api[ _-]?key|トークン)\s*[:：=は]\s*\S{6,}/iu.test(text);
}

/** Each source line (utterance or reply) is checked separately; a short line is caught when copied whole. */
function sharesVerbatimSpan(text: string, source: string, maximumSpan: number): boolean {
  const compact = (value: string) => value.normalize('NFKC').replace(/[\s、。，．,.!！?？]+/gu, '');
  const haystack = compact(text);
  return source.split('\n').some(line => {
    const needle = compact(line);
    if (needle.length < 10) return false;
    const span = Math.min(maximumSpan, needle.length);
    for (let index = 0; index + span <= needle.length; index += Math.max(1, Math.floor(span / 3))) {
      if (haystack.includes(needle.slice(index, index + span))) return true;
    }
    return haystack.includes(needle.slice(-span));
  });
}

/**
 * Knowledge usable for generation and search: not retired, every source
 * experience still visible (forgetting any source suppresses the document),
 * and no Aether reference older than the known current version.
 */
export function usableShannonKnowledge(
  documents: readonly ShannonKnowledgeDocument[],
  isSourceVisible: (experienceId: string) => boolean,
  currentAetherVersion: (documentId: string) => number | undefined = () => undefined,
): readonly ShannonKnowledgeDocument[] {
  return documents.filter(document => document.status !== 'retired'
    && document.sourceExperienceIds.length > 0
    && document.sourceExperienceIds.every(isSourceVisible)
    && document.aetherReferences.every(reference => {
      const current = currentAetherVersion(reference.documentId);
      return current === undefined || current <= reference.version;
    }));
}

export function selectRelevantKnowledge(
  query: string,
  documents: readonly ShannonKnowledgeDocument[],
  maximum = 3,
  minimumScore = 0.34,
): readonly ShannonKnowledgeDocument[] {
  const plan = buildMemorySearchPlan(query);
  return documents
    .map(document => ({ document, score: Math.max(
      scoreMemorySearchText(plan, `${document.title}\n${document.applicability}`),
      scoreMemorySearchText(plan, document.bodyMarkdown) * 0.8,
    ) }))
    .filter(row => row.score >= minimumScore)
    .sort((left, right) => right.score - left.score || right.document.updatedAt.localeCompare(left.document.updatedAt))
    .slice(0, Math.max(0, maximum))
    .map(row => row.document);
}

/** Deterministic section choice used when no model call is available for tree navigation. */
export function selectKnowledgeSections(query: string, document: ShannonKnowledgeDocument, maximum = 2): readonly string[] {
  const plan = buildMemorySearchPlan(query);
  return flattenKnowledgeHeadings(document.headings)
    .map(node => ({ node, score: scoreMemorySearchText(plan, `${node.title}\n${document.bodyMarkdown.slice(node.start, node.end)}`) }))
    .filter(row => row.score > 0)
    .sort((left, right) => right.score - left.score || left.node.start - right.node.start)
    .slice(0, maximum)
    .map(row => row.node.id);
}

export function knowledgeExcerpt(document: ShannonKnowledgeDocument, sectionIds: readonly string[] = [], maximumCharacters = 900): string {
  const nodes = flattenKnowledgeHeadings(document.headings).filter(node => sectionIds.includes(node.id));
  const text = nodes.length
    ? nodes.map(node => document.bodyMarkdown.slice(node.start, node.end).trim()).join('\n\n')
    : document.bodyMarkdown;
  return text.length > maximumCharacters ? `${text.slice(0, maximumCharacters - 1)}…` : text;
}

export interface KnowledgePromptItem {
  document: ShannonKnowledgeDocument;
  excerpt: string;
  /** Dates of the source experiences, for citation. */
  sourceDates: readonly string[];
}

/**
 * Prompt projection. Knowledge is labelled as Shannon's own working notes,
 * placed after every higher-authority source, and hypotheses are marked as
 * unconfirmed so they are never voiced as user facts.
 */
export function buildShannonKnowledgePrompt(items: readonly KnowledgePromptItem[], maximumCharacters = 2_400): string {
  if (!items.length) return '';
  const header = [
    '[Shannon private knowledge — lowest authority]',
    'These are Shannon\'s own derived notes (procedures, lessons, hypotheses). ユーザーが確定した事実ではない。',
    'Authority order: the user\'s explicit words in this conversation > Aether decisions > the user profile > these notes. If a note disagrees with a higher source, follow the higher source and treat the note as outdated.',
    'Never present a note as something the user said or confirmed. A [仮説] note must be phrased as a tentative idea, not a fact. Check its applicability before using it.',
  ].join('\n');
  let prompt = header;
  for (const item of items) {
    const label = item.document.status === 'confirmed' ? '[確認済みの手順・教訓]' : '[仮説]';
    const entry = [
      `- ${label} ${item.document.title} (id: knowledge:${item.document.id}; v${item.document.version})`,
      `  適用条件: ${item.document.applicability}`,
      `  出典: 会話 ${item.sourceDates.slice(0, 4).join(', ') || '日付不明'}${item.document.aetherReferences.length ? ` / Aether ${item.document.aetherReferences.map(reference => `${reference.documentId}@v${reference.version}`).join(', ')}` : ''}`,
      ...item.excerpt.split('\n').map(line => `  ${line}`),
    ].join('\n');
    if (prompt.length + entry.length + 1 > maximumCharacters) break;
    prompt += `\n${entry}`;
  }
  return prompt;
}

/** Owner inquiry such as 「〇〇について何を覚えてる？」. */
export function isMemoryInquiry(text: string): boolean {
  return /(?:について|のこと(?:は|で)?|に関して)(?:何|なに)を?(?:覚えて|おぼえて|知って)|(?:何|なに)を(?:覚えて|おぼえて)(?:る|いる)|覚えてること/u
    .test(text.normalize('NFKC'));
}

/** Follow-up that forgets exactly what Shannon cited in its previous inquiry answer. */
export function isForgetCitedMemoriesCommand(text: string): boolean {
  return /^(?:それ|それら|それ全部|今の|いまの|その記憶|今の記憶|その話)(?:は|を|も)?(?:全部)?忘れて(?:ください|ほしい|くれる)?[。！!]?$/u.test(text.trim());
}
