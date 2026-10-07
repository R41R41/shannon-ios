import { normalizeKnowledgeDraft } from '@shannon/cognition';
import { configuredBackgroundBudgetUsd, utcMonthKey } from '../../infra/models/llmUsage.js';
import {
  SKILL_CAPACITY, SKILL_LIFECYCLE, type SkillBodyCheck, type SkillDocument, type SkillMemory, type SkillPatch, type SkillRejection, type StoredPattern,
} from '../memory/memoryPorts.js';
import { MAINTAINER_INSTRUCTIONS, PROPOSER_INSTRUCTIONS } from './skillSleepRules.js';
import type { SkillSleepModel } from './skillSleepModel.js';

/**
 * The skill sleep (Syzygy ADR-0008 stage 2, step 6; `docs/skill-and-routing-contract.md`, 「スキル記憶」), after WikiSkill's three
 * layers and with Hermes Agent's review rules (`skillSleepRules.ts`). Core: memory. It runs after knowledge consolidation, after
 * each completed sleep batch, inside the shared background budget, and never fails the batch.
 *
 * 1. **Model-free, every night.** Uses that waited for the owner's next turn are settled from G alone; a skill or a page built
 *    from something the owner had her forget is retired or deprecated; trials are judged (accepted, or reverted with a safety
 *    snapshot first) and skills that keep failing retire. The raw experience is only read.
 * 2. **The maintainer** (one call): root-cause analysis of the day's failed episodes and the strategies of its successful ones,
 *    as incremental edits of the pattern wiki (create, patch, append, merge, deprecate; at most six a night). Pages never reach
 *    a turn: giving raw patterns to the acting model made it worse in WikiSkill.
 * 3. **The proposer** (ReAct, up to three runs a night): it starts from the pattern index, opens the pages it needs, and proposes
 *    one skill change (a targeted patch by default, or a new skill), which starts a trial; at most two new and three patched a
 *    night. A change the audit saw reverted is refused, and so is any write to the owner's version or a pinned skill.
 *
 * Every page and body passes the check it is handed (what the owner said is 内緒, what he marked 機微 by hand, what he had her
 * forget, and what must reach nobody but him), a copy check against the day's turns, and an injection scan, before it is stored.
 * It is handed its sources as functions (the wiring builds them over the stores), so it opens nothing itself.
 */
export interface SkillSeedSources {
  /** Her usable knowledge that is a confirmed procedure or lesson. */
  knowledge(scopeKey: string): readonly { id: string; title: string; applicability: string; body: string }[];
  /** The turns of the window the owner had with her alone, visible, not secret: their summary (for the model) and text (for the copy check). */
  experiences(scopeKey: string, startAt: string, endAt: string): readonly { id: string; observedAt: string; summary: string; text: string }[];
  /** Her settled choices of the window, as closed values. */
  choices(scopeKey: string, startAt: string, endAt: string): readonly SeedChoice[];
  /** Whether an experience is still visible (not forgotten); a skill or a page built from one that is not is retired or deprecated. */
  visible(scopeKey: string): (experienceId: string) => boolean;
  /** What a body must not carry; null when it cannot be read now (then nothing is written). */
  check(scopeKey: string): SkillBodyCheck | null;
}

export interface SeedChoice {
  choiceId?: string; choice: string; surface: string; subjectKind: string | null; subjectId: string | null; chosenAt: string; status: string;
  growth: number | null; serve: number | null; reward: number | null; settleCode?: string | null;
}

export interface SkillSleepModels { maintainer: SkillSleepModel | null; proposer: SkillSleepModel | null }

export interface SkillConsolidationResult {
  status: 'unavailable' | 'disabled' | 'idle' | 'budget' | 'applied';
  settled: number; accepted: number; reverted: number; retired: number;
  patterns: { created: number; edited: number; merged: number; deprecated: number };
  created: number; updated: number; rejected: number;
  rejections: readonly SkillRejection[];
}

/** An episode is two to six choices of one Talk (or of her own time within half an hour of each other). */
const SEQUENCE_GAP_MS = 30 * 60_000;
const PROPOSER_ROUNDS = 3;

export class ShannonSkillConsolidator {
  private readonly budgetUsd: number;

  constructor(
    private readonly skills: SkillMemory,
    private readonly sources: SkillSeedSources,
    private readonly models: SkillSleepModels,
    private readonly usage: { backgroundLlmCostUsd(monthKey: string): number },
    private readonly options: { backgroundBudgetUsd?: number; now?: () => string; log?: (line: string) => void } = {},
  ) {
    this.budgetUsd = options.backgroundBudgetUsd ?? configuredBackgroundBudgetUsd();
  }

  async consolidate(scopeKey: string, startAt: string, endAt: string): Promise<SkillConsolidationResult> {
    const result = {
      status: 'idle' as SkillConsolidationResult['status'], settled: 0, accepted: 0, reverted: 0, retired: 0,
      patterns: { created: 0, edited: 0, merged: 0, deprecated: 0 }, created: 0, updated: 0, rejected: 0, rejections: [] as SkillRejection[],
    };
    const reject = (why: SkillRejection) => { result.rejected += 1; result.rejections.push(why); };
    if (!this.skills.ready()) return { ...result, status: 'unavailable' };
    const at = this.options.now?.() ?? new Date().toISOString();
    const finish = (status: SkillConsolidationResult['status']) => { result.status = status; this.log(scopeKey, result); return result; };

    // 1. Model-free.
    result.settled = this.skills.settleUses(scopeKey, at);
    const visible = this.sources.visible(scopeKey);
    const forgotten = (sources: readonly string[]) => sources.some(source => source.startsWith('experience:') && !visible(source.slice('experience:'.length)));
    for (const skill of this.skills.store.all(scopeKey)) if (forgotten(skill.sources) && this.skills.retire(scopeKey, skill.skillId, 'source_forgotten', at)) result.retired += 1;
    for (const page of this.skills.patterns(scopeKey)) if (forgotten(page.sources) && this.skills.deprecatePattern(scopeKey, page.patternId, null, at)) result.patterns.deprecated += 1;
    const lifecycle = this.skills.lifecycle(scopeKey, at);
    result.accepted = lifecycle.accepted.length;
    result.reverted = lifecycle.reverted.length;
    result.retired += lifecycle.retired.length;
    if (!this.models.maintainer && !this.models.proposer) return finish('disabled');
    const check = safe(() => this.sources.check(scopeKey), null);
    const affordable = () => this.usage.backgroundLlmCostUsd(utcMonthKey(new Date(at))) < this.budgetUsd;
    const made = this.skills.madeToday(scopeKey, at);

    // 2. The maintainer of the pattern wiki.
    const seeds = this.seeds(scopeKey, startAt, endAt);
    const editsLeft = Math.max(0, SKILL_LIFECYCLE.patternEditsPerNight - made.patternEdits);
    let applied = false;
    if (this.models.maintainer && editsLeft > 0 && seeds.list.length) {
      if (!affordable()) return finish('budget');
      applied = true;
      await this.maintain(scopeKey, seeds, editsLeft, check, at, result, reject);
    }

    // 3. The proposer, from the pattern index.
    const limits = { create: Math.max(0, SKILL_LIFECYCLE.newPerNight - made.created), update: Math.max(0, SKILL_LIFECYCLE.updatesPerNight - made.updated) };
    if (this.models.proposer && this.skills.patterns(scopeKey).length) {
      for (let run = 0; run < SKILL_LIFECYCLE.proposerRuns && (limits.create > 0 || limits.update > 0); run += 1) {
        if (!affordable()) return finish(applied ? 'applied' : 'budget');
        applied = true;
        const proposed = await this.propose(scopeKey, limits, check, seeds.texts, at, reject);
        if (proposed === 'none') break;
        if (proposed === 'created') { limits.create -= 1; result.created += 1; }
        if (proposed === 'updated') { limits.update -= 1; result.updated += 1; }
      }
    }
    return finish(applied ? 'applied' : 'idle');
  }

  private async maintain(scopeKey: string, seeds: ReturnType<ShannonSkillConsolidator['seeds']>, limit: number, check: SkillBodyCheck | null, at: string,
    result: { patterns: SkillConsolidationResult['patterns'] }, reject: (why: SkillRejection) => void): Promise<void> {
    const pages = this.skills.patterns(scopeKey);
    const answer = await this.models.maintainer!.json(scopeKey, 'shannon_pattern_operations', MAINTAINER_INSTRUCTIONS, {
      evidence: seeds.list.map(seed => ({ id: seed.id, kind: seed.kind, text: seed.text })),
      pages: pages.slice(-30).map(page => ({ id: page.patternId, version: page.version, kind: page.kind, title: page.title, body: page.body.slice(0, 600) })),
      limit,
    }, MAINTAINER_SCHEMA) as { operations?: unknown };
    const operations = Array.isArray(answer.operations) ? answer.operations.filter(isPatternOperation).slice(0, limit) : [];
    for (const operation of operations) {
      const cited = operation.evidence.flatMap(id => seeds.byId.get(id) ?? []);
      const sources = cited.map(seed => seed.source);
      if (operation.operation !== 'deprecate' && copiesConversation(`${operation.title}\n${operation.text}`, seeds.texts)) { reject('copied'); continue; }
      if (operation.operation === 'create') {
        if (!cited.length) { reject('uncited'); continue; }
        const made = this.skills.createPattern(scopeKey, { kind: operation.kind === 'failure' ? 'failure' : 'strategy', title: operation.title, body: operation.text }, sources, check, at);
        if ('rejected' in made) reject(made.rejected); else result.patterns.created += 1;
      } else if (operation.operation === 'patch' || operation.operation === 'append') {
        const edited = this.skills.editPattern(scopeKey, operation.patternId, operation.expectedVersion,
          { operation: operation.operation, ...(operation.title ? { title: operation.title } : {}), text: operation.text }, sources, check, at);
        if ('rejected' in edited) reject(edited.rejected); else result.patterns.edited += 1;
      } else if (operation.operation === 'merge') {
        const merged = this.skills.mergePatterns(scopeKey, operation.patternId, operation.mergeIds, { title: operation.title, body: operation.text }, check, at);
        if ('rejected' in merged) reject(merged.rejected); else result.patterns.merged += 1;
      } else if (this.skills.deprecatePattern(scopeKey, operation.patternId, operation.mergeIds[0] ?? null, at)) result.patterns.deprecated += 1;
      else reject('not_found');
    }
  }

  /** One ReAct run of the proposer: open pages, then one change (or none). */
  private async propose(scopeKey: string, limits: { create: number; update: number }, check: SkillBodyCheck | null, texts: readonly string[], at: string,
    reject: (why: SkillRejection) => void): Promise<'created' | 'updated' | 'rejected' | 'none'> {
    const opened = new Map<string, StoredPattern>();
    for (let round = 1; round <= PROPOSER_ROUNDS; round += 1) {
      const pages = this.skills.patterns(scopeKey);
      const skills = this.skills.store.all(scopeKey);
      const answer = await this.models.proposer!.json(scopeKey, 'shannon_skill_proposal', PROPOSER_INSTRUCTIONS, {
        round, rounds: PROPOSER_ROUNDS, limits,
        capacity: { used: skills.length, limit: SKILL_CAPACITY },
        patternIndex: pages.map(page => ({ id: page.patternId, kind: page.kind, title: page.title })),
        skills: skills.map(skill => {
          const resolved = skill.uses.filter(use => use.o !== null);
          return { id: skill.skillId, version: skill.version, name: skill.name, description: skill.description, status: skill.status,
            editable: skill.madeBy !== 'owner_edit' && !skill.pinned && skill.status !== 'trial', purposes: skill.purposePatternIds,
            uses: skill.uses.length, successes: resolved.filter(use => use.o === 1).length, body: skill.body.slice(0, 1_500) };
        }),
        reverted: this.skills.store.audits(scopeKey).filter(entry => entry.status === 'reverted').slice(-12)
          .map(entry => ({ target: entry.target, purposes: entry.purposePatternIds, diff: entry.diff.slice(0, 300) })),
        opened: [...opened.values()].map(page => ({ id: page.patternId, kind: page.kind, title: page.title, body: page.body })),
      }, PROPOSER_SCHEMA) as Partial<ProposerAnswer>;
      if (!isProposerAnswer(answer)) return 'none';
      if (answer.action === 'open' && round < PROPOSER_ROUNDS) {
        for (const id of answer.open.slice(0, 4)) { const page = pages.find(item => item.patternId === id); if (page) opened.set(id, page); }
        continue;
      }
      if (answer.action !== 'propose') return 'none';
      const purposes = answer.purposePatternIds.filter(id => pages.some(page => page.patternId === id));
      if (!purposes.length) { reject('no_purpose'); return 'rejected'; }
      // A skill's evidence is its pages' own evidence (so forgetting reaches it) and the pages themselves.
      const evidence = [...new Set([...purposes.map(id => `pattern:${id}`), ...purposes.flatMap(id => pages.find(page => page.patternId === id)!.sources)])];
      const draft: SkillDocument = { name: answer.name, description: answer.description, steps: answer.steps, aids: answer.aids, references: answer.references };
      if (copiesConversation([draft.steps, draft.aids, draft.references, ...answer.replacements.map(item => item.replace)].join('\n'), texts)) { reject('copied'); return 'rejected'; }
      if (answer.operation === 'create') {
        if (limits.create <= 0) { reject('over_limit'); return 'rejected'; }
        const made = this.skills.create(scopeKey, { draft, evidence, purposePatternIds: purposes, consolidates: answer.consolidates }, check, at);
        if ('rejected' in made) { reject(made.rejected); return 'rejected'; }
        return 'created';
      }
      if (limits.update <= 0) { reject('over_limit'); return 'rejected'; }
      const patch: SkillPatch = answer.replacements.length ? { replacements: answer.replacements, evidence, purposePatternIds: purposes } : { draft, evidence, purposePatternIds: purposes };
      const revised = this.skills.revise(scopeKey, answer.skillId, answer.expectedVersion, patch, check, at);
      if ('rejected' in revised) { reject(revised.rejected); return 'rejected'; }
      return 'updated';
    }
    return 'none';
  }

  private seeds(scopeKey: string, startAt: string, endAt: string) {
    const list: Array<{ id: string; kind: 'failure' | 'success' | 'knowledge' | 'experience'; text: string; source: string }> = [];
    const choices = safe(() => this.sources.choices(scopeKey, startAt, endAt), []);
    for (const [index, episode] of failedEpisodes(choices).slice(0, 12).entries()) {
      list.push({ id: `f${index + 1}`, kind: 'failure', source: episode.source,
        text: `${episode.surface === 'autonomy' ? 'ひとりの時間' : '会話'}で ${episode.steps.map(step => `${step.choice}${step.ok ? '' : `（失敗${step.code ? `: ${step.code}` : ''}）`}`).join(' → ')}（${episode.count}回）` });
    }
    for (const [index, sequence] of successfulSequences(choices).slice(0, 12).entries()) {
      list.push({ id: `s${index + 1}`, kind: 'success', source: `sequence:${sequence.symbols.join('>').slice(0, 150)}`,
        text: `${sequence.surface === 'autonomy' ? 'ひとりの時間' : '会話'}で ${sequence.symbols.join(' → ')} がうまくいった（${sequence.count}回）` });
    }
    for (const [index, item] of safe(() => this.sources.knowledge(scopeKey), []).slice(0, 12).entries()) {
      list.push({ id: `k${index + 1}`, kind: 'knowledge', source: `knowledge:${item.id}`, text: `${item.title}（${item.applicability}）\n${item.body.slice(0, 600)}` });
    }
    const experiences = safe(() => this.sources.experiences(scopeKey, startAt, endAt), []).slice(-40);
    for (const [index, item] of experiences.entries()) {
      list.push({ id: `e${index + 1}`, kind: 'experience', source: `experience:${item.id}`, text: item.summary.slice(0, 400) });
    }
    return { list, byId: new Map(list.map(seed => [seed.id, seed])), texts: experiences.map(item => item.text) };
  }

  private log(scopeKey: string, result: SkillConsolidationResult): void {
    (this.options.log ?? (line => console.log(line)))(`Shannon skill sleep: scope=${/^[A-Za-z0-9_:-]{1,80}$/u.test(scopeKey) ? scopeKey : 'other'} status=${result.status} settled=${result.settled} accepted=${result.accepted} reverted=${result.reverted} retired=${result.retired} patterns=${result.patterns.created}/${result.patterns.edited}/${result.patterns.merged}/${result.patterns.deprecated} created=${result.created} updated=${result.updated} rejected=${result.rejected}`);
  }
}

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
    if (run.length && Date.parse(choice.chosenAt) - Date.parse(run.at(-1)!.chosenAt) > SEQUENCE_GAP_MS) { groups.push(run); run = []; }
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
function copiesConversation(text: string, texts: readonly string[]): boolean {
  if (!texts.length || !text.trim()) return false;
  const sources = new Map(texts.map((item, index) => [`t${index}`, item]));
  const normalized = normalizeKnowledgeDraft({ title: '-', applicability: '-', bodyMarkdown: text, status: 'hypothesis', sourceExperienceIds: [...sources.keys()] }, sources);
  return 'rejected' in normalized && normalized.rejected === 'verbatim-conversation';
}

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

interface PatternOperation {
  operation: 'create' | 'patch' | 'append' | 'merge' | 'deprecate'; patternId: string; expectedVersion: number; kind: string; title: string; text: string;
  mergeIds: string[]; evidence: string[];
}

const MAINTAINER_SCHEMA = {
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

function isPatternOperation(value: unknown): value is PatternOperation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['create', 'patch', 'append', 'merge', 'deprecate'].includes(String(row.operation)) && typeof row.patternId === 'string' && typeof row.expectedVersion === 'number'
    && typeof row.kind === 'string' && typeof row.title === 'string' && typeof row.text === 'string'
    && Array.isArray(row.mergeIds) && row.mergeIds.every(id => typeof id === 'string') && Array.isArray(row.evidence) && row.evidence.every(id => typeof id === 'string');
}

interface ProposerAnswer {
  action: 'open' | 'propose' | 'none'; open: string[]; operation: 'create' | 'patch'; skillId: string; expectedVersion: number;
  name: string; description: string; steps: string; aids: string; references: string;
  replacements: Array<{ find: string; replace: string }>; purposePatternIds: string[]; consolidates: string[];
}

const PROPOSER_SCHEMA = {
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

function isProposerAnswer(value: Partial<ProposerAnswer> | null | undefined): value is ProposerAnswer {
  if (!value || typeof value !== 'object') return false;
  const strings = ['skillId', 'name', 'description', 'steps', 'aids', 'references'] as const;
  return ['open', 'propose', 'none'].includes(String(value.action)) && Array.isArray(value.open) && value.open.every(id => typeof id === 'string')
    && (value.operation === 'create' || value.operation === 'patch') && typeof value.expectedVersion === 'number' && strings.every(key => typeof value[key] === 'string')
    && Array.isArray(value.replacements) && value.replacements.every(item => item && typeof item.find === 'string' && typeof item.replace === 'string')
    && Array.isArray(value.purposePatternIds) && value.purposePatternIds.every(id => typeof id === 'string')
    && Array.isArray(value.consolidates) && value.consolidates.every(id => typeof id === 'string');
}
