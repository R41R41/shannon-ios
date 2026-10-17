import { createHash } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import type { FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaObsMode } from '../src/mind/action/fca/fcaCoreTools.js';
import type { FcaHistoryPolicy } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import { providerToolName, toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * A Minecraft-shaped task through the real runtime, decision model, summarizer, codec and history policy (the shape of
 * `fcaCacheSimulation.test.ts`), small enough to read: ten core body tools, `skill.read`, a memory read tool, two other tools
 * the model opens with `tool_open` (decisions 5 and 12) and then uses, and a scripted model. `bodies` are the decision requests only.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

export const definition = (name: string, domain: FcaToolDefinition['domain'], description = `${name} の説明。結果は観測で確かめる。`): FcaToolDefinition => ({
  name, description, domain, effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
  input: { type: 'object', properties: { target: { type: 'string', description: '対象の識別子。' } }, required: [], additionalProperties: false } });
export const BODY_TOOLS = [...Array.from({ length: 8 }, (_, index) => definition(`mc.skill-${index + 1}`, 'minecraft_body')),
  definition('minecraft.observe', 'minecraft_body')];
export const CORE_EXTRA = [definition('skill.read', 'skill_read'), definition('memory.search', 'memory_read')];
export const LAZY_TOOLS = [definition('lazy.alpha', 'host_folder'), definition('lazy.beta', 'host_folder')];
export const BASE_CATALOG: readonly FcaToolDefinition[] = [...BODY_TOOLS, ...CORE_EXTRA, ...LAZY_TOOLS];

export interface ScenarioOptions {
  /** The switch as read at each step (a function: tests flip it in the middle of a task). Absent: no port at all. */
  mode?: () => FcaObsMode | undefined;
  keepBody?: boolean; steps?: number; policy?: Partial<FcaHistoryPolicy>;
  /** The catalog at a decision (1-based), default the base catalog. */
  catalogAt?: (decision: number) => readonly FcaToolDefinition[];
  /** Decision 3 also calls `fca_context` (transient only: the legacy menu has none without a shared context). */
  contextCall?: boolean;
}
export const SUMMARY_POLICY: Partial<FcaHistoryPolicy> = { maximumRounds: 9, recentRounds: 3 };
export const WIDE_POLICY: Partial<FcaHistoryPolicy> = { maximumRounds: 80, recentRounds: 6, maximumNativeCharacters: 900_000,
  maximumReplayCharacters: 1_800_000, maximumReplayTokens: 900_000, maximumToolDefinitionCharacters: 900_000, maximumSummaryCharacters: 900_000 };

export function scenario(options: ScenarioOptions = {}) {
  let time = Date.parse('2026-10-14T01:49:30.000Z');
  const now = () => new Date(time).toISOString();
  const h = actionHarness(now);
  const violations: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let decisions = 0;
  const steps = options.steps ?? 30;
  const template = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 原木集めの事実`]]));
  const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });
  const fixture = scriptedAnthropic(body => {
    const violation = anthropicRequestViolation(body);
    if (violation) violations.push(violation);
    if ((body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary')) {
      return message([use(`toolu_summary_${decisions}`, 'fca_history_summary', { template: JSON.stringify(template) })], 'tool_use');
    }
    bodies.push(body);
    decisions += 1;
    const d = decisions, id = `toolu_${d}`;
    if (d >= steps) return message([use(`${id}_complete`, 'fca_complete', { summary: '原木を集めた' })], 'tool_use');
    const calls = d === 5 ? [use(id, 'tool_open', { name: 'lazy_alpha' })] : d === 6 ? [use(id, 'lazy_alpha')]
      : d === 12 ? [use(id, 'tool_open', { name: 'lazy_beta' })] : d === 13 ? [use(id, 'lazy_beta')]
      : [use(id, providerToolName(`mc.skill-${(d % 5) + 1}`), { target: 'oak_log' })];
    if (options.contextCall && d === 3) calls.unshift(use(`${id}_context`, 'fca_context', { expectations: [], appraisals: [] }));
    return message([{ type: 'thinking', thinking: '次の作業', signature: `signed-${d}-${'s'.repeat(300)}` }, ...calls], 'tool_use');
  });
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} });
  const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} });
  const tools: FcaExternalTools = { get definitions() { return options.catalogAt ? options.catalogAt(decisions + 1) : BASE_CATALOG; },
    async execute() { return toolOk(JSON.stringify({ found: 'oak_log', distance: 12 })); } };
  const selector: FcaToolSelector = { async select(request) {
    return { names: request.tools.map(tool => tool.name).filter(name => /^(mc|minecraft)\./u.test(name)), source: 'jev' };
  } };
  let only = '';
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    canRunTask: (_runtime, id) => id === only,
    stepPorts: () => { const mode = options.mode?.(); return { tools, selector, keepBodyTools: () => options.keepBody !== false,
      ...(mode ? { obsMode: mode } : {}), history: { codec: anthropicFcaHistoryCodec, summarizer, ...(options.policy ? { policy: options.policy } : {}) } }; } });
  cleanups.push(async () => { await driver.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '原木を集める', goal: '原木を16個集める', completionCriteria: '原木16個を新しい観測で確かめる。' }, 'minecraft-request');
  only = task.id;
  async function settle() {
    for (let i = 0; i < 400 && !['completed', 'failed', 'unknown'].includes(driver.runtime.get('owner', task.id)?.phase ?? ''); i++) {
      await driver.tick(); await driver.drain(); time += 1_000;
    }
    return driver.runtime.get('owner', task.id)?.phase;
  }
  return { driver, task, bodies, allBodies: fixture.bodies, violations, settle };
}

/** A request as the golden tests compare it: ids and clock readings of this run replaced, then hashed. */
export function requestDigest(body: Record<string, unknown>): string {
  const text = JSON.stringify(body).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, '<time>');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function quiet() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}
