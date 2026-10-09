import { fcaSleepTaskEvidenceFor } from './fcaSleepTaskEvidence.js';
import { DatabaseSync } from 'node:sqlite';
import { isOwnerOnly, ownerSpoke, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { skillRoutingSwitches } from '@shannon/learning';
import type { SkillTurnPorts } from '../contracts/skillMemoryContract.js';
import { SkillMemory, type SkillBodyCheck } from '../mind/memory/memoryPorts.js';
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

/** What a turn is handed: the index, one skill by name, and the notes of its use; a skill built from something forgotten is left out at once. */
export function skillTurnPorts(memory: SkillMemory, snapshot: (scopeKey: string) => CompanionStateSnapshot): SkillTurnPorts {
  const visible = (scopeKey: string) => {
    const state = snapshot(scopeKey);
    return (experienceId: string) => isExperienceSourceVisible(state, experienceId);
  };
  return {
    index: scopeKey => memory.index(scopeKey, visible(scopeKey)),
    open: (scopeKey, name) => {
      const skill = memory.open(scopeKey, name, visible(scopeKey));
      return skill ? { skillId: skill.skillId, name: skill.name, version: skill.version, status: skill.status === 'active' ? 'active' : 'draft', body: skill.body } : null;
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
    return true;
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
