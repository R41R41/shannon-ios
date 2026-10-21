import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { combineFcaTools, fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { FcaModel, FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { ACT_DESCRIPTION, ACT_INPUT_SCHEMA, MC_ACT_TOOL, MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { MC_PROBE_TOOL, PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { configuredMinecraftLlmc, llmcModelRouter, llmcProbeRunner } from '../src/wiring/minecraftLlmcWiring.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { INVESTIGATE_KNOWLEDGE, LLMC_SYSTEM_APPENDIX_R4 } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { applyPlanUpdate, planPath } from '@shannon/mind';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { layersMap } from './support/minecraftMaps.js';

/**
 * mb-llmc r4 through the real control and the real request: `mc.probe` sent as the body's `probe` in its form, the head's own probe sent in
 * the step's lease, the cache kept (tools and instructions the same bytes, the investigation in the live message only), and the models a
 * Sonnet main mode is raised to and planned by.
 */
const at = '2026-10-22T00:00:00.000Z', closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.restoreAllMocks(); });

function fixture(decide: (index: number) => { name: string; input: unknown }, extra?: (step: Parameters<typeof llmcProbeRunner>[1], control: MinecraftControl) => FcaToolDefinition[] | null) {
  const h = actionHarness(() => at), calls: FcaModelInput[] = [], bodyStore = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  let sequence = 0;
  const control = new MinecraftControl(bodyStore, configuration, { now: () => Date.parse(at), ownerAlone: () => true, pollMilliseconds: 1,
    leaseValid: lease => !!h.store.check(lease, at)?.resources.includes(actionResource('minebot', 'minecraft-body')) });
  const loose = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const world = { position: { x: 10.5, y: 64, z: -3.5 }, health: 20, nearbyThreats: [{ id: 41, name: 'blaze', distance: 6.2 }] };
  const poll = (receipts: MinecraftControlReceipt[] = []) => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
    schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: at, receivedAt: at, connected: true, state: { world }, facts: {} },
    skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: loose }, { name: 'probe', description: 'the body\'s words', readOnly: true, inputSchema: loose }],
    candidates: [], receipts, activeOperationIds: [],
  } satisfies MinecraftControlPoll);
  poll();
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
    model: { async decide(request) { calls.push(request); const index = calls.length - 1;
      if (index > 0) return { decision: { kind: 'wait', summary: 'next' }, history: [{ role: 'assistant', content: 'read' }] };
      const call = decide(index);
      return { decision: { kind: 'tools', calls: [{ id: 'c-1', name: call.name, input: call.input }] }, history: [{ role: 'assistant', content: 'call' }] }; },
      toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => {
      const body = fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true, llmc: { plan: () => undefined, probe: true } });
      const more = extra?.(step, control);
      return { tools: more ? combineFcaTools(body, { definitions: more, async execute(call) {
        const run = llmcProbeRunner(control, step)();
        if (!run) return { ok: false, text: 'no probe', failure: 'unavailable' as const, retryable: false };
        return { ok: true, text: await run(call.input as never, 0) ?? 'null', retryable: false };
      } }) : body };
    },
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'Nether', goal: 'ネザーへ' }, 'owner-request');
  bodyStore.bind(task.id, 'minecraft:world');
  closes.push(async () => { await driver.close(); h.close(); });
  return { ...h, driver, task, control, bodyStore, calls, poll };
}
async function dispatched(f: ReturnType<typeof fixture>) {
  await f.driver.tick();
  for (let count = 0; count < 1000 && !f.bodyStore.pending('minecraft:world').length; count++) await delay(1);
  return f.poll().commands[0];
}

describe('mc.probe through the control', () => {
  it('offered after the act in the head\'s words; a creature by name is sent as its #id in the body\'s form, and the answer read back', async () => {
    const f = fixture(() => ({ name: MC_PROBE_TOOL, input: { kind: 'sight', target: 'blaze' } })), command = (await dispatched(f))!;
    const offered = f.calls[0]!.tools.filter(tool => /^mc\./u.test(tool.name));
    expect(offered.map(tool => tool.name)).toEqual([MC_ACT_TOOL, MC_PROBE_TOOL]);
    expect(offered[1]).toMatchObject({ description: PROBE_DESCRIPTION, nativeInputSchema: PROBE_INPUT_SCHEMA, effect: 'read' });
    expect(command).toMatchObject({ kind: 'skill', skill: 'probe', arguments: { kind: 'sight', target: '#41' } });
    f.poll([{ id: command.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: at,
      result: JSON.stringify({ v: 1, kind: 'sight', text: '見えない。届かない（6.2m）。間に nether_bricks (11,66,-3)', visible: false }) }]);
    await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    const read = JSON.stringify(f.calls[1]!.history);
    expect(read).toContain('（頭が形を直して送った: target の blaze を一番近い #41（6.2m）にした）');
    expect(read).toContain('見えない。届かない（6.2m）。間に nether_bricks (11,66,-3)');
    expect(read).toContain('\\"visible\\":false');
  });

  it('a probe that cannot be sent is refused before the body sees it', async () => {
    const f = fixture(() => ({ name: MC_PROBE_TOOL, input: { kind: 'path' } }));
    expect(await dispatched(f)).toBeUndefined();
    await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    expect(JSON.stringify(f.calls[1]!.history)).toContain('path には to {x,y,z} が要る');
  });

  it('the head\'s own probe (a surprise\'s) goes as the body\'s probe in the step\'s lease, its answer returned as the body wrote it', async () => {
    const probeTool: FcaToolDefinition = { name: 'test.probe', description: 'x', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      domain: 'meta', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
    const f = fixture(() => ({ name: 'test.probe', input: { kind: 'around', radius: 8 } }), () => [probeTool]);
    const command = (await dispatched(f))!;
    expect(command).toMatchObject({ kind: 'skill', skill: 'probe', arguments: { kind: 'around', radius: 8 }, context: { taskId: f.task.id } });
    expect(command.id).toMatch(/^probe:[0-9a-f]{64}$/u);
    f.poll([{ id: command.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: at,
      result: JSON.stringify({ v: 1, kind: 'around', text: 'blaze #41 6.2m 上 3（見えない）' }) }]);
    await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    expect(JSON.stringify(f.calls[1]!.history)).toContain('blaze #41 6.2m 上 3');
  });
});

describe('the cache with r4 (design 1.7): tools and instructions the same bytes, the investigation and the scan in the live message only', () => {
  const body = (name: string, description: string, schema: Record<string, unknown>, effect: 'read' | 'write'): FcaToolDefinition => ({
    name, description, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, nativeInputSchema: schema,
    domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
  const TOOLS = [body(MC_ACT_TOOL, ACT_DESCRIPTION, ACT_INPUT_SCHEMA, 'write'), body(MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, 'read'),
    body(MC_PROBE_TOOL, PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA, 'read'), PLAN_UPDATE_RULES_DEFINITION];
  const live = (x: number, investigation: string[] = []) => minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(), events: [], investigation,
    observation: { schemaVersion: 1, bodyId: 'b', sequence: x, stateAt: 't', receivedAt: 't', connected: true,
      state: { world: { position: { x, y: 45, z: 277 }, health: 20, localMap: layersMap({ x, y: 45, z: 277 }) } }, facts: {} } });

  it('two decisions, the first after a surprise: the same tools and system, the request only grows, the investigation never stored', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic((_body, index) => message([{ type: 'thinking', thinking: '', signature: `s${index}` },
      { type: 'tool_use', id: `toolu_${index}`, name: 'mc_probe', input: { kind: 'column' } }], 'tool_use'));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {},
      systemAppendix: LLMC_SYSTEM_APPENDIX_R4 });
    const tree = applyPlanUpdate(seedPlan('ネザーへ')!, { ops: [{ op: 'forbid', text: '素手で真下を掘らない' }] }).tree;
    const input = (history: readonly unknown[], x: number, investigation: string[] = []): FcaModelInput => ({
      task: { id: 'task-1', title: 'ネザー', goal: 'ネザーへ', completionCriteria: 'ネザーに入る' }, messages: [], children: [],
      history, tools: TOOLS, coreTools: TOOLS, transient: live(x, investigation), plan: { ...planPath(tree) },
      catalog: TOOLS.map(tool => ({ name: tool.name, description: tool.description })) });
    const first = await model.decide(input([], 201, ['驚き: 1 判断で 8 段下がった（y 53→45）', '調べ column 足の列 y=47〜31: 下 7 段は空気（落差 7）']),
      new AbortController().signal);
    const history = [...first.history, model.toolResults([{ id: 'toolu_0', text: 'y=44〜38 空気×7（落差 7）', ok: true }])];
    await model.decide(input(history, 201), new AbortController().signal);
    const [one, two] = fixture.bodies;
    expect(JSON.stringify(two!.tools)).toBe(JSON.stringify(one!.tools));
    expect(JSON.stringify(two!.system)).toBe(JSON.stringify(one!.system));
    expect(JSON.stringify(one!.system)).toContain('詰まった時の調べ方');
    expect(JSON.stringify(one!.tools)).toContain('mc_probe');
    const before = withoutCacheMarkers(one!.messages as unknown[]), after = withoutCacheMarkers(two!.messages as unknown[]);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    const last = before.at(-1) as { clear_at?: string; content: string };
    expect(last.clear_at).toBe('next_user_message');
    const state = JSON.parse(last.content) as { plan: { rules: string[] }; body: Record<string, unknown> };
    expect(Object.keys(state.body)[0]).toBe('investigation');
    expect(state.plan.rules).toEqual(['禁止: 素手で真下を掘らない']);
    const stored = JSON.stringify(after.filter(item => (item as { clear_at?: string }).clear_at === undefined));
    expect(stored).not.toContain('驚き:');
    expect(stored).not.toContain('素手で真下を掘らない');
    expect((JSON.parse((after.at(-1) as { content: string }).content) as { body: Record<string, unknown> }).body).not.toHaveProperty('investigation');
  });
});

describe('the models of the mode with Sonnet as its main one (shared note 6)', () => {
  it('Sonnet decides, Opus after two failed steps in a row, Opus plans; both decision models read r4\'s instructions', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic(() => message([{ type: 'text', text: 'ok' }], 'end_turn'));
    const lines: string[] = [], planned: Array<Record<string, unknown>> = [];
    const client = { messages: { async create(body: unknown) { planned.push(body as Record<string, unknown>);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"nodes":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } } as never; } } };
    const llmc = configuredMinecraftLlmc({ SHANNON_MINECRAFT_LLM_CENTRIC: 'on', SHANNON_MINECRAFT_LLMC_PROBE: 'on', ANTHROPIC_API_KEY: 'k',
      SHANNON_MINECRAFT_LLMC_MODEL: 'claude-sonnet-5-5' }, { recordUsage() {}, fetcher: fixture.fetcher }, { log: line => lines.push(line), client })!;
    await llmc.planner!('system', 'input', new AbortController().signal);
    expect(planned[0]!.model).toBe('claude-opus-5-5');
    expect(JSON.stringify(planned[0])).toContain('"forbid"');
    expect(llmc.names).toEqual({ main: 'claude-sonnet-5-5', escalate: 'claude-opus-5-5', plan: 'claude-opus-5-5' });
    expect(llmc.probe).toBe(true);
    expect(lines[0]).toBe('Shannon Minecraft LLM-centric models main=claude-sonnet-5-5 escalate=claude-opus-5-5 plan=claude-opus-5-5 probe=on');
    expect(llmcModelRouter(llmc.models, { consecutiveToolFailures: 1 })).toBe(llmc.models.main);
    expect(llmcModelRouter(llmc.models, { consecutiveToolFailures: 2 })).toBe(llmc.models.escalate);
    const tools = [PLAN_UPDATE_RULES_DEFINITION];
    const input: FcaModelInput = { task: { id: 't', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [], children: [], history: [],
      tools, coreTools: tools,
      transient: { map: 'm' }, catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) };
    for (const model of [llmc.models.main, llmc.models.escalate!] as FcaModel[]) await model.decide(input, new AbortController().signal).catch(() => null);
    const sent = fixture.bodies.map(item => ({ model: item.model, system: JSON.stringify(item.system) }));
    expect(sent.map(item => item.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    const heading = INVESTIGATE_KNOWLEDGE.split('\n')[0]!;
    for (const item of sent) expect(item.system).toContain(heading);
    const off = configuredMinecraftLlmc({ SHANNON_MINECRAFT_LLM_CENTRIC: 'on', ANTHROPIC_API_KEY: 'k' }, { recordUsage() {} }, { log: () => {} })!;
    expect(off.probe).toBe(false);
  });
});
