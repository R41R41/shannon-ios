import { fcaSleepTaskEvidenceFor } from './fcaSleepTaskEvidence.js';
import { DatabaseSync } from 'node:sqlite';
import { isOwnerOnly, ownerSpoke, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { skillRoutingSwitches } from '@shannon/learning';
import type { SkillTurnPorts } from '../contracts/skillMemoryContract.js';
import { SkillMemory, checkedSkillText, skillIndex, versionRevisionId, type SkillBodyCheck } from '../mind/memory/memoryPorts.js';
import type { ChoiceLedger } from '../mind/learning/choiceLedger.js';
import { conversationSecrets, othersSecrets } from '../mind/inhibition/conversationSecrets.js';
import { MemoryWithholding } from '../mind/memory/memoryVisibility.js';
import type { ConversationStore } from '../mind/memory/store/conversationStore.js';
import type { ShannonKnowledgeStore } from '../mind/memory/store/sqliteShannonKnowledge.js';
import { isExperienceSourceVisible, usableKnowledgeFor } from '../mind/recall/turnKnowledgeRecall.js';
import { ShannonSkillConsolidator, skillSleepNight, type SkillSeedSources, type SkillSleepModels } from '../mind/sleep/skillConsolidation.js';
import { createConfiguredSkillSleepModels } from '../mind/sleep/skillSleepModel.js';
import { configuredSkillProposer } from './sonnetWiring.js';
import { configuredSkillBudgetUsd, type LlmUsageStore } from '../infra/models/llmUsage.js';
import { aetherStudyScope, configuredAetherAccess, type AetherAccess } from '../integrations/aether/aetherAccess.js';
import { exportSkills, type SkillExportResult } from '../integrations/aether/skillExport.js';

/**
 * Wiring of Syzygy ADR-0008 stage 2, step 6 (`docs/skill-and-routing-contract.md`, 「スキル記憶」): her skill memory on its own
 * connection, what a conversation turn is handed of it, and the sleep builder's sources. Null with `SHANNON_SKILLS=off` (or
 * `SHANNON_ADR8_STAGE2=off`): then no table is created, no index is given, `skill.read` does not exist, and nothing is noted.
 *
 * The API process creates the tables (`createsSchema`); the background worker opens them and writes nothing until they exist.
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';

export function configuredSkillMemory(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { databasePath: string | null; database?: DatabaseSync; createsSchema: boolean; defer?: (task: () => void) => void; log?: (line: string) => void },
): { memory: SkillMemory; close(): void } | null {
  if (!skillRoutingSwitches(environment).skills || (!parts.database && !parts.databasePath)) return null;
  const database = parts.database ?? new DatabaseSync(parts.databasePath!);
  if (!parts.database) database.exec(PRAGMAS);
  const memory = new SkillMemory({ database, createsSchema: parts.createsSchema, ...(parts.defer ? { defer: parts.defer } : {}), ...(parts.log ? { log: parts.log } : {}) });
  return { memory, close: () => { if (!parts.database && database.isOpen) database.close(); } };
}

/**
 * How long the skill checks built from the owner's whole memory (the seed rule over every remembered turn, and the secret check over
 * them) are reused while his companion state keeps the same version. A forget, a correction or any other state change is a new
 * version, so it applies at once; a skill's own status and body are read afresh on every call. Before this, every FCA read
 * receipt of a skill rebuilt both from all remembered turns: 80 receipts on the 2026-10-12 voice task, seconds per check.
 */
export const SKILL_CHECK_REUSE_MS = 2_000;

/** What a turn is handed: the index, one skill by name, and the notes of its use; a skill built from something forgotten is left out at once. */
export function skillTurnPorts(memory: SkillMemory, snapshot: (scopeKey: string) => CompanionStateSnapshot,
  sources?: ConversationStore & Pick<CompanionStateStore, 'snapshot'> & Partial<ShannonKnowledgeStore>, clock: () => number = Date.now): SkillTurnPorts {
  type Checks = { version: number; at: number; pass: (sources: readonly string[]) => boolean; check: SkillBodyCheck | null; bodies: Map<string, boolean> };
  const reused = new Map<string, Checks>();
  /**
   * The state as last read, kept while the database is unchanged (its change mark moves with every write of any connection): a receipt
   * of a skill is checked thousands of times a walk, and each check read and parsed the state twice. What the checks use of it (the
   * memory controls, the version) is a function of the rows; the state's own clock (what fades) is not read here.
   */
  const states = new Map<string, { mark: string; state: CompanionStateSnapshot }>();
  const stateOf = (scopeKey: string): CompanionStateSnapshot => {
    const mark = sources?.changeMark?.() ?? null, known = states.get(scopeKey);
    if (mark !== null && known?.mark === mark) return known.state;
    const state = snapshot(scopeKey);
    if (mark !== null) states.set(scopeKey, { mark, state });
    return state;
  };
  const checksFor = (scopeKey: string, store: NonNullable<typeof sources>): Checks => {
    const state = stateOf(scopeKey), at = clock(), known = reused.get(scopeKey);
    if (known && known.version === state.version && at >= known.at && at - known.at < SKILL_CHECK_REUSE_MS) return known;
    const pass = skillSourcesPass(store, memory, scopeKey);
    const fresh = { version: state.version, at, pass, check: skillBodyCheck(state, store, scopeKey), bodies: new Map<string, boolean>() };
    reused.set(scopeKey, fresh);
    return fresh;
  };
  const visible = (scopeKey: string) => {
    const state = stateOf(scopeKey);
    return (experienceId: string) => isExperienceSourceVisible(state, experienceId);
  };
  const usable = (scopeKey: string) => {
    const isVisible = visible(scopeKey);
    const skills = memory.usable(scopeKey, isVisible).filter(skill => skill.exportHold !== 'withdrawn'
      && isVisible(skill.skillId) && isVisible(versionRevisionId(skill.skillId, skill.version)));
    if (!sources) return skills;
    const { pass, check } = checksFor(scopeKey, sources);
    return skills.filter(skill => pass(skill.sources) && typeof checkedSkillText(skill.body, check) !== 'string');
  };
  const sourceId = (skill: { skillId: string; version: number }) => `shannon-skill://${encodeURIComponent(skill.skillId)}/revision/${encodeURIComponent(versionRevisionId(skill.skillId, skill.version))}`;
  return {
    index: scopeKey => skillIndex(usable(scopeKey).map(skill => ({ name: skill.name, description: skill.description, status: skill.status === 'active' ? 'active' : 'trial', createdAt: skill.createdAt,
      ...(skill.provenance?.origin === 'operator_authored' ? { origin: 'operator_authored' as const } : {}) }))),
    ...(sources ? { indexSources: (scopeKey: string) => usable(scopeKey).map(sourceId) } : {}),
    open: (scopeKey, name) => {
      const skill = usable(scopeKey).find(skill => skill.name === name);
      return skill ? { skillId: skill.skillId, name: skill.name, version: skill.version, revisionId: versionRevisionId(skill.skillId, skill.version), provenance: skill.provenance, status: skill.status === 'active' ? 'active' : 'draft', body: skill.body } : null;
    },
    readSource: (scopeKey, id, revisionId) => {
      if (!sources || !memory.ready()) return null;
      const skill = memory.store.get(scopeKey, id);
      const isVisible = visible(scopeKey);
      const checks = checksFor(scopeKey, sources), { pass, check } = checks;
      // The same body under the same checks gets the same answer: asked once per body while the checks are reused.
      const bodyPasses = (body: string) => {
        if (!checks.bodies.has(body)) checks.bodies.set(body, typeof checkedSkillText(body, check) !== 'string');
        return checks.bodies.get(body)!;
      };
      if (!skill || skill.status === 'retired' || skill.exportHold === 'withdrawn' || !isVisible(skill.skillId)
        || !isVisible(versionRevisionId(skill.skillId, skill.version)) || !pass(skill.sources)) return null;
      if (!bodyPasses(skill.body)) return null;
      const revision = revisionId ? memory.store.version(scopeKey, id, revisionId) : null;
      if (revisionId && !revision) return null;
      if (revisionId && !isVisible(revisionId)) return null;
      const body = revision?.body ?? skill.body;
      // Current ancestry remains required after editing; the exact older body is independently checked under today's controls.
      if (!bodyPasses(body)) return null;
      return { body, provenance: revision?.provenance ?? skill.provenance };
    },
    // The checks `readSource` takes (made anew here, as there, when they have expired): `fcaReadSourceAnswers.ts` keys its answers by them.
    readSourceChecks: (scopeKey, renew) => {
      if (!sources || !memory.ready()) return null;
      const checks = renew ? checksFor(scopeKey, sources) : reused.get(scopeKey);
      return checks ? { checks, mark: renew ? memory.store.changeMark() : null } : null;
    },
    used: (scopeKey, name, use, at) => memory.used(scopeKey, name, use, at),
    nextTurn: (scopeKey, talk, serve, at) => memory.nextTurn(scopeKey, talk, serve, at),
  };
}

/**
 * The check every skill body passes before it is stored (owner answer I-4, ADR-0002): what the owner asked to keep secret, marked
 * 機微 by hand, or had her forget (`conversationSecrets`), and what must reach nobody but him, judged for an unnamed guest
 * (`othersSecrets(...).withheld`), since every skill has a copy in a folder guests can read. Null when his memory cannot be read.
 */
export function skillBodyCheck(state: CompanionStateSnapshot, conversations: Pick<ConversationStore, 'experienceCandidates'>, scopeKey: string): SkillBodyCheck | null {
  try {
    const secrets = conversationSecrets(state, conversations, scopeKey);
    const withheld = othersSecrets(state, conversations, scopeKey).withheld;
    return { carries: text => secrets.carries(text) || withheld.carries(text) };
  } catch { return null; }
}

/** The sleep builder over the worker's stores (`worker.ts`): runs after knowledge consolidation, inside the background budget. */
export function skillSleepConsolidator(
  environment: Readonly<Record<string, string | undefined>>,
  parts: {
    memory: SkillMemory;
    store: ShannonKnowledgeStore & ConversationStore & Pick<CompanionStateStore, 'snapshot'> & LlmUsageStore & { backgroundLlmCostUsd(monthKey: string): number };
    choices: ChoiceLedger | null;
    /** The maintainer's and the proposer's models; absent, from the environment (`createConfiguredSkillSleepModels`). */
    models?: SkillSleepModels;
    now?: () => string;
    log?: (line: string) => void;
  },
): ShannonSkillConsolidator {
  // Review M4: the skill sleep's models spend its own budget, written to the skill tables, never to the shared background lane.
  const spend = skillSleepSpend(parts.memory);
  return new ShannonSkillConsolidator(parts.memory, skillSeedSources(parts.store, parts.choices, parts.memory),
    // The proposer is Sonnet whenever the Anthropic key is present (step 5); otherwise terra.
    parts.models ?? createConfiguredSkillSleepModels(environment, spend, () => configuredSkillProposer(environment, { usageStore: spend })),
    { skillBudgetUsd: configuredSkillBudgetUsd(environment), ...(parts.now ? { now: parts.now } : {}), ...(parts.log ? { log: parts.log } : {}) });
}

/** The usage store the skill sleep's models write to: its own spend in the skill tables (`shannon_skill_sleep_usage`). */
export function skillSleepSpend(memory: SkillMemory): LlmUsageStore {
  return {
    recordLlmUsage: event => memory.write(event.occurredAt, () => memory.sleepUsage.cost(event.scopeKey, skillSleepNight(event.occurredAt), event.model, event.estimatedCostUsd, event.occurredAt)),
    // Never the shared background budget: the skill budget is checked by the consolidator before each call.
    backgroundLlmCostUsd: () => 0,
  };
}

/**
 * The builder's seeds, by the rules knowledge consolidation follows for what it may be built from. A turn is a seed only when the
 * owner had it with her alone, spoke in it, and it is visible, not withheld, not kept secret and not marked 機微 by him. A knowledge
 * note is a seed only when every turn it was built from passes the same rule (a source that cannot be found fails it): every skill
 * has a copy in a folder guests can read (privacy review B1).
 */
export function skillSeedSources(store: ShannonKnowledgeStore & ConversationStore & Pick<CompanionStateStore, 'snapshot'>, choices: ChoiceLedger | null,
  memory?: SkillMemory): SkillSeedSources {
  const seedable = (scopeKey: string) => seedRule(store, scopeKey);
  const taskEvidence = fcaSleepTaskEvidenceFor(store);
  return {
    ...(memory ? { sourcesPass: (scopeKey: string) => skillSourcesPass(store, memory, scopeKey) } : {}),
    knowledge: scopeKey => {
      const seeds = seedable(scopeKey);
      return usableKnowledgeFor(store, scopeKey, seeds.snapshot).filter(document => document.status === 'confirmed' && seeds.passes(document.sourceExperienceIds))
        .map(document => ({ id: document.id, title: document.title, applicability: document.applicability, body: document.bodyMarkdown }));
    },
    experiences: (scopeKey, startAt, endAt) => {
      const seeds = seedable(scopeKey);
      // Only turns the owner had with her alone, that he spoke in, that are visible, not withheld, and not kept secret.
      return seeds.candidates.filter(item => item.observedAt >= startAt && item.observedAt < endAt && seeds.ok(item))
        .map(item => ({ id: item.id, observedAt: item.observedAt, summary: item.summary, text: taskEvidence(scopeKey, item.id) ? item.summary : `${item.userMessage}\n${item.shannonReply}` }));
    },
    choices: (scopeKey, startAt, endAt) => (choices?.rows(scopeKey) ?? []).filter(row => row.chosenAt >= startAt && row.chosenAt < endAt).map(row => ({
      choiceId: row.choiceId, settleCode: row.settleCode, choice: row.choice, surface: row.surface, subjectKind: row.subjectKind, subjectId: row.subjectId, chosenAt: row.chosenAt, status: row.status,
      growth: row.growth, serve: row.serve, reward: row.reward,
    })),
    visible: scopeKey => {
      const state = store.snapshot(scopeKey);
      return experienceId => isExperienceSourceVisible(state, experienceId);
    },
    check: scopeKey => skillBodyCheck(store.snapshot(scopeKey), store, scopeKey),
  };
}

/** The seed rule over a scope's turns now; a turn outside the recent window is read by its id (a turn not found fails). */
function seedRule(store: ConversationStore & Pick<CompanionStateStore, 'snapshot'>, scopeKey: string) {
  const snapshot = store.snapshot(scopeKey);
  const taskEvidence = fcaSleepTaskEvidenceFor(store);
  const candidates = store.experienceCandidates(scopeKey);
  const withholding = new MemoryWithholding(snapshot, store, scopeKey, candidates);
  const ok = (item: (typeof candidates)[number]) => isOwnerOnly(item.disclosure?.audience) && (item.id.startsWith('task:') ? taskEvidence(scopeKey, item.id) : ownerSpoke(item.disclosure))
    && item.disclosure?.category !== 'secret' && !(item.disclosure?.decidedBy === 'owner' && item.disclosure.sensitivity === 'sensitive')
    && visibleMemoryText(snapshot, item.id, item.summary) !== null && !withholding.withholdsExperience(item);
  const known = new Map(candidates.map(item => [item.id, item]));
  const passes = (ids: readonly string[]) => {
    const missing = [...new Set(ids)].filter(id => !known.has(id));
    if (missing.length) for (const item of store.experiencesById?.(scopeKey, missing) ?? []) known.set(item.id, item);
    return ids.every(id => { const item = known.get(id); return item !== undefined && ok(item); });
  };
  return { snapshot, candidates, ok, passes };
}

/**
 * Whether every source of a skill still passes the seed rule (privacy review B2): its turns, the turns of the notes it was built
 * from (a retired note by its own turns, review N2), and the sources of its pattern pages; every source, however many (N1). A skill whose source was forgotten, or is now 内緒 or 機微, fails: its copy in Aether
 * is withdrawn (`skillExport.ts`).
 */
export function skillSourcesPass(store: ConversationStore & Pick<CompanionStateStore, 'snapshot'> & Partial<ShannonKnowledgeStore>, memory: SkillMemory, scopeKey: string): (sources: readonly string[]) => boolean {
  const rule = seedRule(store, scopeKey);
  // Review N2: a note counts by the turns it was built from, retired or not (consolidation retires notes in normal operation);
  // only a turn that fails the rule withdraws. Without her notes (a store that has none) a skill built from one fails: closed.
  const notes = new Map((store.listShannonKnowledge?.(scopeKey, { includeRetired: true }) ?? []).map(document => [document.id, document]));
  // Review R1: and the forget rules on the note's own title and body (what `usableKnowledgeFor` applied), retired or not.
  const withholding = new MemoryWithholding(rule.snapshot, store, scopeKey, rule.candidates);
  const check = (sources: readonly string[], depth: number): boolean => sources.every(source => {
    const [kind, ...rest] = source.split(':');
    const id = rest.join(':');
    if (kind === 'experience') return rule.passes([id]);
    if (kind === 'knowledge') { const note = notes.get(id); return note !== undefined && !withholding.withholdsKnowledge(note) && rule.passes(note.sourceExperienceIds); }
    if (kind === 'pattern') { const page = memory.store.pattern(scopeKey, id); return page !== null && depth < 3 && check(page.sources, depth + 1); }
    if (kind === 'import') return memory.store.importSourceVisible(scopeKey, id)
      && isExperienceSourceVisible(rule.snapshot, source) && isExperienceSourceVisible(rule.snapshot, id);
    if (kind === 'choice' || kind === 'sequence') return true;
    return false;
  });
  return sources => check(sources, 0);
}

/**
 * Step 7 (`SHANNON_SKILL_EXPORT`, owner answers I-4 and I-5): readable copies of her skills in Aether's シャノン用フォルダ, after the
 * skill sleep, for the one scope whose study lives in Aether (`aetherStudyScope`). Null while the switch is off, the skills are
 * off, or Aether is not configured (address and token): then her skills stay in the database only.
 */
export function configuredSkillExport(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { memory: SkillMemory; store: ConversationStore & Pick<CompanionStateStore, 'snapshot'> & Partial<ShannonKnowledgeStore>; access?: AetherAccess | null; log?: (line: string) => void },
): ((scopeKey: string, at: string, signal?: AbortSignal) => Promise<SkillExportResult | null>) | null {
  if (!skillRoutingSwitches(environment).skillExport) return null;
  const access = parts.access === undefined ? configuredAetherAccess(environment) : parts.access;
  if (!access) return null;
  const scope = aetherStudyScope(environment);
  return async (scopeKey, at, signal) => scopeKey !== scope ? null : exportSkills({
    scopeKey, skills: parts.memory, access, at, signal, check: () => skillBodyCheck(parts.store.snapshot(scopeKey), parts.store, scopeKey),
    sources: () => skillSourcesPass(parts.store, parts.memory, scopeKey), ...(parts.log ? { log: parts.log } : {}),
  });
}
