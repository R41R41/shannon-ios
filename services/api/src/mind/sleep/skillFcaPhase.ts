import type { StoredPattern, SkillBodyCheck, SkillMemory, SkillRejection } from '../memory/memoryPorts.js';
import { SKILL_LIFECYCLE } from '../memory/memoryPorts.js';
import { utcMonthKey } from '../../infra/models/llmUsage.js';
import type { SkillSeedSources, SkillSleepModels } from './skillConsolidation.js';
import { MAINTAINER_INSTRUCTIONS, PROPOSER_INSTRUCTIONS } from './skillSleepRules.js';
import { MAINTAINER_SCHEMA, PROPOSER_SCHEMA, isProposerAnswer, type ProposerAnswer } from './skillSleepProtocol.js';
import type { SleepFcaPhaseHandler } from './sleepFcaPorts.js';

type Base = { revisionId: string; version: number; body: string; uses: number; successes: number };
type Seed = { id: string; kind: 'failure' | 'success' | 'knowledge' | 'experience'; text: string; source: string };
type Seeds = { list: Seed[]; byId: Map<string, Seed>; texts: string[] };
type Counts = { created: number; edited: number; merged: number; deprecated: number };
export interface SkillFcaState {
  version: 1; stage: 'lifecycle' | 'maintain' | 'propose'; run: number; round: number;
  opened: readonly { id: string; version: number }[];
  bases: readonly { id: string; revisionId: string }[];
}
export interface SkillFcaOptions {
  /** Persist the source lineage before any content derived from it reaches a model. */
  observeSources(sources: readonly string[]): boolean;
}
export interface SkillFcaParts {
  skills: SkillMemory; sources: SkillSeedSources; models: SkillSleepModels; budgetUsd: number; now(): string;
  seeds(scope: string, start: string, end: string): Seeds;
  revertedSources(scope: string): readonly string[];
  bases(scope: string): Map<string, Base>;
  proposerInput(scope: string, round: number, limits: { create: number; update: number }, opened: ReadonlyMap<string, StoredPattern>, bases: Map<string, Base>): unknown;
  applyMaintenance(answer: { operations?: unknown }, scope: string, seeds: Seeds, limit: number, check: SkillBodyCheck | null, at: string,
    result: { patterns: Counts }, reject: (why: SkillRejection) => void): void;
  applyProposal(answer: ProposerAnswer, scope: string, limits: { create: number; update: number }, check: SkillBodyCheck | null, texts: readonly string[],
    at: string, reject: (why: SkillRejection) => void, bases: Map<string, Base>): 'created' | 'updated' | 'rejected';
}
interface Planned {
  kind: 'lifecycle' | 'maintain' | 'propose' | 'done'; state: SkillFcaState; at: string; sources: string[];
  answer?: unknown; seeds?: Seeds; bases?: Map<string, Base>; limit?: number;
  pages?: readonly { id: string; version: number }[];
}
const initial = (): SkillFcaState => ({ version: 1, stage: 'lifecycle', run: 1, round: 1, opened: [], bases: [] });
const nextRun = (state: SkillFcaState): SkillFcaState => ({ ...state, run: state.run + 1, round: 1, opened: [], bases: [] });
const summary = (operation: string, counts: unknown) => JSON.stringify({ phase: 'skills', operation, counts });

/** A single legacy maintainer/proposer request per FCA decision; open/propose rounds resume from committed state. */
export function createSkillSleepFcaPhase(parts: SkillFcaParts, options: SkillFcaOptions): SleepFcaPhaseHandler {
  const { skills } = parts;
  const limits = (scope: string, at: string) => { const made = skills.madeToday(scope, at); return {
    create: Math.max(0, SKILL_LIFECYCLE.newPerNight - made.created), update: Math.max(0, SKILL_LIFECYCLE.updatesPerNight - made.updated),
    patterns: Math.max(0, SKILL_LIFECYCLE.patternEditsPerNight - made.patternEdits),
  }; };
  const verify = (scope: string, sources: readonly string[]) => {
    const pass = parts.sources.sourcesPass?.(scope);
    const visible = parts.sources.visible(scope);
    if ((pass && !pass(sources)) || sources.some(source => source.startsWith('experience:') && !visible(source.slice(11)))) throw new Error('SKILL_FCA_SOURCE_WITHHELD');
  };
  const expandSources = (scope: string, sources: readonly string[]): string[] => {
    const all = new Set<string>();
    const visit = (source: string) => {
      if (all.has(source)) return;
      all.add(source);
      if (source.startsWith('pattern:')) for (const child of skills.store.pattern(scope, source.slice(8))?.sources ?? []) visit(child);
    };
    sources.forEach(visit); return [...all];
  };
  const observe = (scope: string, sources: readonly string[]) => {
    verify(scope, sources);
    const ids = [...new Set(sources.flatMap(source => /^(experience|knowledge):/u.test(source) ? [source.slice(source.indexOf(':') + 1)] : []))];
    if (!options.observeSources(ids)) throw new Error('SKILL_FCA_SOURCE_FENCED');
  };
  const reserve = (scope: string, role: 'maintainer' | 'proposer', at: string, model: string): boolean => {
    let allowed = false;
    skills.write(at, () => {
      if (skills.sleepUsage.monthCostUsd(utcMonthKey(new Date(at))) >= parts.budgetUsd) return;
      const night = new Date(Date.parse(at) + 9 * 3_600_000).toISOString().slice(0, 10);
      if (role === 'proposer' && skills.sleepUsage.calls(scope, role, night) >= 3) return;
      skills.sleepUsage.call(scope, role, night, model, at); allowed = true;
    });
    return allowed;
  };
  return {
    async decide({ job, state: raw, signal }) {
      signal.throwIfAborted();
      const state = checkedState(raw), at = parts.now(), scope = job.scopeKey;
      const plan: Planned = { kind: state.stage, state, at, sources: [] };
      if (!skills.ready()) return { ...plan, kind: 'done' } satisfies Planned;
      if (state.stage === 'lifecycle') return plan;
      if (Date.parse(job.endAt) < Date.parse(at) - 36 * 3_600_000) return { ...plan, kind: 'done' } satisfies Planned;
      const bounds = limits(scope, at), seeds = parts.seeds(scope, job.startAt, job.endAt);
      const pages = skills.patterns(scope), currentSkills = skills.store.all(scope);
      plan.sources = expandSources(scope, [...seeds.list.map(seed => seed.source), ...pages.flatMap(page => page.sources), ...currentSkills.flatMap(skill => skill.sources)]);
      observe(scope, plan.sources);
      signal.throwIfAborted();
      plan.seeds = seeds; plan.pages = pages.map(page => ({ id: page.patternId, version: page.version }));
      if (state.stage === 'maintain') {
        const model = parts.models.maintainer;
        if (!model || !bounds.patterns || !seeds.list.length) return plan;
        if (!reserve(scope, 'maintainer', at, model.model)) return { ...plan, kind: 'done' } satisfies Planned;
        plan.limit = bounds.patterns;
        plan.answer = await model.json(scope, 'shannon_pattern_operations', MAINTAINER_INSTRUCTIONS, {
          evidence: seeds.list.map(seed => ({ id: seed.id, kind: seed.kind, text: seed.text })),
          pages: pages.slice(-30).map(page => ({ id: page.patternId, version: page.version, kind: page.kind, title: page.title, body: page.body.slice(0, 600) })), limit: bounds.patterns,
        }, MAINTAINER_SCHEMA, signal);
      } else {
        const model = parts.models.proposer;
        if (!model || !pages.length || state.run > SKILL_LIFECYCLE.proposerRuns || (!bounds.create && !bounds.update)) return { ...plan, kind: 'done' } satisfies Planned;
        const opened = new Map(state.opened.map(ref => {
          const page = pages.find(page => page.patternId === ref.id && page.version === ref.version);
          if (!page) throw new Error('SKILL_FCA_PATTERN_CHANGED');
          return [ref.id, page] as const;
        }));
        const bases = new Map<string, Base>();
        if (state.round === 1) for (const [id, base] of parts.bases(scope)) bases.set(id, base);
        else for (const ref of state.bases) {
          const node = skills.lineage(scope, ref.id).find(node => node.revisionId === ref.revisionId);
          const revision = skills.store.revisions(scope, ref.id).find(item => item.revisionId === ref.revisionId);
          if (!node || !revision) throw new Error('SKILL_FCA_BASE_CHANGED');
          bases.set(ref.id, { revisionId: node.revisionId, version: node.version, body: revision.body, uses: node.uses, successes: node.successes });
        }
        plan.bases = bases;
        plan.sources = expandSources(scope, [...plan.sources, ...parts.revertedSources(scope), ...[...bases].flatMap(([id, base]) =>
          skills.store.revisions(scope, id).find(revision => revision.revisionId === base.revisionId)?.evidence ?? [])]);
        observe(scope, plan.sources);
        plan.state = { ...state, bases: [...bases].map(([id, base]) => ({ id, revisionId: base.revisionId })) };
        if (!reserve(scope, 'proposer', at, model.model)) return { ...plan, kind: 'done' } satisfies Planned;
        plan.answer = await model.json(scope, 'shannon_skill_proposal', PROPOSER_INSTRUCTIONS,
          parts.proposerInput(scope, state.round, bounds, opened, bases), PROPOSER_SCHEMA, signal);
      }
      signal.throwIfAborted(); verify(scope, plan.sources);
      return plan;
    },
    async apply(raw, { job, signal }) {
      signal.throwIfAborted();
      const plan = raw as Planned, scope = job.scopeKey;
      if (!plan || !['lifecycle', 'maintain', 'propose', 'done'].includes(plan.kind)) throw new Error('SKILL_FCA_PLAN_INVALID');
      verify(scope, plan.sources);
      const at = parts.now();
      if (plan.kind === 'done') return { done: true, summary: summary('finished', {}) };
      const check = parts.sources.check(scope);
      if (plan.kind === 'lifecycle') {
        const settled = skills.settleUses(scope, at), visible = parts.sources.visible(scope);
        const forgotten = (sources: readonly string[]) => sources.some(source => source.startsWith('experience:') && !visible(source.slice(11)));
        for (const skill of skills.store.all(scope)) if (forgotten(skill.sources)) skills.retire(scope, skill.skillId, 'source_forgotten', at);
        for (const page of skills.patterns(scope)) if (forgotten(page.sources)) skills.deprecatePattern(scope, page.patternId, null, at);
        const result = skills.lifecycle(scope, at, check);
        return { done: false, state: { ...plan.state, stage: 'maintain' }, summary: summary('lifecycle', { settled, accepted: result.accepted.length, reverted: result.reverted.length, retired: result.retired.length }) };
      }
      // A source/page changed during inference. The paid answer is not reinterpreted against different evidence.
      const pages = skills.patterns(scope);
      if (plan.pages?.some(ref => !pages.some(page => page.patternId === ref.id && page.version === ref.version))) throw new Error('SKILL_FCA_PATTERN_CHANGED');
      const bounds = limits(scope, at), rejected: SkillRejection[] = [];
      if (plan.kind === 'maintain') {
        const result = { patterns: { created: 0, edited: 0, merged: 0, deprecated: 0 } };
        if (plan.answer !== undefined) parts.applyMaintenance(plan.answer as { operations?: unknown }, scope, plan.seeds!,
          Math.min(plan.limit ?? 0, bounds.patterns), check, at, result, why => { rejected.push(why); });
        return { done: false, state: { ...plan.state, stage: 'propose' }, summary: summary('maintain', { ...result.patterns, rejected: rejected.length }) };
      }
      const answer = plan.answer as Partial<ProposerAnswer>;
      if (!isProposerAnswer(answer)) return { done: true, summary: summary('no_proposal', {}) };
      if (answer.action === 'open' && plan.state.round < 3) {
        const opened = new Map(plan.state.opened.map(ref => [ref.id, ref]));
        for (const id of answer.open.slice(0, 4)) { const page = pages.find(page => page.patternId === id); if (page) opened.set(id, { id, version: page.version }); }
        return { done: false, state: { ...plan.state, round: plan.state.round + 1, opened: [...opened.values()] }, summary: summary('open', { pages: opened.size }) };
      }
      if (answer.action !== 'propose') return { done: true, summary: summary('no_proposal', {}) };
      const result = parts.applyProposal(answer, scope, bounds, check, plan.seeds!.texts, at, why => { rejected.push(why); }, plan.bases!);
      const state = nextRun(plan.state);
      return { done: state.run > SKILL_LIFECYCLE.proposerRuns, state, summary: summary('propose', { result, rejected: rejected.length }) };
    },
  };
}

function checkedState(raw: unknown): SkillFcaState {
  if (raw === null || raw === undefined) return initial();
  const state = raw as SkillFcaState;
  if (state.version !== 1 || !['lifecycle', 'maintain', 'propose'].includes(state.stage) || !Number.isInteger(state.run) || state.run < 1 || state.run > 4
    || !Number.isInteger(state.round) || state.round < 1 || state.round > 3 || !Array.isArray(state.opened) || state.opened.length > 8
    || !Array.isArray(state.bases) || state.bases.length > 20 || state.opened.some(ref => typeof ref.id !== 'string' || !Number.isSafeInteger(ref.version))
    || state.bases.some(ref => typeof ref.id !== 'string' || typeof ref.revisionId !== 'string')) throw new Error('SKILL_FCA_STATE_INVALID');
  return structuredClone(state);
}
