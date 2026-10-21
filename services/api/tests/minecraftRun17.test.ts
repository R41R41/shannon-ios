import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { garbledRequest, parseOperatorEnvelope } from '../src/contracts/operatorContract.js';
import { createFcaProgressTools, FCA_CONDITIONS_REQUIRED } from '../src/mind/action/fca/fcaProgressTools.js';
import type { FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { toolOk } from '../src/mind/tools/toolRegistryPorts.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { MINECRAFT_REQUEST_CRITERIA } from '../src/wiring/fcaMinecraftRequests.js';
import { operatorRequestTask } from '../src/wiring/operatorMinecraftRequests.js';
import { OPERATOR_TITLE_PREFIX } from '../src/contracts/operatorContract.js';
import { CREEPER_FIGHT_REFUSAL, creeperFightRefusal } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { fastBodyState, fastJudgment, type FastBodyState } from '../src/mind/action/reflex/fastJudgment.js';
import { bedSearchMemory, minecraftSituation, minecraftSkillPointers } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { milestoneLines } from '../src/surfaces/minecraft/minecraftStage.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { SKILL_GIST, skillGist } from '../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import { observeOnlyStep } from '../src/surfaces/minecraft/minecraftSkillPointers.js';

/**
 * Minecraft run 17 (2026-10-19, tasks c6a3111e and 446e2865): a garbled request closed as done after 8 decisions, the root's common
 * task woken by it for a 117k-token decision, a creeper fought, iron mined 3, 8, 8 and 13 at a time, no village looked for.
 */
const GARBLED = '繧ｨ繝ｳ繝峨Λ繧定ｨ惹ｼ舌＠縺ｦ縺上□縺輔＞';

describe('the operator\'s request refuses garbled text', () => {
  it('refuses run 17\'s request and the usual mojibake, and takes ordinary requests', () => {
    expect(garbledRequest(GARBLED)).toBe('halfwidth_kana_with_kanji');
    expect(garbledRequest('エンドラを討伐�ください')).toBe('replacement_character');
    expect(garbledRequest('縺ｦ縺上□縺輔＞')).not.toBeNull();
    expect(garbledRequest('繧繝のテスト')).toBe('cp932_lead_kanji');
    expect(garbledRequest('ã‚¨ãƒ³ãƒ‰ãƒ©')).toBe('latin1_mojibake');
    for (const ok of ['エンドラを討伐してください', 'Kill the Ender Dragon!', 'ﾀﾞｲﾔを3個掘って', 'エンダー･ドラゴンを倒して', '｢鉄｣を集めて', 'São Paulo', '鉄を30個掘って', 'Café']) {
      expect(garbledRequest(ok)).toBeNull();
    }
    const parsed = parseOperatorEnvelope({ v: 1, operator: 'ryo', domain: 'minecraft', op: 'request', args: { goal: GARBLED } });
    expect(parsed).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope({ v: 1, operator: 'ryo', domain: 'minecraft', op: 'request', args: { goal: 'エンドラを討伐してください' } }))
      .toMatchObject({ ok: true, input: { command: 'request', goal: 'エンドラを討伐してください' } });
  });
});

describe('a body task bound to no goal completes only on conditions of its own that pass', () => {
  const definition: FcaToolDefinition = { name: 'mc.goal-evidence', description: 'fixture', effect: 'read', cost: 'none', domain: 'minecraft_body',
    input: { type: 'object', properties: {}, required: [], additionalProperties: false }, audiences: ['owner_alone'], surfaces: ['text'] };
  const call = { scopeKey: 'owner', taskId: 'task', operationId: 'step:verify', name: 'goal.verify', input: {}, signal: new AbortController().signal };
  const tools = (requireConditions: boolean, value: unknown) => createFcaProgressTools({ definitions: [definition],
    async execute() { return toolOk(JSON.stringify(value)); } }, { permit: async () => {}, requireConditions });
  it('turns run 17\'s "done, not achieved" back to work, and says why in her progress', async () => {
    const held = tools(true, { stone_axe: 1 });
    expect(held.progress.context().completionRule).toBe(FCA_CONDITIONS_REQUIRED);
    expect((await held.progress.verifyCompletion(call, async () => {})).status).toBe('not_verified');
    // A condition of hers that does not pass: still not done.
    await held.execute({ ...call, name: 'goal.set_conditions', input: { conditions: [{ id: 'axe', tool: definition.name, input: {}, path: 'diamond_pickaxe', operator: 'exists' }] } });
    expect((await held.progress.verifyCompletion(call, async () => {})).status).toBe('not_verified');
    // One that passes on a new observation: done, as she reported it.
    await held.execute({ ...call, name: 'goal.set_conditions', input: { conditions: [{ id: 'axe', tool: definition.name, input: {}, path: 'stone_axe', operator: 'gte', expected: 1 }] } });
    expect((await held.progress.verifyCompletion(call, async () => {})).status).toBe('self_reported');
    // Any other task: as before.
    const free = tools(false, {});
    expect(free.progress.context().completionRule).toBeUndefined();
    expect((await free.progress.verifyCompletion(call, async () => {})).status).toBe('self_reported');
  });
});

describe('an operator\'s request does not wake the root when it ends', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  const at = '2026-10-19T16:12:00.000Z';
  function fixture(reportsToParent?: (task: Parameters<typeof operatorRequestTask>[0]) => boolean) {
    const db = new DatabaseSync(':memory:'); databases.push(db); db.exec('PRAGMA foreign_keys=ON'); migrateAgentTasks(db);
    const authority = new SQLiteFcaTaskAuthority(db), actions = new SQLiteActionStore(db);
    const hub = new SQLiteTaskRuntimeStore(db, { authority, now: () => at, ...(reportsToParent ? { reportsToParent } : {}), leaseValid(scope, taskId, lease, time) {
      const action = actions.check(lease, time);
      return Boolean(action && action.scopeKey === scope && action.sourceId.startsWith(`fca-${taskId}-`));
    } });
    const root = hub.ensureRoot('owner');
    const finishChild = (title: string) => {
      const child = hub.createChild('owner', root.id, { title, goal: 'エンドラを討伐してください', completionCriteria: MINECRAFT_REQUEST_CRITERIA }, title);
      const task = hub.get('owner', child.id)!;
      const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `fca-${child.id}-${task.revision}`, kind: 'agentTask', origin: 'owner_request' }, at).id, 'worker', at)!;
      const step = hub.beginStep('owner', child.id, leaseOf(action), task.revision)!;
      hub.commitStep(step, { disposition: 'complete', summary: '討伐は達成していません' });
      actions.finish(step.lease, 'completed', 'yielded', at); hub.acknowledgeReceipt('owner', step.id);
      return hub.snapshot('owner', root.id)!.messages.filter(message => message.sourceTaskId === child.id);
    };
    return { finishChild };
  }
  it('sends no result to the root for an operator\'s request; any other child reports as before', () => {
    const quiet = fixture(task => !operatorRequestTask(task, MINECRAFT_REQUEST_CRITERIA));
    expect(quiet.finishChild(`${OPERATOR_TITLE_PREFIX}エンドラを討伐してください`)).toEqual([]);
    expect(quiet.finishChild('エンドラを討伐してください')).toHaveLength(1);
    expect(fixture().finishChild(`${OPERATOR_TITLE_PREFIX}エンドラを討伐してください`)).toHaveLength(1);
  });
});

describe('a creeper is never fought', () => {
  it('refuses her fight against a creeper before it is sent, and names the moves that work', () => {
    for (const [name, input] of [['mc.combat', { target: 'creeper', timeout: 15 }], ['mc.attack-continuously', { entityName: 'Creeper' }]] as const) {
      expect(creeperFightRefusal(name, input)).toMatchObject({ ok: false, failure: 'refused', retryable: false, text: CREEPER_FIGHT_REFUSAL });
    }
    expect(creeperFightRefusal('mc.combat', { target: 'zombie' })).toBeNull();
    expect(creeperFightRefusal('mc.attack-continuously', { entityName: 'hostile' })).toBeNull();
    expect(creeperFightRefusal('mc.flee-from', { target: 'creeper' })).toBeNull();
  });
  const state = (overrides: Partial<FastBodyState>): FastBodyState => ({ health: 20, threats: [], night: false, respawnedRecently: false,
    healthDropped: false, hasWeapon: true, floorActive: false, floorKnown: true, shelterFailed: false, resting: new Set(), canCage: false,
    canTower: false, ...overrides });
  const verdict = (overrides: Partial<FastBodyState>) => { const value = fastJudgment(state(overrides)); return 'decision' in value ? `${value.decision.rule}:${value.decision.skill}` : value.hold; };
  const creeper = (distance: number) => ({ name: 'creeper', distance, canReachMe: true, ignited: false });
  const zombie = (distance: number) => ({ name: 'zombie', distance, canReachMe: true, ignited: false });
  it('flees a creeper within 10 m by day, never fights beside one, and climbs a pillar when running failed', () => {
    // Run 17: a creeper at 6-9 m by day opened nothing, and a zombie beside it was fought (the fight's target is any hostile).
    expect(verdict({ threats: [creeper(9)] })).toBe('creeper_flee:flee-from');
    expect(verdict({ threats: [zombie(3), creeper(8)] })).toBe('creeper_flee:flee-from');
    expect(verdict({ threats: [zombie(3), creeper(12)] })).toBe('melee_fight:attack-continuously');
    // Running failed (the flee rests): up three blocks when she carries them, else run again.
    expect(verdict({ threats: [creeper(5)], resting: new Set(['flee-from']), canTower: true })).toBe('creeper_tower:tower-up');
    expect(fastJudgment(state({ threats: [creeper(5)], resting: new Set(['flee-from']), canTower: true }))).toMatchObject({ decision: { arguments: { height: 3 } } });
    expect(verdict({ threats: [creeper(5)], resting: new Set(['flee-from']), canTower: false })).toBe('creeper_flee:flee-from');
    expect(verdict({ threats: [creeper(5)], resting: new Set(['flee-from', 'tower-up']), canTower: true })).toBe('creeper_flee:flee-from');
    // An ignited one within 4.5 m stays the body's floor.
    expect(verdict({ threats: [{ ...creeper(3), ignited: true }] })).toBe('floor_creeper');
    const frame = { facts: { floorActive: false }, state: { world: { health: 20, nearbyThreats: [creeper(5)], inventory: [{ name: 'cobblestone', count: 3 }] } } };
    expect(fastBodyState(frame, { earlierHealth: null, sinceArrivalMs: null }).canTower).toBe(true);
  });
});

describe('a village looked for once in the task, by day, even when the night took the first day', () => {
  const MORNING = { time: '100', margin: { darkInSeconds: 645 } }, NIGHT = { time: '15000' };
  const observation = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: 'x', receivedAt: 'x',
    connected: true, state: { world: { dimension: 'overworld', health: 20, food: 20, nearbyThreats: [], ...world,
      inventory: (world.inventory as string[] | undefined ?? []).map(item => { const [name, count] = item.split('×'); return { name, count: Number(count ?? 1) }; }) } },
    facts: { dimension: 'overworld' } }) as unknown as BodyObservation;
  const ALL = new Set(['mc-food-and-bed', 'mc-iron-and-bucket', 'mc-first-day', 'mc-night-retreat']);
  const pointers = (world: Record<string, unknown>, villageSearched?: boolean) =>
    minecraftSkillPointers(minecraftSituation(observation(world), { failedStepsInARow: 0, ...(villageSearched === undefined ? {} : { villageSearched }) }), ALL);
  it('points the village search by day from the stone tools to iron until she has looked, and never at night', () => {
    // Run 17: dawn with a stone pickaxe, a bed and food (stage 3): iron alone was pointed and no village was looked for.
    const stage3 = { ...MORNING, inventory: ['stone_pickaxe×1', 'white_bed×1', 'cooked_beef×6'] };
    // After the stage's own pointer (review: it must not push iron out of the three slots).
    expect(pointers(stage3, false)).toEqual(['mc-iron-and-bucket（鉄のツルハシ・バケツ・鉄の全身の防具のどれかが無い）', 'mc-food-and-bed（村をまだ探していない（明るい間に一度））']);
    expect(pointers(stage3, true)).toEqual(['mc-iron-and-bucket（鉄のツルハシ・バケツ・鉄の全身の防具のどれかが無い）']);
    expect(pointers({ ...stage3, ...NIGHT, margin: undefined }, false).some(line => line.includes('村をまだ'))).toBe(false);
    expect(pointers({ ...MORNING, inventory: ['oak_log×3'] }, false)).toEqual(['mc-first-day（石のツルハシがまだ無い）']);
    // A caller that does not track it: never pointed (as before).
    expect(pointers(stage3)).toEqual(['mc-iron-and-bucket（鉄のツルハシ・バケツ・鉄の全身の防具のどれかが無い）']);
  });
  it('marks the search once an explore or find for a village answers, and keeps it in the checkpoint', () => {
    const memory = bedSearchMemory(null, undefined);
    expect(memory.facts(null)).toMatchObject({ villageSearched: false });
    memory.note({ name: 'mc.explore-for-structure', input: { structureType: 'stronghold' } }, { ok: true, text: '' }, () => null);
    memory.note({ name: 'mc.explore-for-structure', input: { structureType: 'village' } }, { ok: false, text: '' }, () => null);
    expect(memory.checkpoint()).toEqual({ minecraftNoSheepDarkIn: null, minecraftVillageSearched: false });
    memory.note({ name: 'mc.explore-for-structure', input: { structureType: 'Village', maxDistance: 160 } }, { ok: true, text: '見つからない' }, () => null);
    expect(memory.checkpoint()).toEqual({ minecraftNoSheepDarkIn: null, minecraftVillageSearched: true });
    expect(bedSearchMemory(null, true).facts(null)).toMatchObject({ villageSearched: true });
  });
});

describe('the iron taken all at once (milestone and draft-9)', () => {
  const pack9 = () => standardSkillPack('legacy-minecraft', 'draft-9')!, pack8 = () => standardSkillPack('legacy-minecraft', 'draft-8')!;
  const gistOf = (name: string) => skillGist(pack9().skills.find(entry => entry.name === name)!.body, observeOnlyStep);
  it('says in the milestone to take 24 first and the rest next (36 in all), not to go back for it later (mb-r23; thirty at once before)', () => {
    const counts = carriedItemCounts({ inventory: [{ name: 'stone_pickaxe', count: 1 }, { name: 'white_bed', count: 1 }, { name: 'cooked_beef', count: 6 }] }, {});
    expect(milestoneLines({ counts, dimension: 'overworld', netherReached: false })[0]).toMatch(/鉄鉱石は最初に24個、続けて残りを掘る（全部で36個/u);
  });
  it('revises five draft-8 skills, not the night retreat (used in run 17: on trial)', () => {
    expect(pack9().skills.map(entry => entry.name)).toEqual(['mc-first-day', 'mc-food-and-bed', 'mc-iron-and-bucket', 'mc-diamond-obsidian', 'mc-food-and-pace', 'mc-night-shelter']);
    for (const entry of pack9().skills.filter(skill => skill.name !== 'mc-night-shelter')) {
      expect(entry.revises).toEqual({ bodySha256: pack8().skills.find(skill => skill.name === entry.name)!.sha256 });
      expect(skillArtifactSha256(entry.body)).toBe(entry.sha256);
      const gist = gistOf(entry.name);
      expect(gist).toHaveLength(SKILL_GIST.lines);
      expect(gist.every(line => [...line].length <= SKILL_GIST.width && !line.endsWith('…'))).toBe(true);
      expect(gist[0]).toMatch(/mc\.[a-z][a-z-]*/u);
    }
    expect(gistOf('mc-iron-and-bucket').join('')).toMatch(/mc\.mine-block（blockName=iron_ore、count=30.*かまどを2台.*半分ずつ.*待たず.*予備のツルハシ/u);
    expect(pack9().skills.find(entry => entry.name === 'mc-iron-and-bucket')!.body).toMatch(/33個.*3個や8個ずつ掘って精錬を待つのを繰り返さない/u);
    expect(gistOf('mc-first-day').join('')).toMatch(/原木（丸太のブロック）を4個.*count=4.*先に石の斧.*石の斧で残りの原木.*12〜16個/u);
    expect(gistOf('mc-food-and-bed')[0]).toMatch(/mc\.explore-for-structure（structureType=village、maxDistance=160）を2回。夜に逃したら明けてすぐ/u);
    for (const name of ['mc-first-day', 'mc-iron-and-bucket', 'mc-diamond-obsidian']) expect(pack9().skills.find(entry => entry.name === name)!.body).toMatch(/クリーパーとは戦わない|クリーパーを見たら戦わずに離れる/u);
  });
});
