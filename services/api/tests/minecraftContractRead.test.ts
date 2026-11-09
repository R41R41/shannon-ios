import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaExternalTools, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA, SHORT_ACT_MANUAL_FRAGMENTS } from '../src/contracts/minecraftActShortContract.js';
import { createMinecraftContractBook } from '../src/contracts/minecraftContractBook.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { fcaMinecraftTools, combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { llmcTools } from '../src/wiring/minecraftLlmcConfiguration.js';
import { gameOnlyStepPorts } from '../src/wiring/minecraftGameOnly.js';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import { candidateMenuTools, minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { pinFcaCoreTools, replayAnchor } from '../src/mind/action/fca/fcaCoreTools.js';
import { fcaTransientHistory, shouldForceFcaEpoch } from '../src/mind/action/fca/fcaCoreHistory.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { toolOk } from '../src/mind/tools/shannonTools.js';
import { madeInOf } from '../src/surfaces/minecraft/minecraftMadeIn.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { LLMC_CATALOG_SELECTOR } from '../src/wiring/minecraftLlmcConfiguration.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const names = (text: string) => text.match(/mc\/act\/[a-z-]+@[a-f0-9]{20}/gu) ?? [];
const at = '2026-11-05T00:00:00.000Z';
function setup(taskId = 'contract-task') {
  const h = actionHarness(() => at); cleanups.push(() => h.close());
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [
    { serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const store = new MinecraftControlStore(h.db);
  const control = new MinecraftControl(store, configuration, { now: () => Date.parse(at), ownerAlone: () => true, leaseValid: () => true });
  const bodyId = 'minecraft:world';
  let sequence = 0, connection = 'connection-a', actualSkills = [{ name: 'act', description: 'native act declaration', readOnly: false, inputSchema: ACT_INPUT_SCHEMA }];
  let life = 1, dimensionSince = at;
  const poll = () => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: connection,
    observation: { schemaVersion: 1, bodyId, sequence: sequence++, stateAt: at, receivedAt: at, connected: true,
      state: { life: { life, alive: true, since: at, dimension: 'overworld', dimensionSince }, bodyRun: { bodyBoot: 'native-body-boot', connectionId: connection } }, facts: {} },
    skills: actualSkills, candidates: [], receipts: [], activeOperationIds: [] });
  poll(); store.bind(taskId, bodyId);
  let lastRead = madeInOf(control.observe(bodyId), control.headBoot());
  const step = { id: 'step-contract', taskId, scopeKey: 'owner', revision: 1, lease: { id: 'lease-contract', generation: 1 },
    snapshot: { checkpoint: {}, task: { id: taskId, title: 'Minecraft', goal: '素材を集める', completionCriteria: '観測で確認', createdAt: at } } } as unknown as TaskStep;
  let visible = true, alone = true, publicGame = false;
  const nativeFor = (ownedStep: TaskStep) => fcaMinecraftTools({ control, step: ownedStep, ownerAlone: () => alone, sourcesVisible: () => visible, gameplayAllowed: () => publicGame,
    llmc: { plan: () => undefined, queue: {} as never, madeIn: () => lastRead } });
  const native = nativeFor(step);
  const personalDefinition: FcaToolDefinition = { name: 'skill.read', description: 'personal skill reader', domain: 'skill_read', effect: 'read', cost: 'none',
    audiences: ['owner_alone'], surfaces: ['text'], input: { type: 'object', properties: {}, required: [], additionalProperties: false } };
  const personalRead = vi.fn(async () => toolOk('PRIVATE SKILL MUST NEVER APPEAR'));
  const personal: FcaExternalTools = { definitions: [personalDefinition], execute: personalRead, permitsItself: () => true };
  const progress = createFcaProgressTools(combineFcaTools(personal, native), { permit: async () => {} });
  const tools = gameOnlyStepPorts({ tools: llmcTools(progress) }, taskId).tools!;
  const pointers = () => names(tools.definitions.find(tool => tool.name === 'mc.act')!.description);
  const call = (name: string, changes: Record<string, unknown> = {}) => tools.execute({ scopeKey: 'owner', taskId, operationId: 'read-contract',
    name: 'skill.read', input: { name }, signal: new AbortController().signal, ...changes });
  return { h, nativeFor, native, tools, control, personal, personalRead, personalDefinition, pointers, call, taskId,
    scope: () => { visible = false; }, others: () => { alone = false; }, public: () => { publicGame = true; },
    changeCatalog: () => { actualSkills = actualSkills.map(skill => ({ ...skill, description: 'native declaration changed' })); poll(); },
    changeSchema: () => { actualSkills = actualSkills.map(skill => ({ ...skill, inputSchema: { ...ACT_INPUT_SCHEMA, description: 'native schema changed' } })); poll(); },
    reconnect: () => { connection = 'connection-b'; poll(); },
    nextLife: () => { life += 1; poll(); }, nextDimensionEpoch: () => { dimensionSince = '2026-11-05T00:01:00.000Z'; poll(); },
    freshDecision: () => { lastRead = madeInOf(control.observe(bodyId), control.headBoot()); },
  };
}

describe('native-only contract read through the same normal/rig tools entry', () => {
  it('delivers the v2 shoot facts from the new index and refuses the previous one-line manual pointer', async () => {
    const f = setup(), pointer = f.pointers().find(name => name.startsWith('mc/act/shoot@'))!;
    const result = await f.call(pointer);
    expect(result.ok).toBe(true);
    const delivered = JSON.parse(result.text);
    const canonical = SHORT_ACT_MANUAL_FRAGMENTS.find(part => part.id === 'shoot')!;
    expect(delivered.text).toBe(canonical.text);
    for (const fact of ['13m 以上・64m 以内', '未読を含む射線の開通・安全は証明しない',
      '最後の照準待ち後', '放す代わりに持ち替えて止める', 'done や「射った」は命中・結晶破壊の保証ではない',
      '照準開始から飛行待ち終了までの相手の被害通知', '自分の矢が原因かまでは確定しない',
      'すでに放った矢の飛行は取り消せない']) expect(delivered.text).toContain(fact);
    const parent = createMinecraftContractBook({ catalogHash: delivered.catalogHash }, { schema: SHORT_ACT_INPUT_SCHEMA,
      fragments: SHORT_ACT_MANUAL_FRAGMENTS.map(part => part.id === 'shoot'
        ? { ...part, text: part.text.split('\n')[0]! } : part) });
    const oldPointer = parent.pages.find(page => page.name.startsWith('mc/act/shoot@'))!.name;
    expect(oldPointer).not.toBe(pointer);
    const refused = await f.call(oldPointer);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain(pointer);
    expect(f.personalRead).not.toHaveBeenCalled();
  });

  it('runs a discovered contract read through the actual FCA task runner and closes its readonly result', async () => {
    const f = setup(), requests: FcaModelInput[] = [], sent = vi.spyOn(f.control, 'command');
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('paid network forbidden'));
    const fixture = scriptedAnthropic((body, index) => index > 0
      ? message([{ type: 'tool_use', id: 'complete-read', name: 'fca_complete', input: { summary: '契約の実read結果を受け取った' } }], 'tool_use', { model: 'claude-haiku-5-5' })
      : message([{ type: 'tool_use', id: 'book-read', name: 'skill_read', input: { name: names((body.tools as Array<{ name: string; description: string }>).find(tool => tool.name === 'mc_act')!.description)[0]! } }], 'tool_use', { model: 'claude-haiku-5-5' }));
    const model = createAnthropicFcaModel({ apiKey: 'offline-synthetic', model: 'claude-haiku-5-5', fetcher: fixture.fetcher, recordUsage() {},
      minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() });
    const driver = createTaskRuntimeWiring({ db: f.h.db, actions: f.h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
      model: { async decide(input, signal) { requests.push(input); return model.decide(input, signal); },
        toolResults: results => model.toolResults(results) },
      stepPorts: (_runtime, ownedStep) => gameOnlyStepPorts({ keepBodyTools: () => true, obsMode: 'transient' as const, selector: LLMC_CATALOG_SELECTOR, history: { codec: anthropicFcaHistoryCodec },
        body: { start() {}, revision: () => 1, context: () => { f.freshDecision(); return { revision: 1, observation: f.control.observe('minecraft:world') }; },
          readOf: () => madeInOf(f.control.observe('minecraft:world'), f.control.headBoot()), guard: async () => true,
          toolSignal: (_name: string, signal: AbortSignal) => signal, close: async () => {} },
        tools: llmcTools(createFcaProgressTools(combineFcaTools(f.personal, f.nativeFor(ownedStep)), { permit: async () => {} })) }, ownedStep.taskId),
    });
    cleanups.push(() => driver.close());
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: '契約read', goal: 'native契約を1ページ読む' }, 'owner-request');
    for (let i = 0; i < 30 && driver.runtime.get('owner', task.id)?.phase !== 'completed'; i += 1) { await driver.tick(); await driver.drain(); }
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.history)).toContain('minecraft_contract');
    expect(f.personalRead).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(externalFetch).not.toHaveBeenCalled();
    expect(fixture.bodies.every(body => body.model === 'claude-haiku-5-5')).toBe(true);
  });

  it('delivers and reads all nine current pages through fcaMinecraftTools/combine/progress/V2/gameOnly without personal fallback', async () => {
    const f = setup(), send = vi.spyOn(f.control, 'command');
    const pointers = f.pointers();
    expect(pointers).toHaveLength(9);
    expect(f.tools.definitions.filter(tool => tool.name === 'skill.read')).toHaveLength(1);
    expect(f.tools.permitsItself?.('skill.read')).toBe(false);
    expect(f.tools.permitsItself?.('mc.act')).toBe(true);
    expect(f.tools.definitions.find(tool => tool.name === 'mc.act')!.nativeInputSchema).toEqual(SHORT_ACT_INPUT_SCHEMA);
    expect(f.tools.definitions.find(tool => tool.name === 'mc.act')!.description).toContain('sleep [ベッド]');
    for (const pointer of pointers) {
      const result = await f.call(pointer);
      expect(result.ok).toBe(true);
      const doc = JSON.parse(result.text);
      expect(doc.name).toBe(pointer);
      expect(doc.kind).toBe('minecraft_contract');
      expect(SHORT_ACT_DESCRIPTION).toContain(doc.text);
      expect(doc.catalogHashSource).toBe('head_actual_poll_skills_canonical_sha256');
      expect(doc.sourceId).toContain(doc.book);
    }
    expect(f.personalRead).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const replayed = candidateMenuTools(f.tools.definitions);
    expect(replayed.find(tool => tool.name === 'mc.act')!.description).toBe(f.tools.definitions.find(tool => tool.name === 'mc.act')!.description);
    expect(replayed.some(tool => tool.name === 'skill.read')).toBe(true);
  });

  it('does not turn a generic personal skill.read into a V2/game-only capability', async () => {
    const f = setup();
    for (const offered of [llmcTools(f.personal), gameOnlyStepPorts({ tools: f.personal }, f.taskId).tools!]) {
      expect(offered.definitions.some(tool => tool.name === 'skill.read')).toBe(false);
      await expect(offered.execute({ scopeKey: 'owner', taskId: f.taskId, operationId: 'bad', name: 'skill.read', input: { name: 'personal' },
        signal: new AbortController().signal })).rejects.toThrow('FCA_TOOL_NOT_OFFERED');
    }
    expect(candidateMenuTools([f.personalDefinition])).toEqual([]);
    expect(f.personalRead).not.toHaveBeenCalled();
  });

  it('refuses foreign scope/task, revoked sources, cancelled calls, unknown books and arbitrary paths', async () => {
    const f = setup(), pointer = f.pointers()[0]!;
    await expect(f.call(pointer, { scopeKey: 'other-owner' })).rejects.toThrow('FCA_SOURCE_WITHHELD');
    await expect(f.call(pointer, { taskId: 'other-task' })).rejects.toThrow('FCA_SOURCE_WITHHELD');
    for (const input of [{ name: '../api.env' }, { name: 'mc/act/special@old' }, { name: pointer, path: 'secret' }, { name: null }, {}]) {
      expect((await f.call(pointer, { input })).ok).toBe(false);
    }
    const cancelled = new AbortController(); cancelled.abort();
    await expect(f.call(pointer, { signal: cancelled.signal })).rejects.toThrow();
    f.scope();
    await expect(f.call(pointer)).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(f.personalRead).not.toHaveBeenCalled();
  });

  it('checks current audience and does not keep a cached private reader authorised for others', async () => {
    const f = setup(), pointer = f.pointers()[0]!;
    f.others();
    expect((await f.call(pointer)).ok).toBe(false);
    f.public();
    expect((await f.call(pointer)).ok).toBe(true);
    expect(f.personalRead).not.toHaveBeenCalled();
  });

  it.each(['changeCatalog', 'changeSchema'] as const)('refuses an old pointer after %s and delivers a usable current index', async change => {
    const f = setup(), before = f.pointers();
    f[change]();
    const refused = await f.call(before[0]!);
    expect(refused.ok).toBe(false);
    expect(refused.failure).toBe('not_found');
    const fresh = f.pointers();
    expect(fresh).toHaveLength(9);
    expect(fresh).not.toEqual(before);
    expect(names(refused.text)).toEqual(fresh);
    expect((await f.call(fresh[0]!)).ok).toBe(true);
    expect(f.personalRead).not.toHaveBeenCalled();
  });

  it.each(['reconnect', 'nextLife', 'nextDimensionEpoch'] as const)('fences %s with the decision context while preserving an identical contract prefix', async change => {
    const f = setup(), beforePointers = f.pointers(), beforeTools = JSON.stringify(f.tools.definitions);
    f[change]();
    const stale = await f.call(beforePointers[0]!);
    expect(stale.ok).toBe(false);
    expect(stale.failure).toBe('conflict');
    expect(f.pointers()).toEqual(beforePointers);
    expect(JSON.stringify(f.tools.definitions)).toBe(beforeTools);
    f.freshDecision();
    const fresh = await f.call(beforePointers[0]!);
    expect(fresh.ok).toBe(true);
    expect(JSON.parse(fresh.text).connectionId).toBe(change === 'reconnect' ? 'connection-b' : 'connection-a');
    expect(f.personalRead).not.toHaveBeenCalled();
  });

  it('keeps the cached native definitions byte-identical across tasks without sharing their execution scope', async () => {
    const first = setup('task-one'), second = setup('task-two');
    expect(JSON.stringify(first.tools.definitions)).toBe(JSON.stringify(second.tools.definitions));
    expect(first.pointers()).toEqual(second.pointers());
    await expect(first.call(first.pointers()[0]!, { taskId: 'task-two' })).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect((await second.call(second.pointers()[0]!)).ok).toBe(true);
  });

  it('withdraws the source while its actual frame is absent', async () => {
    const f = setup(), pointer = f.pointers()[0]!;
    f.control.frames.clear();
    expect(f.tools.definitions.some(tool => tool.name === 'skill.read')).toBe(false);
    expect((await f.call(pointer)).ok).toBe(false);
    expect(f.personalRead).not.toHaveBeenCalled();
  });

  it('marks a changed book as stale core and lets an existing new epoch advertise the new pointers', async () => {
    const f = setup(), before = pinFcaCoreTools(f.tools.definitions), replay = [{ role: 'user', content: 'epoch-start' }];
    const pin = { ...before, steps: 3, anchor: replayAnchor(replay) };
    f.changeCatalog();
    const state = fcaTransientHistory({ fcaToolSelection: { obsMode: 'transient', core: pin } }, f.tools.definitions,
      { obsMode: 'transient', keepBodyTools: () => true, selector: {}, history: { codec: anthropicFcaHistoryCodec } })!;
    expect(state.stale).toBe('definitions_changed');
    expect(shouldForceFcaEpoch(state, replay, f.taskId)).toBe(true);
    const next = pinFcaCoreTools(f.tools.definitions);
    expect(next.hash).not.toBe(before.hash);
    const newIndex = next.tools.find(tool => tool.name === 'mc.act')!.description;
    for (const pointer of f.pointers()) { expect(newIndex).toContain(pointer); expect((await f.call(pointer)).ok).toBe(true); }
  });

  it('sends the current index/read definition to the final provider body and routes its fake Haiku read back to the native source', async () => {
    const f = setup(), pointer = f.pointers()[0]!;
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('paid network forbidden'));
    const fixture = scriptedAnthropic(() => message([{ type: 'tool_use', id: 'native-contract-read', name: 'skill_read', input: { name: pointer } }], 'tool_use', { model: 'claude-haiku-5-5' }));
    const model = createAnthropicFcaModel({ apiKey: 'offline-synthetic', model: 'claude-haiku-5-5', fetcher: fixture.fetcher, recordUsage() {},
      minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() });
    const transient = { body: { state: 'unchanged', inventory: ['wood:2'] } }, task = { id: f.taskId, title: 'Minecraft', goal: '素材', completionCriteria: '観測' };
    const input: FcaModelInput = { task, messages: [], history: [], tools: f.tools.definitions, coreTools: pinFcaCoreTools(f.tools.definitions).tools,
      transient, body: { revision: 1, observation: null } };
    const before = JSON.stringify({ transient, task });
    const output = await model.decide(input, new AbortController().signal);
    expect(JSON.stringify({ transient, task })).toBe(before);
    const sent = fixture.bodies[0] as Record<string, any>;
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.tools.map((tool: any) => tool.name)).toContain('skill_read');
    expect(sent.tools.find((tool: any) => tool.name === 'mc_act').description).toContain(pointer);
    expect(sent.tools.find((tool: any) => tool.name === 'mc_act').input_schema).toEqual(SHORT_ACT_INPUT_SCHEMA);
    expect(JSON.stringify(sent.system)).toContain('skill_read');
    expect(sent.system.filter((block: any) => block.cache_control).every((block: any) => block.cache_control.ttl === '1h')).toBe(true);
    expect(output.decision.kind).toBe('tools');
    if (output.decision.kind !== 'tools') throw new Error('read call required');
    const read = output.decision.calls[0]!;
    expect(read.name).toBe('skill.read');
    const result = await f.tools.execute({ scopeKey: 'owner', taskId: f.taskId, operationId: 'provider-read', signal: new AbortController().signal, ...read });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.text).name).toBe(pointer);
    expect(f.personalRead).not.toHaveBeenCalled();
    expect(externalFetch).not.toHaveBeenCalled();
  });
});
