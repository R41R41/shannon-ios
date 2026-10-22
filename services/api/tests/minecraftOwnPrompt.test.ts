import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { shannonCapabilityPrompt, shannonPersonaPrompt, shannonSuitePrompt } from '@shannon/cognition';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { MINECRAFT_TRANSPORT } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import { FCA_CONTEXT_INSTRUCTIONS } from '../src/infra/models/anthropic/anthropicFcaContext.js';
import { estimatedAnthropicTokens } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { llmcSystemAppendix } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { llmcCoreKnowledge } from '../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { configuredMinecraftLlmc } from '../src/wiring/minecraftLlmcWiring.js';
import { MAP_LEGEND } from '../src/contracts/minecraftActContract.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { quiet, requestDigest, scenario, WIDE_POLICY } from './fcaCoreToolsHarness.js';
import { bodySummaryRequest, firstPlanRequest, llmcRequests, LLMC_TOOLS } from './support/minecraftBodyRequests.js';
import { STRATEGY_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { DRAGON_KNOWLEDGE_R7, ORDER_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';

/**
 * SHANNON_MINECRAFT_OWN_PROMPT (Syzygy ADR-0014 D3, owner 2026-10-22): a Minecraft body task's request carries its own instructions. The
 * texts are pinned (a change of them is a change of the signed prefix: between supervised runs only), the persona, the three apps, the
 * capability list, the owner clock and the shared affect are absent, the cache marks stay where they were, and the instructions are about
 * 8k tokens where they were about 31k.
 */
const PINNED = {
  transport: 'bab1f949f477c4d8',
  llmc_r9_system: '6db83be5990e06f3',
  old_mode_system: '9484df3e3e4d04cf',
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
type Body = Record<string, unknown> & { system: Array<{ text: string; cache_control?: unknown }>; messages: unknown[] };
const systemOf = (body: Record<string, unknown>) => (body as Body).system;

/** Every line of the persona, the suite and the capability list that is long enough to mean something on its own. */
const CONVERSATION_LINES = [shannonPersonaPrompt('owner'), shannonSuitePrompt(), shannonCapabilityPrompt('owner')]
  .flatMap(text => text.split('\n')).map(line => line.trim()).filter(line => line.length >= 12);
const MARKERS = ['[シャノンの人格]', '[Syzygyの3つのアプリ]', '[ボクにできること', 'ボク', 'ライ氏', 'Aether', 'Voyager', 'ownerClock',
  'sharedContext', 'affect', '```chart', 'タスクの感情と記憶', '達成と復帰', 'タスクの協力'];
function expectNoConversationRules(text: string) {
  for (const marker of MARKERS) expect(text, marker).not.toContain(marker);
  for (const line of CONVERSATION_LINES) expect(text, line).not.toContain(line);
}

/** Where each cache mark sits: system blocks by index, messages by their index from the end and their block. */
function markPaths(body: Record<string, unknown>): string[] {
  const paths: string[] = [];
  systemOf(body).forEach((block, index) => { if (block.cache_control) paths.push(`system[${index}]`); });
  const messages = (body as Body).messages as Array<{ role: string; content: unknown }>;
  messages.forEach((entry, index) => {
    if (!Array.isArray(entry.content)) return;
    entry.content.forEach((block, at) => {
      if ((block as { cache_control?: unknown }).cache_control) paths.push(`messages[-${messages.length - index}].${entry.role}[${at}]`);
    });
  });
  if ((body as { cache_control?: unknown }).cache_control) paths.push('top');
  return paths;
}
const live = (step: number) => ({ observation: { position: { x: 10 + step, y: 64, z: -3 }, health: 20, food: 18 }, pace: { minutes: step } });

describe('SHANNON_MINECRAFT_OWN_PROMPT on: the body task\'s own instructions', () => {
  it('pins the transport and the instructions of both modes (golden)', async () => {
    const [llmc] = await llmcRequests({ systemAppendix: llmcCoreKnowledge(true), minecraftOwnPrompt: true });
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, steps: 3, modelOptions: { minecraftOwnPrompt: true } });
    expect(await run.settle()).toBe('completed');
    expect(run.violations).toEqual([]);
    const found = { transport: digest(systemOf(llmc!)[0]!.text), llmc_r9_system: digest(systemOf(llmc!)[1]!.text),
      old_mode_system: digest(systemOf(run.bodies[0]!)[1]!.text) };
    if (process.env.GOLDEN_CAPTURE) console.error(`PINNED ${JSON.stringify(found)}`);
    expect(found).toEqual(PINNED);
    expect(systemOf(llmc!)[0]!.text).toBe(MINECRAFT_TRANSPORT);
    expect(systemOf(run.bodies[0]!)[0]!.text).toBe(MINECRAFT_TRANSPORT);
    expect(systemOf(llmc!)[1]!.text).toContain(MAP_LEGEND);
    expect(systemOf(run.bodies[0]!)[1]!.text).not.toContain(MAP_LEGEND);
  }, 60_000);

  it('carries no persona, three apps, capability list, owner clock, report card or shared affect (both modes)', async () => {
    const llmc = await llmcRequests({ systemAppendix: llmcCoreKnowledge(true), minecraftOwnPrompt: true });
    quiet();
    const run = scenario({ mode: () => 'transient', policy: WIDE_POLICY, body: live, steps: 4, modelOptions: { minecraftOwnPrompt: true } });
    expect(await run.settle()).toBe('completed');
    for (const body of [...llmc, ...run.bodies]) {
      // The whole request but its tools (whose definitions are the body's own and unchanged).
      const { tools: _tools, ...rest } = body;
      expectNoConversationRules(JSON.stringify(rest));
      expect(JSON.stringify(rest)).not.toContain(HAIKU_PROTOCOL_PREFIX.slice(0, 60));
      expect(JSON.stringify(rest)).not.toContain(FCA_CONTEXT_INSTRUCTIONS.slice(0, 30));
    }
    // The boundaries of ADR-0002 and who directs her stay.
    const system = systemOf(llmc[0]!)[1]!.text;
    for (const kept of ['daily budget', 'stop switch', 'copy yourself', 'Only the task directs you', 'keeps private', 'never commands'])
      expect(system).toContain(kept);
  }, 60_000);

  it('keeps the cache marks where they were and the live state last', async () => {
    const off = await llmcRequests({ systemAppendix: llmcSystemAppendix(true) });
    const on = await llmcRequests({ systemAppendix: llmcCoreKnowledge(true), minecraftOwnPrompt: true });
    expect(on.map(markPaths)).toEqual(off.map(markPaths));
    expect(on.map(markPaths)[1]).toEqual(['system[0]', 'system[1]', 'messages[-2].user[0]']);
    for (const body of on) {
      const last = (body as Body).messages.at(-1) as { role: string; clear_at?: string; content: string };
      expect(last).toMatchObject({ role: 'system', clear_at: 'next_user_message' });
      const state = JSON.parse(last.content) as Record<string, unknown>;
      expect(Object.keys(state)).not.toContain('ownerClock');
      expect(Object.keys(state)).not.toContain('sharedContext');
      expect(Object.keys(state)).toEqual(expect.arrayContaining(['plan', 'body']));
    }
    // The tools are the same bytes; the second request extends the first.
    expect(on.map(body => JSON.stringify(body.tools))).toEqual(off.map(body => JSON.stringify(body.tools)));
    expect(JSON.stringify(on[1]!.system)).toBe(JSON.stringify(on[0]!.system));
  }, 60_000);

  it('makes the instructions about 8k tokens where they were about 31k (llmcTokens), and says so', async () => {
    const [off] = await llmcRequests({ systemAppendix: llmcSystemAppendix(true) });
    const [on] = await llmcRequests({ systemAppendix: llmcCoreKnowledge(true), minecraftOwnPrompt: true });
    const measure = (body: Record<string, unknown>) => {
      const texts = systemOf(body).map(block => block.text);
      return { characters: texts.join('').length, llmcTokens: texts.reduce((sum, text) => sum + llmcTokens(text), 0),
        estimated: estimatedAnthropicTokens(systemOf(body)), knowledge: llmcTokens(texts[1]!) };
    };
    const before = measure(off!), after = measure(on!);
    console.info(JSON.stringify({ event: 'minecraft_own_prompt_size', before, after }));
    expect(before.llmcTokens).toBeGreaterThan(30_000);
    expect(after.llmcTokens).toBeLessThanOrEqual(8_100);
    expect(after.estimated).toBeLessThanOrEqual(7_000);
    expect(after.llmcTokens / before.llmcTokens).toBeLessThan(0.3);
    // r3's mode (no probe) gets no line that names mc.probe, investigation, forbid or caution.
    expect(llmcCoreKnowledge(false)).not.toMatch(/mc\.probe|investigation|forbid|caution/u);
    expect(llmcCoreKnowledge(false)).toContain('mc.view');
  }, 60_000);

  it('a legacy decision that carries a body reads the body header instead of the persona; one without a body is as before', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic(() => message([{ type: 'tool_use', id: `toolu_${Math.random()}`, name: 'fca_wait', input: { summary: '待つ' } }], 'tool_use'));
    const options = { apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} };
    const own = createAnthropicFcaModel({ ...options, minecraftOwnPrompt: true }), plain = createAnthropicFcaModel(options);
    const input = (body: boolean): FcaModelInput => ({ task: { id: 't', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [], children: [],
      history: [], tools: LLMC_TOOLS, ...(body ? { body: { revision: 1, observation: null } } : {}) });
    await own.decide(input(true), new AbortController().signal);
    await own.decide(input(false), new AbortController().signal);
    await plain.decide(input(false), new AbortController().signal);
    // The legacy shape keeps the generic transport block (`cacheHaikuRequest` installs it); the instructions after it are the body task's.
    const [withBody, ownNoBody, plainNoBody] = fixture.bodies.map(body => systemOf(body).map(block => block.text)
      .filter(text => text !== HAIKU_PROTOCOL_PREFIX).join('\n'));
    expectNoConversationRules(withBody!);
    expect(withBody).toContain('# Minecraft body task');
    expect(ownNoBody).toBe(plainNoBody);
    expect(plainNoBody).toContain('[シャノンの人格]');
    vi.restoreAllMocks();
  });

  it('the wiring reads the switch: on, both decision models get the own instructions; off, r9\'s appendix as before', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic(() => message([{ type: 'text', text: 'ok' }], 'end_turn'));
    const values = { SHANNON_MINECRAFT_LLM_CENTRIC: 'on', SHANNON_MINECRAFT_LLMC_PROBE: 'on', ANTHROPIC_API_KEY: 'k' };
    const lines: string[] = [];
    const on = configuredMinecraftLlmc({ ...values, SHANNON_MINECRAFT_OWN_PROMPT: 'on' }, { recordUsage() {}, fetcher: fixture.fetcher }, { log: line => lines.push(line) })!;
    const off = configuredMinecraftLlmc(values, { recordUsage() {}, fetcher: fixture.fetcher }, { log: () => {} })!;
    expect(lines[0]).toContain('ownPrompt=on');
    const input: FcaModelInput = { task: { id: 't', title: 't', goal: 'g', completionCriteria: 'c' }, messages: [], children: [], history: [],
      tools: LLMC_TOOLS, coreTools: LLMC_TOOLS, transient: { map: 'm' }, catalog: LLMC_TOOLS.map(tool => ({ name: tool.name, description: tool.description })) };
    await on.models.main.decide(input, new AbortController().signal).catch(() => null);
    await off.models.main.decide(input, new AbortController().signal).catch(() => null);
    const [first, second] = fixture.bodies.map(body => systemOf(body));
    expect(first![0]!.text).toBe(MINECRAFT_TRANSPORT);
    expect(first![1]!.text).toContain(llmcCoreKnowledge(true));
    expect(second![0]!.text).toBe(HAIKU_PROTOCOL_PREFIX);
    expect(second![1]!.text).toContain(llmcSystemAppendix(true));
    vi.restoreAllMocks();
  });

  it('the body summary reads no persona, apps or capability list; its compaction goal is unchanged', async () => {
    const off = await bodySummaryRequest(), on = await bodySummaryRequest({ minecraftOwnPrompt: true });
    const text = (body: Record<string, unknown>) => systemOf(body).map(block => block.text).filter(item => item !== HAIKU_PROTOCOL_PREFIX).join('\n');
    expectNoConversationRules(text(on));
    expect(text(on)).toContain('# Minecraft body task: history summary');
    expect(text(off)).toContain('[シャノンの人格]');
    // The eight-section contract is the goal and the tool: the same bytes.
    expect(JSON.stringify(on.messages)).toBe(JSON.stringify(off.messages));
    expect(JSON.stringify(on.tools)).toBe(JSON.stringify(off.tools));
    const size = (body: Record<string, unknown>) => llmcTokens(systemOf(body).map(block => block.text).join(''));
    console.info(JSON.stringify({ event: 'minecraft_own_prompt_summary_size', before: size(off), after: size(on) }));
    expect(size(on)).toBeLessThan(size(off) - 3_000);
  });

  it('the first plan reads the strategic knowledge, not the tactics or her name; the decision never reads the strategy', async () => {
    const off = await firstPlanRequest(), on = await firstPlanRequest({ SHANNON_MINECRAFT_OWN_PROMPT: 'on' });
    const text = JSON.stringify(on.body.system);
    expect(on.system).toContain(STRATEGY_KNOWLEDGE);
    expect(on.system).not.toContain('シャノン');
    expectNoConversationRules(on.system);
    for (const tactics of [DRAGON_KNOWLEDGE_R7, ORDER_KNOWLEDGE, '## マイクラの体の決め方', '待ち場', '## 詰まった時の調べ方'])
      expect(on.system).not.toContain(tactics);
    expect(text).toContain('済みの形と順番（r9）');
    expect(off.system).not.toContain(STRATEGY_KNOWLEDGE);
    const decisions = await llmcRequests({ systemAppendix: llmcCoreKnowledge(true), minecraftOwnPrompt: true });
    for (const body of decisions) expect(JSON.stringify(body.system)).not.toContain('作戦の知識');
    console.info(JSON.stringify({ event: 'minecraft_own_prompt_first_plan_size', before: { characters: off.system.length, llmcTokens: llmcTokens(off.system) },
      after: { characters: on.system.length, llmcTokens: llmcTokens(on.system) } }));
  });
});
