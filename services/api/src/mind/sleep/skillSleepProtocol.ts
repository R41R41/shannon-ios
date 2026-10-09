import { normalizeKnowledgeDraft } from '@shannon/cognition';
import type { SeedChoice } from './skillConsolidation.js';
const ok = (choice: SeedChoice) => choice.status === 'settled' && (choice.growth ?? 0) >= 2 / 3 && (choice.serve === null || choice.serve >= 0.5);

/** Her choices grouped into episodes: one Talk's in order (a conversation), or her own steps less than half an hour apart. */
function episodes(choices: readonly SeedChoice[]): SeedChoice[][] {
  const groups: SeedChoice[][] = [];
  const talks = new Map<string, SeedChoice[]>();
  const own: SeedChoice[] = [];
  for (const choice of [...choices].sort((left, right) => left.chosenAt.localeCompare(right.chosenAt))) {
    if (choice.status !== 'settled') continue;
    if (choice.subjectKind === 'talk' && choice.subjectId) talks.set(choice.subjectId, [...talks.get(choice.subjectId) ?? [], choice]);
    else if (choice.surface === 'autonomy') own.push(choice);
  }
  groups.push(...talks.values());
  let run: SeedChoice[] = [];
  for (const choice of own) {
    if (run.length && Date.parse(choice.chosenAt) - Date.parse(run.at(-1)!.chosenAt) > (30 * 60_000)) { groups.push(run); run = []; }
    run.push(choice);
  }
  if (run.length) groups.push(run);
  // A Talk's tier choices say how hard a turn was, not what she did: only what she did makes an episode.
  return groups.map(group => group.filter(choice => !choice.choice.startsWith('tier.'))).filter(group => group.length >= 1 && group.length <= 6);
}

/** Sequences of her choices that went well, as closed symbols; the same sequence on several occasions is one seed with its count. */
export function successfulSequences(choices: readonly SeedChoice[]): Array<{ symbols: string[]; surface: string; count: number }> {
  const counted = new Map<string, { symbols: string[]; surface: string; count: number }>();
  for (const steps of episodes(choices)) {
    if (steps.length < 2 || !steps.every(ok)) continue;
    const symbols = steps.map(choice => choice.choice);
    const surface = steps[0]!.surface === 'autonomy' ? 'autonomy' : 'conversation';
    const key = `${surface}|${symbols.join('>')}`;
    counted.set(key, { symbols, surface, count: (counted.get(key)?.count ?? 0) + 1 });
  }
  return [...counted.values()].sort((left, right) => right.count - left.count || left.symbols.join().localeCompare(right.symbols.join()));
}

/** Episodes in which a choice failed (for root-cause analysis), as closed symbols with which step failed and how it was settled. */
export function failedEpisodes(choices: readonly SeedChoice[]): Array<{ steps: Array<{ choice: string; ok: boolean; code: string | null }>; surface: string; count: number; source: string }> {
  const counted = new Map<string, { steps: Array<{ choice: string; ok: boolean; code: string | null }>; surface: string; count: number; source: string }>();
  for (const group of episodes(choices)) {
    if (group.every(ok)) continue;
    const steps = group.map(choice => ({ choice: choice.choice, ok: ok(choice), code: choice.settleCode && /^[a-z_]{1,40}$/u.test(choice.settleCode) ? choice.settleCode : null }));
    const surface = group[0]!.surface === 'autonomy' ? 'autonomy' : 'conversation';
    const key = `${surface}|${steps.map(step => `${step.choice}:${step.ok}`).join('>')}`;
    const failed = group.find(choice => !ok(choice));
    const source = failed?.choiceId ? `choice:${failed.choiceId}` : `sequence:${steps.map(step => step.choice).join('>').slice(0, 150)}`;
    counted.set(key, { steps, surface, count: (counted.get(key)?.count ?? 0) + 1, source: counted.get(key)?.source ?? source });
  }
  return [...counted.values()].sort((left, right) => right.count - left.count);
}

/** Whether a text copies a run of a turn's words (the knowledge notes' check, `normalizeKnowledgeDraft`). */
export function copiesConversation(text: string, texts: readonly string[]): boolean {
  if (!texts.length || !text.trim()) return false;
  const sources = new Map(texts.map((item, index) => [`t${index}`, item]));
  const normalized = normalizeKnowledgeDraft({ title: '-', applicability: '-', bodyMarkdown: text, status: 'hypothesis', sourceExperienceIds: [...sources.keys()] }, sources);
  return 'rejected' in normalized && normalized.rejected === 'verbatim-conversation';
}

export function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

export interface PatternOperation {
  operation: 'create' | 'patch' | 'append' | 'merge' | 'deprecate'; patternId: string; expectedVersion: number; kind: string; title: string; text: string;
  mergeIds: string[]; evidence: string[];
}

export const MAINTAINER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['operations'],
  properties: { operations: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['operation', 'patternId', 'expectedVersion', 'kind', 'title', 'text', 'mergeIds', 'evidence'],
    properties: {
      operation: { type: 'string', enum: ['create', 'patch', 'append', 'merge', 'deprecate'] }, patternId: { type: 'string' }, expectedVersion: { type: 'integer' },
      kind: { type: 'string', enum: ['failure', 'strategy'] }, title: { type: 'string' }, text: { type: 'string' },
      mergeIds: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } },
    },
  } } },
} as const;

export function isPatternOperation(value: unknown): value is PatternOperation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['create', 'patch', 'append', 'merge', 'deprecate'].includes(String(row.operation)) && typeof row.patternId === 'string' && typeof row.expectedVersion === 'number'
    && typeof row.kind === 'string' && typeof row.title === 'string' && typeof row.text === 'string'
    && Array.isArray(row.mergeIds) && row.mergeIds.every(id => typeof id === 'string') && Array.isArray(row.evidence) && row.evidence.every(id => typeof id === 'string');
}

export interface ProposerAnswer {
  action: 'open' | 'propose' | 'none'; open: string[]; operation: 'create' | 'patch'; skillId: string; expectedVersion: number;
  name: string; description: string; steps: string; aids: string; references: string;
  replacements: Array<{ find: string; replace: string }>; purposePatternIds: string[]; consolidates: string[];
}

export const PROPOSER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['action', 'open', 'operation', 'skillId', 'expectedVersion', 'name', 'description', 'steps', 'aids', 'references', 'replacements', 'purposePatternIds', 'consolidates'],
  properties: {
    action: { type: 'string', enum: ['open', 'propose', 'none'] }, open: { type: 'array', items: { type: 'string' } },
    operation: { type: 'string', enum: ['create', 'patch'] }, skillId: { type: 'string' }, expectedVersion: { type: 'integer' },
    name: { type: 'string' }, description: { type: 'string' }, steps: { type: 'string' }, aids: { type: 'string' }, references: { type: 'string' },
    replacements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['find', 'replace'], properties: { find: { type: 'string' }, replace: { type: 'string' } } } },
    purposePatternIds: { type: 'array', items: { type: 'string' } }, consolidates: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function isProposerAnswer(value: Partial<ProposerAnswer> | null | undefined): value is ProposerAnswer {
  if (!value || typeof value !== 'object') return false;
  const strings = ['skillId', 'name', 'description', 'steps', 'aids', 'references'] as const;
  return ['open', 'propose', 'none'].includes(String(value.action)) && Array.isArray(value.open) && value.open.every(id => typeof id === 'string')
    && (value.operation === 'create' || value.operation === 'patch') && typeof value.expectedVersion === 'number' && strings.every(key => typeof value[key] === 'string')
    && Array.isArray(value.replacements) && value.replacements.every(item => item && typeof item.find === 'string' && typeof item.replace === 'string')
    && Array.isArray(value.purposePatternIds) && value.purposePatternIds.every(id => typeof id === 'string')
    && Array.isArray(value.consolidates) && value.consolidates.every(id => typeof id === 'string');
}
