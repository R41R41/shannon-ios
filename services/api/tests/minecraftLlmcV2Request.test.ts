import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel, type AnthropicFcaOptions } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { MINECRAFT_TRANSPORT } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import type { FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { llmcCoreKnowledge } from '../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { candidateInput, candidateMenuTools, minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { configuredMinecraftLlmc, llmcTools } from '../src/wiring/minecraftLlmcWiring.js';
import { v2MenuTool } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { candidateFixed } from '../src/wiring/minecraftLlmcV2Request.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { llmcRequests, LLMC_TOOLS } from './support/minecraftBodyRequests.js';
import lives from './fixtures/minecraft-v2-lives-v1.json' with { type: 'json' };

/**
 * SHANNON_MINECRAFT_LLMC_V2 (improvement plan 2.1–2.3), the model's request: six fixed tools in a fixed order, the mode's instructions, the stages'
 * knowledge and the rewritten live state in the one turn-scoped message, the hands written one to a line made ready for the body, the cache marks
 * where they were; and, off, the request of the act preflight alone byte for byte (the digests are those of 4f98156).
 */
const PROBE: FcaToolDefinition = { name: 'mc.probe', description: PROBE_DESCRIPTION, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  nativeInputSchema: PROBE_INPUT_SCHEMA, domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const CORE = [...LLMC_TOOLS, PROBE];
const live = (lives as Record<string, Record<string, any>>)['s01-r32-1321-head-cell']!;
type Body = Record<string, any> & { system: Array<{ text: string }>; messages: Array<Record<string, any>>; tools: Array<{ name: string }> };

async function decide(options: Partial<AnthropicFcaOptions>, tools: FcaToolDefinition[], answer: unknown, laterBody?: Record<string, unknown>) {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const fixture = scriptedAnthropic((_body, index) => message([{ type: 'thinking', thinking: '', signature: `s${index}` },
    { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: answer }], 'tool_use'));
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-opus-5-5', fetcher: fixture.fetcher, recordUsage() {},
    clock: () => ({ localTime: '2026-10-23 04:00', timeZone: 'Asia/Tokyo' }), minecraftOwnPrompt: true, ...options });
  const input = (history: readonly unknown[]): FcaModelInput => ({
    task: { id: 'task-1', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' }, messages: [], children: [], history, tools, coreTools: tools,
    transient: history.length && laterBody ? laterBody : live.body, plan: live.plan, waiting: live.waiting, observations: live.observations, recall: live.recall,
    catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) } as FcaModelInput);
  const first = await model.decide(input([]), new AbortController().signal);
  const history = [...first.history, model.toolResults([{ id: 'toolu_0', text: 'act 全部済み', ok: true }])];
  const second = await model.decide(input(history), new AbortController().signal);
  vi.restoreAllMocks();
  return { bodies: fixture.bodies as Body[], first, second };
}
const markPaths = (body: Body) => body.messages.flatMap((entry, index) => (Array.isArray(entry.content) ? entry.content : [])
  .flatMap((block: Record<string, unknown>, at: number) => block.cache_control ? [`messages[-${body.messages.length - index}].${entry.role}[${at}]`] : []));

describe('SHANNON_MINECRAFT_LLMC_V2 on: the request', () => {
  const options = { systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() };
  const tools = candidateMenuTools(CORE);

  it('declares six tools in a fixed order: no tool_open, no fca_context, the hands one to a line', async () => {
    const { bodies } = await decide(options, tools, { hands: ['jump 1'] });
    for (const body of bodies) {
      expect(body.tools.map(tool => tool.name)).toEqual(['mc_act', 'mc_probe', 'mc_view', 'plan_update', 'fca_wait', 'fca_complete']);
    }
    const act = bodies[0]!.tools[0] as Record<string, any>;
    expect(act.input_schema.properties.hands.items.type).toBe('string');
    expect(act.description).toContain('1 手 1 行');
    expect(JSON.stringify(bodies[0]!.tools)).not.toContain('tool_open');
  });

  it('reads the mode\'s instructions: transport kept, 5k tokens where the own prompt had 7.7k, the stages\' knowledge not in them', async () => {
    const { bodies } = await decide(options, tools, { hands: ['jump 1'] });
    const system = bodies[0]!.system;
    expect(system[0]!.text).toBe(MINECRAFT_TRANSPORT);
    expect(system[1]!.text).toContain(V2_ALWAYS);
    expect(system[1]!.text).not.toContain('## 材料と手順');
    expect(system[1]!.text).not.toContain('catalog');
    for (const kept of ['日次の予算', '停止スイッチ', '自分を複製する', '指示するのは課題だけ', '内緒にしていること']) expect(system[1]!.text).toContain(kept);
    // ADR-0014 D3: the mode's system text stays within about 8k tokens (mb-llmc-cand 10: Japanese throughout, the live fields' dictionary added).
    // `llmcTokens` counts about 23% above the provider (system+tools measured 10,274 against its 12,599): 8,300 of it is about 6.75k real tokens, inside the 8k of D3.
    expect(llmcTokens(system[1]!.text)).toBeLessThan(8_300);
  });

  it('states the stages\' knowledge once, as a part of the stored state (cached after), and the rewritten live state alone in the turn-scoped message', async () => {
    const { bodies } = await decide(options, tools, { hands: ['jump 1'] });
    const stated = (body: Body) => JSON.stringify(body.messages.slice(0, -1)).split('stageKnowledge').length - 1;
    expect([stated(bodies[0]!), stated(bodies[1]!)]).toEqual([1, 1]);
    expect(JSON.stringify(bodies[0]!.messages[0])).toContain('この場面の知識');
    for (const body of bodies) {
      const last = body.messages.at(-1)!;
      expect(last).toMatchObject({ role: 'system', clear_at: 'next_user_message' });
      const state = JSON.parse(last.content) as Record<string, any>;
      expect(state).not.toHaveProperty('knowledge');
      for (const gone of ['ownerClock', 'waiting', 'observations', 'recall']) expect(state).not.toHaveProperty(gone);
      expect(state.body.around.length).toBeGreaterThan(10);
      expect(state.body.route.length).toBeGreaterThan(1);
    }
    expect(bodies.map(markPaths)[1]).toEqual(['messages[-2].user[0]']);
    expect(bodies[1]!.system.map(block => Object.keys(block).includes('cache_control'))).toEqual([true, true]);
  });

  it('makes the hands ready for the body and keeps the model\'s own lines in the history', async () => {
    const { first, second, bodies } = await decide(options, tools, { why: '[p1.1] 離れる', hands: ['walk 310,66,73 sprint', 'dig 309,67,73 tool=hand'], stopIf: 'hpBelow=10' });
    expect(first.decision).toMatchObject({ kind: 'tools' });
    const call = (first.decision as unknown as { calls: Array<{ name: string; input: any }> }).calls[0]!;
    expect(call.name).toBe('mc.act');
    expect(call.input.hands).toEqual([{ do: 'walk', to: { x: 310, y: 66, z: 73 }, sprint: true }, { do: 'dig', at: [{ x: 309, y: 67, z: 73 }], tool: 'hand' }]);
    expect(call.input.stopIf).toEqual({ hpBelow: 10 });
    const replayed = JSON.stringify(bodies[1]!.messages);
    expect(replayed).toContain('walk 310,66,73 sprint');
    expect(replayed).not.toContain('"do":"walk"');
    expect(second.history.length).toBeGreaterThan(0);
    expect(candidateInput('mc.view', { mode: 'top' })).toEqual({ mode: 'top' });
  });

  it('says a line it cannot read, in the input the body\'s tool then refuses', async () => {
    const { first } = await decide(options, tools, { hands: ['fly 1,2,3'] });
    const call = (first.decision as unknown as { calls: Array<{ input: Record<string, unknown> }> }).calls[0]!;
    expect(call.input['書き方の誤り']).toContain('知らない手');
  });

  it('offers the mode\'s menu only: the four tools, none of the reads, goals, tasks or memory', () => {
    const named = (name: string, domain: FcaToolDefinition['domain']) => ({ name, domain });
    const kept = [named('mc.act', 'minecraft_body'), named('mc.probe', 'minecraft_body'), named('mc.view', 'minecraft_body'), named('plan.update', 'task_runtime'),
      named('mc.find-blocks', 'minecraft_body'), named('minecraft.observe', 'minecraft_body'), named('goal.progress', 'task_runtime'), named('memory.search', 'memory_read')]
      .filter(tool => v2MenuTool(tool)).map(tool => tool.name);
    expect(kept).toEqual(['mc.act', 'mc.probe', 'mc.view', 'plan.update']);
    expect(llmcTools({ definitions: [], execute: async () => { throw new Error('none'); } } as never).definitions).toEqual([]);
  });
});

describe('SHANNON_MINECRAFT_LLMC_V2: the stage knowledge changes only when the stages do', () => {
  it('is stated again as a part of the state when the stages change, and not when they stay', async () => {
    const options = { systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() };
    const tools = candidateMenuTools(CORE);
    const nether = { ...live.body, state: { ...live.body.state, dimension: 'the_end', inside: '' }, planNow: '[p5.1] ドラゴンを倒す', landmarks: [], scan: [] };
    const same = await decide(options, tools, { hands: ['jump 1'] });
    const changed = await decide(options, tools, { hands: ['jump 1'] }, nether);
    const stated = (body: Body) => JSON.stringify(body.messages.slice(0, -1)).split('stageKnowledge').length - 1;
    expect([stated(same.bodies[0]!), stated(same.bodies[1]!)]).toEqual([1, 1]);
    expect([stated(changed.bodies[0]!), stated(changed.bodies[1]!)]).toEqual([1, 2]);
    expect(JSON.stringify(changed.bodies[1]!.messages.slice(0, -1))).toContain('## エンド');
    expect(JSON.stringify(changed.bodies[0]!.messages.slice(0, -1))).not.toContain('## エンド');
  });
});

describe('SHANNON_MINECRAFT_LLMC_V2: the fixed part for the decision replay', () => {
  it('is the system blocks and the six tools the production model sends, made from the recorded core', async () => {
    const fixed = await candidateFixed(CORE);
    expect(fixed.system).toHaveLength(2);
    expect(fixed.system[0]!.text).toBe(MINECRAFT_TRANSPORT);
    expect(fixed.tools.map(tool => tool.name)).toEqual(['mc_act', 'mc_probe', 'mc_view', 'plan_update', 'fca_wait', 'fca_complete']);
    expect(fixed.headers['anthropic-beta']).toContain('mid-conversation-system-clear-at');
    const { bodies } = await decide({ systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() }, candidateMenuTools(CORE), { hands: ['jump 1'] });
    expect(JSON.stringify(fixed.system)).toBe(JSON.stringify(bodies[0]!.system));
    expect(JSON.stringify(fixed.tools)).toBe(JSON.stringify(bodies[0]!.tools));
  });
});
