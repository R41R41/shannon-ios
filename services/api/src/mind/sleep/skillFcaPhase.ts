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
  /** Where the content-free line naming what was left out goes (ids only); `console.warn` unless handed. */
  log?(line: string): void;
}
export interface SkillFcaParts {
  skills: SkillMemory; sources: SkillSeedSources; models: SkillSleepModels; budgetUsd: number; now(): string;
  seeds(scope: string, start: string, end: string): Seeds;
  revertedSources(scope: string): readonly string[];
  bases(scope: string): Map<string, Base>;
  /** `hidden`: the ids of the pages and skills left out of this night's evidence (their sources are not visible): never shown, never cited. */
  proposerInput(scope: string, round: number, limits: { create: number; update: number }, opened: ReadonlyMap<string, StoredPattern>, bases: Map<string, Base>,
    hidden?: ReadonlySet<string>): unknown;
  applyMaintenance(answer: { operations?: unknown }, scope: string, seeds: Seeds, limit: number, check: SkillBodyCheck | null, at: string,
    result: { patterns: Counts }, reject: (why: SkillRejection) => void): void;
  applyProposal(answer: ProposerAnswer, scope: string, limits: { create: number; update: number }, check: SkillBodyCheck | null, texts: readonly string[],
    at: string, reject: (why: SkillRejection) => void, bases: Map<string, Base>, hidden?: ReadonlySet<string>): 'created' | 'updated' | 'rejected';
}
interface Planned {
  kind: 'lifecycle' | 'maintain' | 'propose' | 'done'; state: SkillFcaState; at: string; sources: string[];
  answer?: unknown; seeds?: Seeds; bases?: Map<string, Base>; limit?: number;
  pages?: readonly { id: string; version: number }[];
  /** What this decision left out because its sources are not visible (counts only), and the ids of the pages and skills among them. */
  withheld?: number; hidden?: ReadonlySet<string>;
}
/** Whether every one of the given sources still passes the seed rule and (for a turn) is still visible. */
type SourceGate = (sources: readonly string[]) => boolean;
/** How long a check of sources runs before it lets the event loop go (the API has one thread: the nightly check must not hold it). */
export const SKILL_VERIFY_SLICE_MS = 8;
const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve));
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
  const log = options.log ?? ((line: string) => console.warn(line));
  /**
   * The check of a moment, made once and used for every source it is asked about (each source is judged once, a page's chain once):
   * the seed rule over a source and what it was built from, and for a turn that it is still visible. Throws where the rule cannot be read.
   */
  const makeGate = (scope: string): SourceGate => {
    const pass = parts.sources.sourcesPass?.(scope);
    const visible = parts.sources.visible(scope);
    const judged = new Map<string, boolean>();
    const one = (source: string): boolean => {
      let ok = judged.get(source);
      if (ok === undefined) {
        ok = (!pass || pass([source])) && !(source.startsWith('experience:') && !visible(source.slice(11)));
        judged.set(source, ok);
      }
      return ok;
    };
    return sources => sources.every(one);
  };
  /** The same check where the rule cannot be read: only that a turn is still visible (what the night's model-free part always asked). */
  const visibleOnly = (scope: string): SourceGate => {
    const visible = parts.sources.visible(scope);
    return sources => sources.every(source => !source.startsWith('experience:') || visible(source.slice(11)));
  };
  /**
   * Every source must pass, or the step is withheld (closed, as before). The sources are judged in slices: past `SKILL_VERIFY_SLICE_MS`
   * the check lets the event loop go (Minecraft's body and the app share this thread) and goes on from where it was.
   */
  const verify = async (scope: string, sources: readonly string[], signal: AbortSignal) => {
    const gate = makeGate(scope);
    let sliceStart = performance.now();
    for (const source of sources) {
      if (!gate([source])) throw new Error('SKILL_FCA_SOURCE_WITHHELD');
      if (performance.now() - sliceStart >= SKILL_VERIFY_SLICE_MS) {
        await yieldToLoop();
        signal.throwIfAborted();
        sliceStart = performance.now();
      }
    }
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
  const observe = async (scope: string, sources: readonly string[], signal: AbortSignal) => {
    await verify(scope, sources, signal);
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
      const bounds = limits(scope, at);
      // What is not visible is left out of the night, alone: a seed, a page or a skill whose sources fail the rule is neither shown to a
      // model nor cited, and the rest goes on (before, one such source withheld the whole night, every night). Each is named below.
      const gate = makeGate(scope), left = { seeds: [] as string[], pages: [] as string[], skills: [] as string[] };
      const found = parts.seeds(scope, job.startAt, job.endAt);
      const seeds = withheldSeeds(found, gate, left.seeds);
      const pages = skills.patterns(scope).filter(page => gate(page.sources) || (left.pages.push(page.patternId), false));
      const currentSkills = skills.store.all(scope).filter(skill => gate(skill.sources) || (left.skills.push(skill.skillId), false));
      const hidden = new Set([...left.pages, ...left.skills]);
      plan.withheld = left.seeds.length + hidden.size; plan.hidden = hidden;
      if (plan.withheld) log(`Shannon skill sleep withheld seeds=${left.seeds.length} pages=${left.pages.length} skills=${left.skills.length} reason=source_not_visible ids=${[...left.seeds, ...hidden].slice(0, 12).join(',')}`);
      plan.sources = expandSources(scope, [...seeds.list.map(seed => seed.source), ...pages.flatMap(page => page.sources), ...currentSkills.flatMap(skill => skill.sources)]);
      await observe(scope, plan.sources, signal);
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
        // A page opened in an earlier round that is now left out is not an error: it is simply no longer shown.
        const opened = new Map(state.opened.flatMap(ref => {
          const page = pages.find(page => page.patternId === ref.id && page.version === ref.version);
          if (!page && left.pages.includes(ref.id)) return [];
          if (!page) throw new Error('SKILL_FCA_PATTERN_CHANGED');
          return [[ref.id, page] as const];
        }));
        const bases = new Map<string, Base>();
        const evidenceOf = (id: string, revisionId: string) => skills.store.revisions(scope, id).find(revision => revision.revisionId === revisionId)?.evidence ?? [];
        /** A branch (an older revision of a skill) is shown only if the skill is, and the sources it was built from are visible. */
        const usableBase = (id: string, revisionId: string) => {
          if (hidden.has(id)) return false;
          if (gate(evidenceOf(id, revisionId))) return true;
          left.skills.push(id); hidden.add(id); plan.withheld = (plan.withheld ?? 0) + 1;
          log(`Shannon skill sleep withheld seeds=0 pages=0 skills=1 reason=base_source_not_visible ids=${id}`);
          return false;
        };
        if (state.round === 1) { for (const [id, base] of parts.bases(scope)) if (usableBase(id, base.revisionId)) bases.set(id, base); }
        else for (const ref of state.bases) {
          const node = skills.lineage(scope, ref.id).find(node => node.revisionId === ref.revisionId);
          const revision = skills.store.revisions(scope, ref.id).find(item => item.revisionId === ref.revisionId);
          if (!node || !revision) throw new Error('SKILL_FCA_BASE_CHANGED');
          if (usableBase(ref.id, ref.revisionId)) bases.set(ref.id, { revisionId: node.revisionId, version: node.version, body: revision.body, uses: node.uses, successes: node.successes });
        }
        plan.bases = bases;
        plan.sources = expandSources(scope, [...plan.sources, ...parts.revertedSources(scope), ...[...bases].flatMap(([id, base]) => evidenceOf(id, base.revisionId))]);
        await observe(scope, plan.sources, signal);
        plan.state = { ...state, bases: [...bases].map(([id, base]) => ({ id, revisionId: base.revisionId })) };
        if (!reserve(scope, 'proposer', at, model.model)) return { ...plan, kind: 'done' } satisfies Planned;
        plan.answer = await model.json(scope, 'shannon_skill_proposal', PROPOSER_INSTRUCTIONS,
          parts.proposerInput(scope, state.round, bounds, opened, bases, hidden), PROPOSER_SCHEMA, signal);
      }
      signal.throwIfAborted(); await verify(scope, plan.sources, signal);
      return plan;
    },
    async apply(raw, { job, signal }) {
      signal.throwIfAborted();
      const plan = raw as Planned, scope = job.scopeKey;
      if (!plan || !['lifecycle', 'maintain', 'propose', 'done'].includes(plan.kind)) throw new Error('SKILL_FCA_PLAN_INVALID');
      await verify(scope, plan.sources, signal);
      const at = parts.now();
      if (plan.kind === 'done') return { done: true, summary: summary('finished', {}) };
      const check = parts.sources.check(scope);
      if (plan.kind === 'lifecycle') {
        const settled = skills.settleUses(scope, at);
        // A skill or a page whose sources no longer pass the seed rule (a turn the owner has since made 内緒, a note built from one, a
        // page built from that note) leaves with the ones whose turn was forgotten: retired or deprecated, with the reason in the
        // journal. Where the rule cannot be read, only a forgotten turn counts, as before.
        let gate: SourceGate;
        try { gate = makeGate(scope); } catch { gate = visibleOnly(scope); }
        const retired: string[] = [], deprecated: string[] = [];
        for (const skill of skills.store.all(scope)) if (!gate(skill.sources) && skills.retire(scope, skill.skillId, 'source_forgotten', at)) retired.push(skill.skillId);
        for (const page of skills.patterns(scope)) if (!gate(page.sources) && skills.deprecatePattern(scope, page.patternId, null, at)) deprecated.push(page.patternId);
        if (retired.length + deprecated.length) log(`Shannon skill sleep withdrew skills=${retired.length} pages=${deprecated.length} reason=source_not_visible ids=${[...retired, ...deprecated].slice(0, 12).join(',')}`);
        const result = skills.lifecycle(scope, at, check);
        return { done: false, state: { ...plan.state, stage: 'maintain' }, summary: summary('lifecycle', { settled, accepted: result.accepted.length, reverted: result.reverted.length,
          retired: result.retired.length + retired.length, withheld: retired.length + deprecated.length }) };
      }
      // A source/page changed during inference. The paid answer is not reinterpreted against different evidence.
      const pages = skills.patterns(scope);
      if (plan.pages?.some(ref => !pages.some(page => page.patternId === ref.id && page.version === ref.version))) throw new Error('SKILL_FCA_PATTERN_CHANGED');
      const bounds = limits(scope, at), rejected: SkillRejection[] = [];
      if (plan.kind === 'maintain') {
        const result = { patterns: { created: 0, edited: 0, merged: 0, deprecated: 0 } };
        if (plan.answer !== undefined) parts.applyMaintenance(plan.answer as { operations?: unknown }, scope, plan.seeds!,
          Math.min(plan.limit ?? 0, bounds.patterns), check, at, result, why => { rejected.push(why); });
        return { done: false, state: { ...plan.state, stage: 'propose' }, summary: summary('maintain', { ...result.patterns, rejected: rejected.length, withheld: plan.withheld ?? 0 }) };
      }
      const answer = plan.answer as Partial<ProposerAnswer>;
      if (!isProposerAnswer(answer)) return { done: true, summary: summary('no_proposal', {}) };
      if (answer.action === 'open' && plan.state.round < 3) {
        const opened = new Map(plan.state.opened.map(ref => [ref.id, ref]));
        for (const id of answer.open.slice(0, 4)) { const page = pages.find(page => page.patternId === id); if (page) opened.set(id, { id, version: page.version }); }
        return { done: false, state: { ...plan.state, round: plan.state.round + 1, opened: [...opened.values()] }, summary: summary('open', { pages: opened.size }) };
      }
      if (answer.action !== 'propose') return { done: true, summary: summary('no_proposal', {}) };
      const result = parts.applyProposal(answer, scope, bounds, check, plan.seeds!.texts, at, why => { rejected.push(why); }, plan.bases!, plan.hidden);
      const state = nextRun(plan.state);
      return { done: state.run > SKILL_LIFECYCLE.proposerRuns, state, summary: summary('propose', { result, rejected: rejected.length, withheld: plan.withheld ?? 0 }) };
    },
  };
}

/** The seeds that pass the gate (the texts the copy check compares against stay whole: they are only compared with, never shown). */
function withheldSeeds(found: Seeds, gate: SourceGate, ids: string[]): Seeds {
  const list = found.list.filter(seed => gate([seed.source]) || (ids.push(seed.id), false));
  return ids.length ? { list, byId: new Map(list.map(seed => [seed.id, seed])), texts: found.texts } : found;
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
