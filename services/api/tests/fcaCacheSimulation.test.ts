import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec, estimatedAnthropicTokens } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import type { FcaBodyLifecycle, FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import type { TaskRecall, TaskRecallPacket } from '../src/mind/recall/taskRecallPorts.js';
import type { TaskMemoryItem } from '../src/mind/memory/taskMemoryPorts.js';
import { providerToolName, toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * A Minecraft-shaped task of 26 steps through the real runtime, decision model, summarizer, codec and history policy, at the sizes
 * of Minebot lane task 788da00a (production ab990c87, 2026-10-14: 77 inline definitions of ~43k characters, a catalog of ~19k,
 * eight recalled memories of 3.9–5.4k characters each, one new a step, body context and results of 0.2–7k). There every step
 * compacted (22 summaries in 23 steps) and each call read only its first 1,792 tokens. Here a provider cache is simulated from the
 * requests themselves (breakpoints, prefix identity without the markers, a lookback of 20 blocks, tokens by the codec's estimate)
 * to show the cadence of summaries and the expected price of a step.
 *
 * Measured with this file (2026-10-14): summaries before steps 7, 10, 12, 16, 20, 22 and 26; at most 85,738 estimated tokens; 71% of
 * a decision's input read from the cache; about $0.0064 a step. The same simulation on ab990c87 summarizes before every step from
 * the third, reads 2.8% and costs about $0.0215 a step (production measured $0.0184).
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const STEPS = 26;
const PRICES = { input: 0.1, write: 0.2, read: 0.01, output: 0.5 }; // Haiku 5.5 per million (`claudeUsage.ts`), below 100k.
const LONG = 5; // above 100k input tokens every rate is five times (`HAIKU_LONG_PRICES`).

const skill = (index: number): FcaToolDefinition => ({ name: `mc.skill-${index}`,
  description: `原木や石を集め、拠点の周りで作業する身体スキル${index}。近くのブロックを探して移動し、結果を観測で確かめる。`.repeat(2),
  input: { type: 'object', properties: Object.fromEntries(['target', 'count', 'radius', 'mode'].map(key => [key,
    { type: 'string', description: `${key} の指定。省略すると現在の観測から決める。値は短い識別子で与える。` }])), required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
const SKILLS = Array.from({ length: 77 }, (_, index) => skill(index + 1));
const memory = (index: number): TaskMemoryItem => ({ id: `memory-${index}`, summary: `拠点の北に樫の木が多い。前回は斧で原木を集めた記録${index}。`.repeat(12).slice(0, 500),
  observedAt: '2026-10-13T00:00:00.000Z', evidence: '過去の作業の観測', applicability: 'recorded observation', confidence: null, conflicts: [],
  detailRef: `memory-${index}`, provenance: { kind: 'experience', sourceIds: Array.from({ length: 90 }, (_, id) => `${index}-${id}-0000-4000-8000-000000000000`), readSourceIds: [] } });

/** One request as the provider caches it: blocks in tools → system → messages order, each with its prefix hash and tokens. */
function blocks(body: Record<string, unknown>) {
  const raw: Array<{ value: unknown; marked: boolean }> = [];
  for (const tool of body.tools as unknown[]) raw.push({ value: tool, marked: false });
  for (const block of body.system as Array<Record<string, unknown>>) raw.push({ value: block, marked: !!block.cache_control });
  for (const entry of body.messages as Array<{ role: string; content: unknown }>) {
    const content = typeof entry.content === 'string' ? [{ type: 'text', text: entry.content }] : entry.content as Array<Record<string, unknown>>;
    for (const block of content) raw.push({ value: { role: entry.role, block }, marked: !!block.cache_control });
  }
  let hash = createHash('sha256'), tokens = 0;
  return raw.map(({ value, marked }) => {
    const clean = JSON.stringify(value, (key, child: unknown) => key === 'cache_control' ? undefined : child);
    hash = hash.copy().update(clean); tokens += estimatedAnthropicTokens(JSON.parse(clean));
    return { prefix: hash.copy().digest('hex'), tokens, marked };
  });
}
/** Reads the longest cached prefix any breakpoint finds within 20 blocks, then writes every breakpoint. */
function cached(body: Record<string, unknown>, cache: Set<string>) {
  const list = blocks(body), points = list.flatMap((block, index) => block.marked ? [index] : []);
  if (body.cache_control) points.push(list.length - 1);
  let read = 0;
  for (const point of points) for (let index = point; index >= Math.max(0, point - 20); index--) {
    if (cache.has(list[index]!.prefix)) { read = Math.max(read, list[index]!.tokens); break; }
  }
  const last = Math.max(...points), written = Math.max(0, list[last]!.tokens - read);
  for (const point of points) cache.add(list[point]!.prefix);
  const total = list.at(-1)!.tokens;
  return { total, read, written, uncached: total - read - written };
}

function run() {
  let time = Date.parse('2026-10-14T01:49:30.000Z');
  const now = () => new Date(time).toISOString();
  const h = actionHarness(now);
  const violations: string[] = [];
  let decisions = 0;
  const template = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木集めの事実`]]));
  const fixture = scriptedAnthropic(body => {
    const violation = anthropicRequestViolation(body);
    if (violation) violations.push(violation);
    if ((body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary')) {
      return message([{ type: 'tool_use', id: `toolu_summary_${decisions}_${Math.random().toString(36).slice(2, 8)}`, name: 'fca_history_summary', input: { template: JSON.stringify(template) } }], 'tool_use');
    }
    decisions += 1;
    return decisions >= STEPS
      ? message([{ type: 'tool_use', id: `toolu_complete_${decisions}`, name: 'fca_complete', input: { summary: '原木を集めた' } }], 'tool_use')
      : message([{ type: 'thinking', thinking: '次の作業', signature: `signed-${decisions}-${'s'.repeat(400)}` },
        { type: 'tool_use', id: `toolu_skill_${decisions}`, name: providerToolName(`mc.skill-${(decisions % 5) + 1}`), input: { target: 'oak_log' } }], 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
  const tools: FcaExternalTools = { definitions: SKILLS, async execute() {
    return toolOk(JSON.stringify({ found: 'oak_log', distance: 12, detail: '原木'.repeat(decisions % 5 === 0 ? 3_500 : 100) }));
  } };
  const selector: FcaToolSelector = { async select(request) { return { names: request.tools.map(tool => tool.name), source: 'catalog' }; } };
  let packets = 0;
  const recall: TaskRecall = { start() {}, cancel() {}, async finishSegment() {}, async cancelAll() {},
    async packet(input): Promise<TaskRecallPacket> {
      const first = packets++;
      const items = Array.from({ length: 8 }, (_, index) => memory(first + index));
      return { contextVersion: input.contextVersion, observedAt: now(), status: 'ready', items, sourceIds: items.flatMap(item => item.provenance!.sourceIds) };
    } };
  const body: FcaBodyLifecycle = { start() {}, revision: () => decisions, guard: async () => true, toolSignal: (_name, signal) => signal, async close() {},
    context: () => ({ revision: decisions, observation: { position: { x: decisions, y: 64, z: -decisions }, nearby: '樫の原木、草、石'.repeat(150),
      inventory: Array.from({ length: 20 }, (_, index) => ({ item: `item-${index}`, count: (decisions + index) % 64 })) } as never }) };
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    canRunTask: (_runtime, id) => id === only,
    stepPorts: () => ({ tools, selector, recall, observeMemory: () => true, body, history: { codec: anthropicFcaHistoryCodec, summarizer } }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '原木を集める', goal: '原木を16個集める', completionCriteria: '原木16個を新しい観測で確かめる。' }, 'minecraft-request');
  only = task.id;
  async function settle() {
    for (let i = 0; i < 200 && !['completed', 'failed', 'unknown'].includes(driver.runtime.get('owner', task.id)?.phase ?? ''); i++) {
      await driver.tick(); await driver.drain(); time += 1_000;
    }
  }
  return { driver, task, fixture, violations, settle };
}

describe('a long Minecraft-shaped FCA task reads its cached conversation and summarizes every few steps (Minebot lane 2026-10-14)', () => {
  it('runs 26 steps with a summary about every 3–5 steps, every request below the 100k-token step, at a fraction of the earlier price', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = run();
    await r.settle();
    expect(r.violations).toEqual([]);
    expect(r.driver.runtime.get('owner', r.task.id)?.phase).toBe('completed');
    const cache = new Set<string>();
    const isSummary = (body: Record<string, unknown>) => (body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary');
    let step = 0, cost = 0, maximum = 0, readShare = 0;
    const summarySteps: number[] = [];
    for (const body of r.fixture.bodies) {
      const usage = cached(body, cache);
      maximum = Math.max(maximum, usage.total);
      const rate = usage.total > 100_000 ? LONG : 1;
      cost += rate * (usage.read * PRICES.read + usage.written * PRICES.write + usage.uncached * PRICES.input
        + (isSummary(body) ? 2_000 : 450) * PRICES.output) / 1e6;
      if (isSummary(body)) { if (summarySteps.at(-1) !== step + 1) summarySteps.push(step + 1); continue; }
      step += 1;
      if (step > 1) readShare += usage.read / usage.total;
    }
    expect(step).toBe(STEPS);
    // Every request stays below Haiku's price step, by the same conservative estimate.
    expect(maximum).toBeLessThan(100_000);
    // A summary about every three to five steps (production: every step from the second).
    const gaps = summarySteps.slice(1).map((value, index) => value - summarySteps[index]!);
    expect(summarySteps.length).toBeGreaterThanOrEqual(STEPS / 6);
    expect(summarySteps.length).toBeLessThanOrEqual(STEPS / 3);
    expect(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toBeGreaterThanOrEqual(3);
    // Most of a decision's input is read from the cache, and a step costs well under the measured $0.0184.
    expect(readShare / (STEPS - 1)).toBeGreaterThan(0.5);
    const perStep = cost / STEPS;
    expect(perStep).toBeLessThan(0.008);
  }, 120_000);
});
