import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec, estimatedAnthropicTokens } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import { renderedRequest } from '../src/infra/models/anthropic/anthropicFcaTransient.js';
import type { FcaEvidence, FcaOutcomeContext } from '../src/mind/action/fca/fcaEvidencePorts.js';
import type { FcaObsMode } from '../src/mind/action/fca/fcaCoreTools.js';
import type { FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaObservationLifecycle } from '../src/mind/action/fca/fcaObservation.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import type { TaskRecall, TaskRecallPacket } from '../src/mind/recall/taskRecallPorts.js';
import { providerToolName, toolOk } from '../src/mind/tools/shannonTools.js';
import { storedBodyResult } from '../src/surfaces/minecraft/minecraftStoredResult.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * The estimate of the cost round (2026-10-19): one Minecraft body task of production run 15's shape (task ba9a2a32, 08:02–08:32Z) through
 * the real runtime, decision model, summarizer, codec and history policy, its provider cache simulated from the requests themselves (as
 * `fcaCacheSimulation.test.ts`: breakpoints, prefix identity without the markers, a lookback of 20 blocks, tokens by the codec's estimate,
 * a turn-scoped system message billed only while it is the newest), priced at Sonnet 5.5's rates.
 *
 * Run 15's sizes, as stored (characters): 79 body skills, their definitions about 50k as an inline message; the catalog 21k; the skill index
 * 1.5k; the shared context's instructions 1.5k; a recall of eight memories, 2.3–7.3k a step (half of them new); a shared context of the
 * affect (0.3k) and up to eight outcomes of her own calls (0.4k each); the body 3.4–4.1k (observation 2.4–3.2k, pace, pointers, gists 0.6k);
 * progress 0.6k, waiting 0.4k, the clock 0.2k, the task inbox 0.2k; a thinking block of about 1.1k and a call of 0.16k an answer; results
 * of 30–160. Measured there (journal `fca_decision_metrics`, 66 decisions; usage ledger, 90 Sonnet calls): 72.5k input tokens a decision
 * (47.4k read, 25.0k written), 22 epochs, $0.111 a decision and $2.12 for 24 summaries: $0.143 a decision in all.
 *
 * Three shapes, the same calls (1.17 a decision): `before` (the shape run 15 had: legacy, a recall, the whole shared context),
 * `legacyNow` (this round in the legacy shape: no recall, the body's shared context), and `transientNow` (the new default). The estimate
 * writes its table to the file named by FCA_ESTIMATE_OUT when that is set.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const DECISIONS = 48;
/** Sonnet 5.5 per million: uncached input, one-hour write, read, output (`claudeUsage.ts`). */
const PRICE = { input: 2, write: 4, read: 0.2, output: 10 };
const OUTPUT = { decision: 150, summary: 700 };

const kana = (seed: number, length: number) => {
  const words = ['原木', '丸石', '鉄鉱石', '作業台', 'かまど', '松明', '洞窟', '地下', '採掘', '移動', '観測', '確認', '近く', '周り', '拾う', '作る'];
  let text = '';
  for (let index = 0; text.length < length; index++) text += words[(seed + index * 7) % words.length];
  return text.slice(0, length);
};
/** Run 15's texts are JSON with English keys and numbers around Japanese names: about a third of the characters Japanese. */
const mixed = (seed: number, length: number) => {
  const words = ['oak_log', 'cobblestone', 'iron_ore', 'crafting_table', 'furnace', 'x=20', 'y=58', 'z=-56', 'count', 'distance', 'near', 'block'];
  let text = '';
  for (let index = 0; text.length < length; index++) text += index % 3 === 0 ? kana(seed + index, 4) : `${words[(seed + index * 5) % words.length]} `;
  return text.slice(0, length);
};
/** A body skill of about 600 characters as a definition (79 of them: about 50k, as run 15's inline message). */
const skill = (index: number): FcaToolDefinition => ({ name: `mc.skill-${index}`,
  description: `${kana(index, 60)}。${mixed(index, 105)}`,
  input: { type: 'object', properties: Object.fromEntries(['target', 'count'].map(key => [key,
    { type: 'string' as const, description: `${key}: ${mixed(index + key.length, 22)}` }])), required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: index % 9 === 0 ? 'read' : 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
const SKILLS = [...Array.from({ length: 78 }, (_, index) => skill(index + 1)),
  { ...skill(0), name: 'minecraft.observe', effect: 'read' as const }];

function blocks(body: Record<string, unknown>) {
  const raw: Array<{ value: unknown; marked: boolean }> = [];
  for (const tool of body.tools as unknown[]) raw.push({ value: tool, marked: !!(tool as { cache_control?: unknown }).cache_control });
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
/** Reads the longest cached prefix a breakpoint finds within 20 blocks, then writes up to the last breakpoint. */
function cached(sent: Record<string, unknown>, cache: Set<string>) {
  const body = renderedRequest(sent as { messages: unknown[] }) as Record<string, unknown>;
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

type Shape = 'before' | 'legacyNow' | 'transientNow';
function run(shape: Shape) {
  let time = Date.parse('2026-10-19T08:02:36.000Z');
  const now = () => new Date(time).toISOString();
  const h = actionHarness(now);
  const violations: string[] = [];
  let decisions = 0;
  const template = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: ${kana(3, 60)}`]]));
  const callsOf = (d: number) => d % 6 === 0 ? 2 : 1;
  const fixture = scriptedAnthropic(body => {
    const violation = anthropicRequestViolation(body);
    if (violation) violations.push(violation);
    if ((body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary')) {
      return message([{ type: 'tool_use', id: `toolu_summary_${decisions}_${Math.random().toString(36).slice(2, 8)}`, name: 'fca_history_summary', input: { template: JSON.stringify(template) } }], 'tool_use');
    }
    decisions += 1;
    const d = decisions;
    if (d >= DECISIONS) return message([{ type: 'tool_use', id: `toolu_done_${d}`, name: 'fca_complete', input: { summary: '鉄のツルハシを作った' } }], 'tool_use');
    return message([{ type: 'thinking', thinking: '', signature: `sig-${d}-${'s'.repeat(1_050)}` },
      ...Array.from({ length: callsOf(d) }, (_, index) => ({ type: 'tool_use', id: `toolu_${d}_${index}`, name: providerToolName(`mc.skill-${((d + index) % 70) + 1}`),
        input: { target: 'iron_ore', count: 3 } }))], 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {},
    clock: () => ({ localTime: '2026-10-19 17:02', timeZone: 'Asia/Tokyo' }) });
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} });
  const outcomes: FcaOutcomeContext[] = [];
  const progress = { conditions: [], verification: null, replans: [], failures: Array.from({ length: 3 }, (_, index) => ({ operationId: `step-${index}:toolu_${index}_${'x'.repeat(40)}`,
    name: 'mc.skill-1', failure: 'failed', retryable: true })), binding: { kind: 'minecraft', note: kana(9, 260) } } as never;
  const tools: FcaExternalTools = { definitions: SKILLS, skillIndex: () => mixed(11, 1_450),
    progress: { context: () => progress, observed() {}, async verifyCompletion() { return { status: 'verified' } as never; } },
    async execute(call) { return toolOk(`${mixed(decisions + call.name.length, 30 + (decisions * 37) % 130)}（現在の所持数: 3個）`); } };
  const selector: FcaToolSelector = { async select(request) { return { names: request.tools.map(tool => tool.name).filter(name => /^(mc|minecraft)\./u.test(name)), source: 'jev' }; } };
  let packets = 0;
  const recall: TaskRecall = { start() {}, cancel() {}, async finishSegment() {}, async cancelAll() {},
    async packet(input): Promise<TaskRecallPacket> {
      const first = packets++;
      // Eight memories a step of about 650 characters, half of them new (run 15: 2.3–7.3k a step after the elision of the known ones).
      const items = Array.from({ length: 8 }, (_, index) => ({ id: `memory-${index < 4 ? index : first * 4 + index}`, summary: kana(first + index, 560),
        observedAt: '2026-10-18T00:00:00.000Z', evidence: '過去の作業の観測', applicability: 'recorded observation', confidence: null, conflicts: [],
        detailRef: `memory-${index}`, provenance: { kind: 'experience', sourceIds: ['s-1', 's-2'], readSourceIds: [] } }));
      return { contextVersion: input.contextVersion, observedAt: now(), status: 'ready', items, sourceIds: ['s-1', 's-2'] } as never;
    } };
  const evidence: FcaEvidence = {
    async prepare() { return { affect: { version: 1, revision: 4, updatedAt: now(), emotion: { valence: 0.12, arousal: 0.34, dominance: 0.5 }, feeling: kana(1, 40), causes: [] } as never,
      recentOutcomes: outcomes.slice(-8).reverse() }; },
    beforeActions: () => true,
    observed(step, call, result) {
      outcomes.push({ eventId: `fca:${step.id}:${call.id}:${'e'.repeat(20)}`, taskId: step.taskId, operationId: `${step.id}:${call.id}`, name: call.name,
        observation: 'observed', result: { ok: result.ok, text: result.text.slice(0, 120) }, expectation: null, comparison: null, appraisalRevision: 0 });
    },
    unknown() {}, committed() {}, flush() {},
  };
  const legacyBody = () => ({ revision: decisions, observation: { state: { world: { position: { x: decisions, y: 58, z: -56 }, health: 20, food: 18,
    inventory: Array.from({ length: 14 }, (_, index) => `item_${index}×${(decisions + index) % 64}`), nearbyEntities: mixed(decisions, 900), rememberedPlaces: mixed(decisions + 2, 400) } },
    facts: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`fact${index}`, mixed(index, 40)])) },
    pace: { elapsedMinutes: decisions, recentResults: 6, failedStepsInARow: 0 }, skillPointers: ['mc-iron-and-bucket'], skillGists: [kana(5, 560)], skillPointerNote: kana(6, 100) });
  const live = () => ({ observation: { position: { x: decisions, y: 58, z: -56 }, health: 20, food: 18, inventory: Array.from({ length: 14 }, (_, index) => `item_${index}×${(decisions + index) % 64}`),
    nearbyEntities: mixed(decisions, 900), entityKinds: mixed(decisions + 1, 200), rememberedPlaces: mixed(decisions + 2, 400),
    facts: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`fact${index}`, mixed(index, 40)])) },
    pace: { elapsedMinutes: decisions, sinceAchievementMinutes: 2, last15min: { mining: 3.2, crafting: 1.1 } }, phaseFacts: { tier: 2, hasBed: false, cookedFood: 0, noFood: true },
    skillPointers: ['mc-iron-and-bucket'], skillGists: [kana(5, 560)] });
  const observation = (data: () => Record<string, unknown>): FcaObservationLifecycle => ({ start() {}, revision: () => 0, guard: async () => true,
    toolSignal: (_name, parent) => parent, close: async () => {}, context: () => ({ revision: 0, observation: { generation: 'g', data: data(), sourceIds: [] } }) });
  const inbox = observation(() => ({ messages: 0, note: kana(2, 150) }));
  // Run 15's shape had the body's state in its decisions: here as a second observation when the shape keeps no body port (`before`).
  const bodyAsObservation = observation(() => legacyBody() as never);
  const body = shape === 'before' ? undefined : { start() {}, revision: () => 0, context: () => (shape === 'transientNow' ? { revision: 0, observation: null } : legacyBody()) as never,
    guard: async () => true, toolSignal: (_name: string, parent: AbortSignal) => parent, close: async () => {},
    ...(shape === 'transientNow' ? { transient: live, storedResult: (call: { name: string }, text: string) => storedBodyResult(call.name, text) } : {}) };
  const mode: FcaObsMode = shape === 'transientNow' ? 'transient' : 'legacy';
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    canRunTask: (_runtime, id) => id === only,
    stepPorts: () => ({ tools, selector, obsMode: mode, keepBodyTools: () => shape !== 'before', evidence, waitCounterpart: () => false,
      observations: shape === 'before' ? [inbox, bodyAsObservation] : [inbox],
      ...(shape === 'before' ? { recall, observeMemory: () => true } : {}), ...(body ? { body } : {}),
      history: { codec: anthropicFcaHistoryCodec, summarizer } }) });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '（運用者経由）エンドラを討伐してください', goal: 'エンドラを討伐する',
    completionCriteria: 'ドラゴンの討伐を新しい観測で確かめる。' }, 'minecraft-request');
  only = task.id;
  async function settle() {
    for (let i = 0; i < 400 && !['completed', 'failed', 'unknown'].includes(driver.runtime.get('owner', task.id)?.phase ?? ''); i++) {
      await driver.tick(); await driver.drain(); time += 25_000;
    }
  }
  return { driver, task, fixture, violations, settle };
}

/** The characters of a first decision request's parts (to set the fixture by run 15's sizes). */
function requestSizes(body: Record<string, unknown>) {
  const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const parts = messages.map(entry => {
    if (typeof entry.content === 'string' && entry.content.startsWith('{')) {
      try { return Object.fromEntries(Object.entries(JSON.parse(entry.content) as Record<string, unknown>).map(([key, value]) => [key, size(value)])); } catch { /* not JSON */ }
    }
    return { [entry.role]: size(entry.content) };
  });
  return { tools: size(body.tools), system: size(body.system), messages: parts };
}

function priced(r: ReturnType<typeof run>) {
  const cache = new Set<string>();
  const isSummary = (body: Record<string, unknown>) => (body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary');
  const totals = { decisions: 0, summaries: 0, input: 0, read: 0, written: 0, uncached: 0, decisionUsd: 0, summaryUsd: 0, epochs: 0, maximum: 0 };
  for (const body of r.fixture.bodies) {
    const usage = cached(body, cache);
    const usd = (usage.uncached * PRICE.input + usage.written * PRICE.write + usage.read * PRICE.read) / 1e6;
    if (isSummary(body)) { totals.summaries += 1; totals.summaryUsd += usd + OUTPUT.summary * PRICE.output / 1e6; continue; }
    totals.decisions += 1; totals.maximum = Math.max(totals.maximum, usage.total);
    totals.input += usage.total; totals.read += usage.read; totals.written += usage.written; totals.uncached += usage.uncached;
    totals.decisionUsd += usd + OUTPUT.decision * PRICE.output / 1e6;
    if (usage.read < 0.3 * usage.total) totals.epochs += 1;
  }
  const per = (value: number) => Math.round(value / totals.decisions);
  return { decisions: totals.decisions, summaries: totals.summaries, epochs: totals.epochs, maximumInput: totals.maximum,
    input: per(totals.input), read: per(totals.read), written: per(totals.written), uncached: per(totals.uncached),
    decisionUsd: totals.decisionUsd / totals.decisions, summaryUsd: totals.summaryUsd / totals.decisions,
    usd: (totals.decisionUsd + totals.summaryUsd) / totals.decisions };
}

describe('the cost of a body decision of run 15\'s shape, before and after the cost round (estimate)', () => {
  it('reproduces run 15 in its own shape, and the new default costs a fraction of it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const table: Record<string, ReturnType<typeof priced>> = {};
    const sizes: Record<string, unknown> = {};
    for (const shape of ['before', 'legacyNow', 'transientNow'] as const) {
      const r = run(shape);
      await r.settle();
      expect(r.violations).toEqual([]);
      expect(r.driver.runtime.get('owner', r.task.id)?.phase).toBe('completed');
      table[shape] = priced(r);
      sizes[shape] = requestSizes(r.fixture.bodies.find(body => !(body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary'))!);
    }
    if (process.env.FCA_ESTIMATE_OUT) writeFileSync(`${process.env.FCA_ESTIMATE_OUT}.sizes.json`, JSON.stringify(sizes, null, 2));
    if (process.env.FCA_ESTIMATE_OUT) writeFileSync(process.env.FCA_ESTIMATE_OUT, JSON.stringify(table, null, 2));
    const { before, legacyNow, transientNow } = table as Record<Shape, ReturnType<typeof priced>>;
    // The simulation of run 15's own shape lands near what run 15 measured (72.5k input a decision, $0.143 with its summaries): within a quarter.
    expect(before!.input).toBeGreaterThan(72_500 * 0.75); expect(before!.input).toBeLessThan(72_500 * 1.25);
    expect(before!.usd).toBeGreaterThan(0.143 * 0.75); expect(before!.usd).toBeLessThan(0.143 * 1.25);
    // The legacy shape alone is cheaper (no recall, the body's shared context), the new default far cheaper: under $0.04 with its summaries.
    expect(legacyNow!.usd).toBeLessThan(before!.usd);
    expect(transientNow!.usd).toBeLessThan(0.04);
    expect(transientNow!.written).toBeLessThan(before!.written / 4);
    expect(transientNow!.summaries).toBeLessThan(before!.summaries / 2);
    expect(transientNow!.maximumInput).toBeLessThan(100_000);
  }, 300_000);
});
