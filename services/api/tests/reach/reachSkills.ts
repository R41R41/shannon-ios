import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UNKNOWN_GUEST_PRESENCE, createInitialCompanionState, type CompanionStateSnapshot } from '@shannon/cognition';
import {
  judgedFacts, skillAuditScenario, skillFormScenario, skillGuestScenario, skillPatternScenario, skillRetireScenario, skillTrialScenario, skillUseScenario, stableFingerprint,
  type ReachDriver, type ReachScenarioDefinition,
} from '../../../../packages/evaluation/src/reach/index.js';
import { createLocalApiKernel } from '../../src/infra/http/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../../src/infra/models/chatModel.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { createInMemoryAutonomyService } from '../../src/mind/action/ownTime/autonomyService.js';
import { talkId } from '../../src/mind/action/respond/turnRouting.js';
import { authorizeToolCall } from '../../src/mind/inhibition/shannonToolGate.js';
import { SKILL_INDEX_HEADER, SKILL_INDEX_LINES, SKILL_INDEX_WIDTH, parseSkill, type SkillDocument } from '../../src/mind/memory/skillDocument.js';
import { SkillMemory } from '../../src/mind/memory/skillMemory.js';
import { ShannonSkillConsolidator, type SkillSleepModels } from '../../src/mind/sleep/skillConsolidation.js';
import type { SkillSleepModel } from '../../src/mind/sleep/skillSleepModel.js';
import { shannonTool } from '../../src/mind/tools/shannonTools.js';
import { toolSessionMemory } from '../../src/mind/tools/shannonToolTypes.js';
import { skillBodyCheck, skillSeedSources, skillTurnPorts } from '../../src/wiring/skillMemoryWiring.js';
import { configuredTurnRouting } from '../../src/wiring/turnRoutingWiring.js';

/**
 * The model-free drivers of the skill scenarios of suite v2 (Syzygy ADR-0008 stage 2, step 6; `packages/evaluation/src/reach/skillRecall.ts`).
 * Each runs the real skill memory, the real builder (with a scripted model), the real kernel and the real ledgers over a
 * temporary database with a scripted clock. Nothing is spent.
 */
const SCOPE = 'owner';
const AT = '2026-10-07T12:00:00.000Z';
const minutes = (count: number) => new Date(Date.parse(AT) + count * 60_000).toISOString();
const SECRET = 'ユーザーはウォンバット会の集まりに毎月出ている';
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };

const skill = (name: string, extra: Partial<SkillDocument> = {}): SkillDocument => ({
  name, description: '週のふりかえりをする時', steps: '1. 今週したことを三つ挙げる\n2. 来週の一つを決める', aids: '- study.search で先週のメモを探す', references: '- 何度かの会話から', ...extra,
});

class SkillWorld {
  readonly directory = mkdtempSync(join(tmpdir(), 'shannon-reach-skills-'));
  readonly path = join(this.directory, 'skills.sqlite');
  readonly store: SQLiteShannonStore;
  readonly database: DatabaseSync;
  readonly skills: SkillMemory;
  state: CompanionStateSnapshot;

  constructor() {
    this.store = new SQLiteShannonStore({ path: this.path, now: () => AT, predictionLedger: true, choiceLedger: true, decisionTraces: true, cognitionDefer: task => task(), predictionShadowDefer: task => task() });
    this.database = new DatabaseSync(this.path);
    this.skills = new SkillMemory({ database: this.database, createsSchema: true, defer: task => task(), log: () => {} });
    this.state = { ...createInitialCompanionState(SCOPE, AT), userFacts: [{ id: 'secret', statement: SECRET, confidence: 0.9, observedAt: AT, disclosure: { category: 'secret' as const } }] };
  }

  ports() { return skillTurnPorts(this.skills, () => this.state); }

  builder(models: SkillSleepModels, at: string) {
    const sources = skillSeedSources(this.store, this.store.choiceLedger());
    return new ShannonSkillConsolidator(this.skills, { ...sources, check: () => skillBodyCheck(this.state, this.store, SCOPE) }, models, { backgroundLlmCostUsd: () => 0 },
      { backgroundBudgetUsd: 1, now: () => at, log: () => {} });
  }

  close(): void {
    this.database.close();
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** A scripted sleep model: each call is answered by `answer` from what it was given; every input is kept. */
const scripted = (answer: (input: Record<string, unknown>) => unknown): SkillSleepModel & { inputs: Array<Record<string, unknown>> } => {
  const inputs: Array<Record<string, unknown>> = [];
  return { model: 'scripted', inputs, json: async (_scope, _name, _instructions, input) => { inputs.push(input as Record<string, unknown>); return answer(input as Record<string, unknown>); } };
};
const page = (title: string, text: string, evidence: string[], kind = 'strategy') => ({ operation: 'create', patternId: '', expectedVersion: 0, kind, title, text, mergeIds: [], evidence });
const proposal = (name: string, purposes: string[], extra: Partial<SkillDocument> & Record<string, unknown> = {}) => ({
  action: 'propose', open: [], operation: 'create', skillId: '', expectedVersion: 0, ...skill(name), replacements: [], purposePatternIds: purposes, consolidates: [], ...extra,
});
/** The pattern ids of the index the proposer was given. */
const indexIds = (input: Record<string, unknown>) => (input.patternIndex as Array<{ id: string }>).map(item => item.id);

/** A chat model that opens a skill when the turn offers skill.read, then answers. */
class SkillReadingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'reach-skills';
  readonly requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  constructor(private readonly open: string | null) {}
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    if (this.open && request.tools?.definitions.some(tool => tool.name === 'skill.read')) await request.tools.call?.('skill_read', JSON.stringify({ name: this.open }));
    return { mode: this.mode, model: this.model, reply: 'はい、その手順でやってみます。' };
  }
  async generateVoice(request: ShannonVoiceModelRequest) { this.requests.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
}

function outcome(definition: ReachScenarioDefinition, facts: Record<string, boolean | number>, metrics: Record<string, number>, steps: number) {
  return { checks: judgedFacts(definition, facts), steps, metrics, inputs: { driver: 'reachSkills', script: stableFingerprint({ id: definition.id, version: definition.version }) } };
}

async function form() {
  const world = new SkillWorld();
  try {
    world.store.appendTurn(SCOPE, 'thread', '週末にふりかえりを手伝って', '三つ挙げてみましょう。', minutes(-60), { capturedStateVersion: 0, messageEmotion: emotion });
    const maintainer = scripted(() => ({ operations: [page('ふりかえりは三つに絞る', '週のふりかえりは三つに絞って聞く。多いと疲れるから。', ['e1'])] }));
    // The proposer offers five new skills, one of them carrying what the owner called 内緒.
    const offers = ['weekly-review', 'club-day', 'morning-plan', 'evening-plan', 'tea-time'];
    const proposer = scripted(input => {
      const name = offers.shift();
      return name ? proposal(name, indexIds(input), name === 'club-day' ? { steps: '1. ウォンバット会の集まりに毎月出ている日を確かめる' } : {}) : { ...proposal('none', []), action: 'none' };
    });
    const night = (at: string) => world.builder({ maintainer, proposer }, at).consolidate(SCOPE, minutes(-1440), at);
    const first = await night(minutes(0));
    const stored = world.skills.store.all(SCOPE, { includeRetired: true });
    const revisions = world.skills.store.revisions(SCOPE);
    const check = skillBodyCheck(world.state, world.store, SCOPE)!;
    const index = world.skills.index(SCOPE);
    const lines = index.split('\n');
    offers.push('another-one');
    const second = await night(minutes(30));
    return outcome(skillFormScenario, {
      'form.drafts': first.created >= 1 && stored.every(item => item.status === 'trial' && 'skill' in parseSkill(item.body) && item.purposePatternIds.length > 0),
      'form.night_limit': first.created === 2 && second.created === 0,
      'form.no_secret': first.rejections.includes('secret') && revisions.every(revision => !check.carries(revision.body)) && !stored.some(item => item.name === 'club-day'),
      'form.index': lines[0]!.startsWith(SKILL_INDEX_HEADER) && lines[0]!.includes('2/19') && lines.length <= SKILL_INDEX_LINES && lines.every(line => [...line].length <= SKILL_INDEX_WIDTH) && world.skills.index(SCOPE) === index,
    }, { created: first.created, rejected: first.rejected }, 3);
  } finally { world.close(); }
}

/** A kernel over the world's stores, with the skill memory and the turn routing as server.ts wires them. */
function kernelOf(world: SkillWorld, model: ShannonChatModel) {
  const ports = world.ports();
  const routing = configuredTurnRouting({}, { databasePath: null, database: world.database, choices: world.store.choiceLedger(), skills: ports, defer: task => task() })!;
  const autonomy = createInMemoryAutonomyService(() => AT);
  const api = createLocalApiKernel(() => AT, { chatModel: model, autonomy, skills: ports, turnRouting: routing.routing });
  return { api, routing: routing.routing, autonomy };
}

async function use() {
  const world = new SkillWorld();
  try {
    const { skillId } = world.skills.create(SCOPE, { draft: skill('weekly-review'), evidence: [] }, { carries: () => false }, minutes(-600)) as { skillId: string };
    const model = new SkillReadingModel('weekly-review');
    const { api, routing } = kernelOf(world, model);
    const turn = async (thread: string) => {
      const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: SCOPE, threadId: thread, message: '週末のふりかえりをしたい' } });
      return response.status === 200;
    };
    const ok = await turn('thread-1') && await turn('thread-2');
    const choices = world.store.choiceLedger()!.rows(SCOPE);
    const recorded = choices.filter(row => row.choice === 'skill.use');
    // The owner's next turn in each Talk: no retry or correction (Jev's probability 0.1).
    routing.nextTurn(SCOPE, talkId('thread-1'), 0.1, minutes(5));
    routing.nextTurn(SCOPE, talkId('thread-2'), 0.1, minutes(6));
    const settledUses = world.skills.store.get(SCOPE, skillId)!.uses;
    const settledChoices = world.store.choiceLedger()!.rows(SCOPE).filter(row => row.choice === 'skill.use');
    const night = await world.builder({ maintainer: null, proposer: null }, minutes(60)).consolidate(SCOPE, minutes(-1440), minutes(60));
    return outcome(skillUseScenario, {
      'use.recorded': ok && recorded.length === 2 && recorded.every(row => row.sourceKind === 'skill' && row.sourceId === skillId && row.subjectKind === 'talk')
        && !choices.some(row => row.choice === 'tool.skill.read'),
      'use.settled': settledUses.length === 2 && settledUses.every(item => item.o === 1) && settledChoices.every(row => row.status === 'settled' && row.serve === 1),
      'use.activated': night.accepted === 1 && world.skills.store.get(SCOPE, skillId)!.status === 'active' && world.skills.store.audits(SCOPE)[0]?.status === 'accepted',
    }, { uses: settledUses.length, recorded: recorded.length }, 4);
  } finally { world.close(); }
}

async function retire() {
  const world = new SkillWorld();
  try {
    const { skillId } = world.skills.create(SCOPE, { draft: skill('weekly-review'), evidence: [] }, { carries: () => false }, minutes(-600)) as { skillId: string };
    const model = new SkillReadingModel('weekly-review');
    const { api, routing, autonomy } = kernelOf(world, model);
    for (let index = 0; index < 6; index += 1) {
      await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: SCOPE, threadId: `thread-${index}`, message: '週末のふりかえりをしたい' } });
      // Every time, the owner corrects her (Jev's probability 0.9).
      routing.nextTurn(SCOPE, talkId(`thread-${index}`), 0.9, minutes(index + 1));
    }
    const night = await world.builder({ maintainer: null, proposer: null }, minutes(60)).consolidate(SCOPE, minutes(-1440), minutes(60));
    const read = await autonomy.tools.call('skill.read', JSON.stringify({ name: 'weekly-review' }), { scopeKey: SCOPE, surface: 'text', audience: 'owner_alone', memory: toolSessionMemory() });
    return outcome(skillRetireScenario, {
      'retire.night': night.retired === 1 && world.skills.store.get(SCOPE, skillId)!.status === 'retired',
      'retire.out_of_index': world.skills.index(SCOPE) === '' && read.failure === 'not_found',
    }, { uses: world.skills.store.get(SCOPE, skillId)!.uses.length }, 7);
  } finally { world.close(); }
}

async function guest() {
  const world = new SkillWorld();
  try {
    world.skills.create(SCOPE, { draft: skill('weekly-review'), evidence: [] }, { carries: () => false }, minutes(-600));
    const model = new SkillReadingModel(null);
    const { api } = kernelOf(world, model);
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: SCOPE, threadId: 'thread-o', message: '週末のふりかえりをしたい', audience: 'others' } });
    const text = model.requests.at(-1) as ShannonChatModelRequest;
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: { scopeKey: SCOPE, threadId: 'thread-v', transcript: '書斎のメモを読んで',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, companionPresent: true, userUtterance: { id: 'u-1', text: '書斎のメモを読んで', source: 'speech', rawText: '書斎のメモを読んで' } } } });
    const voice = model.requests.at(-1) as ShannonVoiceModelRequest;
    const offered = (request: { tools?: { definitions: readonly { name: string }[]; menu?: { offered: readonly { name: string }[] } } }) => (request.tools?.menu?.offered ?? request.tools?.definitions ?? []).some(tool => tool.name === 'skill.read');
    const refused = authorizeToolCall(shannonTool('skill.read'), { scopeKey: SCOPE, surface: 'text', audience: 'others' });
    world.store.appendTurn(SCOPE, 'thread-g', '友だちとふりかえりの話', 'いいですね。', minutes(-30), { capturedStateVersion: 0, messageEmotion: emotion, audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' });
    world.store.appendTurn(SCOPE, 'thread-a', '二人でふりかえりの話', 'はい。', minutes(-20), { capturedStateVersion: 0, messageEmotion: emotion });
    const seeds = skillSeedSources(world.store, null).experiences(SCOPE, minutes(-1440), minutes(0));
    return outcome(skillGuestScenario, {
      'guest.no_index': !(text.profilePrompt ?? '').includes(SKILL_INDEX_HEADER) && !(voice?.profilePrompt ?? '').includes(SKILL_INDEX_HEADER),
      'guest.no_tool': !offered(text) && !(voice && offered(voice)) && refused?.failure === 'not_offered',
      'guest.no_seed': seeds.length === 1 && seeds[0]!.summary !== '' && !seeds.some(item => item.text.includes('友だち')),
    }, { seeds: seeds.length }, 4);
  } finally { world.close(); }
}

/** A failed episode (an Aether search that did not find it, the owner corrected her) becomes a page, and the page a skill. */
async function pattern() {
  const world = new SkillWorld();
  try {
    const choices = world.store.choiceLedger()!;
    choices.recordConversation(SCOPE, { surface: 'text', choice: 'tool.aether.search', context: 'evening.alone', sourceKind: 'tool_call', sourceId: 'call-1' }, 0, 'talk-1', minutes(-30));
    choices.settleTalk(SCOPE, 'talk-1', 0, minutes(-29));
    const failed = choices.rows(SCOPE)[0]!;
    const maintainer = scripted(input => {
      const failure = (input.evidence as Array<{ id: string; kind: string; text: string }>).find(item => item.kind === 'failure');
      return { operations: failure ? [page('探す前に場所を聞く', '資料を探す前に、どのフォルダかを確かめる。広く探すと外れたから。', [failure.id], 'failure')] : [] };
    });
    const proposer = scripted(input => (input.round === 1 ? { ...proposal('x', []), action: 'open', open: indexIds(input) }
      : proposal('find-documents', indexIds(input), { description: '資料を探す時' })));
    await world.builder({ maintainer, proposer }, minutes(0)).consolidate(SCOPE, minutes(-1440), minutes(0));
    const [made] = world.skills.patterns(SCOPE);
    const [skillMade] = world.skills.store.all(SCOPE);
    // A turn after the night: the request carries the index, never the page.
    const model = new SkillReadingModel(null);
    const { api } = kernelOf(world, model);
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: SCOPE, threadId: 'thread-p', message: '資料を探して' } });
    const request = JSON.stringify(model.requests.at(-1));
    return outcome(skillPatternScenario, {
      'pattern.from_failure': made?.kind === 'failure' && made.sources.includes(`choice:${failed.choiceId}`) && made.body.includes('から'),
      'pattern.feeds_skill': ((proposer.inputs[1]?.opened as Array<{ id: string }> | undefined)?.[0]?.id === made?.patternId) && skillMade?.purposePatternIds[0] === made?.patternId,
      'pattern.not_in_turns': !request.includes('広く探すと外れた') && request.includes('find-documents'),
    }, { pages: world.skills.patterns(SCOPE).length }, 3);
  } finally { world.close(); }
}

/** A patch that did worse than the version before it is reverted, after a safety snapshot, and audited. */
async function trial() {
  const world = new SkillWorld();
  try {
    const { skillId } = world.skills.create(SCOPE, { draft: skill('weekly-review'), evidence: [] }, { carries: () => false }, minutes(-600)) as { skillId: string };
    const { api, routing } = kernelOf(world, new SkillReadingModel('weekly-review'));
    const uses = async (prefix: string, outcomes: boolean[], start: number) => {
      for (const [index, good] of outcomes.entries()) {
        await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: SCOPE, threadId: `${prefix}-${index}`, message: '週末のふりかえりをしたい' } });
        routing.nextTurn(SCOPE, talkId(`${prefix}-${index}`), good ? 0.1 : 0.9, minutes(start + index));
      }
    };
    await uses('before', [true, true, true], 10);
    await world.builder({ maintainer: null, proposer: null }, minutes(60)).consolidate(SCOPE, minutes(-1440), minutes(60));
    const page = (world.skills.createPattern(SCOPE, { kind: 'strategy', title: '十個挙げる', body: '多く挙げると漏れがない。' }, [], { carries: () => false }, minutes(70)) as { patternId: string }).patternId;
    const proposer = scripted(input => (input.round === 1 ? { ...proposal('weekly-review', [page]), operation: 'patch', skillId, expectedVersion: 1,
      replacements: [{ find: '三つ挙げる', replace: '十個挙げる' }] } : { ...proposal('x', []), action: 'none' }));
    await world.builder({ maintainer: null, proposer }, minutes(80)).consolidate(SCOPE, minutes(-1440), minutes(80));
    const started = world.skills.store.get(SCOPE, skillId)!;
    await uses('after', [false, false, true], 100);
    const night = await world.builder({ maintainer: null, proposer: null }, minutes(200)).consolidate(SCOPE, minutes(-1440), minutes(200));
    const restored = world.skills.store.get(SCOPE, skillId)!;
    const audit = world.skills.store.audits(SCOPE).find(entry => entry.kind === 'patch');
    const revisions = world.skills.store.revisions(SCOPE, skillId);
    return outcome(skillTrialScenario, {
      'trial.started': started.status === 'trial' && started.trialBaseVersion === 1 && audit?.baselineRate === 1,
      'trial.reverted': night.reverted === 1 && restored.status === 'active' && restored.body === revisions.find(item => item.version === 1)!.body
        && revisions.some(item => item.kind === 'snapshot' && item.version === 2),
      'trial.audited': audit?.status === 'reverted' && audit.trialUses === 3 && audit.trialSuccesses === 1 && audit.diff.includes('+ ') && audit.purposePatternIds[0] === page,
    }, { baseline: audit?.baselineRate ?? -1 }, 9);
  } finally { world.close(); }
}

/** A reverted change proposed again is refused by the audit, and the proposer was shown it. */
async function audit() {
  const world = new SkillWorld();
  try {
    const { skillId } = world.skills.create(SCOPE, { draft: skill('weekly-review'), evidence: [] }, { carries: () => false }, minutes(-600)) as { skillId: string };
    const ok = { carries: () => false };
    const use = (prefix: string, outcomes: boolean[], start: number) => outcomes.forEach((good, index) => {
      world.skills.used(SCOPE, 'weekly-review', { talk: `${prefix}-${index}`, growth: 1 }, minutes(start + index * 2));
      world.skills.nextTurn(SCOPE, `${prefix}-${index}`, good ? 1 : 0, minutes(start + index * 2 + 1));
    });
    use('a', [true, true], -590);
    world.skills.lifecycle(SCOPE, minutes(-580));
    const page = (world.skills.createPattern(SCOPE, { kind: 'strategy', title: '十個挙げる', body: '多く挙げると漏れがない。' }, [], ok, minutes(-570)) as { patternId: string }).patternId;
    const replacements = [{ find: '三つ挙げる', replace: '十個挙げる' }];
    world.skills.revise(SCOPE, skillId, 1, { replacements, evidence: [], purposePatternIds: [page] }, ok, minutes(-560));
    use('b', [false, false, false], -550);
    world.skills.lifecycle(SCOPE, minutes(-540));
    // The next night the proposer offers the same change again.
    const proposer = scripted(input => (input.round === 1 ? { ...proposal('weekly-review', [page]), operation: 'patch', skillId, expectedVersion: 3, replacements } : { ...proposal('x', []), action: 'none' }));
    const before = world.skills.store.get(SCOPE, skillId)!;
    const night = await world.builder({ maintainer: null, proposer }, minutes(0)).consolidate(SCOPE, minutes(-1440), minutes(0));
    const after = world.skills.store.get(SCOPE, skillId)!;
    const shown = proposer.inputs[0]?.reverted as Array<{ target: string }> | undefined;
    return outcome(skillAuditScenario, {
      'audit.refused': night.rejections.includes('audit_reverted') && after.version === before.version && after.body === before.body,
      'audit.shown': Boolean(shown?.some(item => item.target === `skill:${skillId}`)),
    }, { reverted: world.skills.store.audits(SCOPE).filter(entry => entry.status === 'reverted').length }, 4);
  } finally { world.close(); }
}

const driver = (run: () => Promise<ReturnType<typeof outcome>>): ReachDriver => async () => run();

export function skillDrivers(): Record<string, () => ReachDriver> {
  return {
    [skillFormScenario.id]: () => driver(form),
    [skillUseScenario.id]: () => driver(use),
    [skillRetireScenario.id]: () => driver(retire),
    [skillGuestScenario.id]: () => driver(guest),
    [skillPatternScenario.id]: () => driver(pattern),
    [skillTrialScenario.id]: () => driver(trial),
    [skillAuditScenario.id]: () => driver(audit),
  };
}

