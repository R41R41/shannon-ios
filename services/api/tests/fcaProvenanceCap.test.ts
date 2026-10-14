import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import type { FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { FcaToolSelector } from '../src/mind/selectors/fcaToolSelection.js';
import type { TaskRecall } from '../src/mind/recall/taskRecallPorts.js';
import type { TaskSource, TaskStep, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { providerToolName, toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { FCA_PROVENANCE_LIMITS, fcaProvenanceForCheck } from '../src/mind/action/fca/fcaConversationSources.js';
import { SkillMemory } from '../src/mind/memory/memoryPorts.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { memoryWorld } from './support/memoryWorld.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRejection, anthropicRequestViolation } from './support/anthropicProviderRules.js';

/**
 * Minebot lane, 2026-10-14 10:59 JST (production ab990c87, Haiku): task 788da00a made logs, planks, a crafting table, sticks and a
 * wooden pickaxe over 23 steps and ~60 tool calls, then stopped as `fca_provenance_capped` (sources=65 ids=64) and its step closed
 * unknown (`FCA_SOURCE_WITHHELD`). Every step had observed its recall packet and the skill index, each a row of its own, so the
 * row count grew with the steps while the distinct ids did not. The guard now walks every memory id once at the earliest time it
 * was observed (`fcaProvenanceForCheck`): the same verdict, and a bounded walk however long the task runs.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };

/** A remembered world with recalls between turns, one forgotten turn and a few skills, under the real read-source and guard checks. */
function world(experiences = 120) {
  const w = memoryWorld(); cleanups.push(() => w.close());
  const ids: string[] = [];
  for (let index = 0; index < experiences; index++) {
    w.advance(60_000);
    const recalled = ids.length ? Array.from({ length: Math.min(6, ids.length) }, (_, k) => ids[(index * 7 + k * 13) % ids.length]!) : [];
    ids.push(w.store.appendTurn('owner', `thread-${index % 3}`, `質問${index}${String.fromCharCode(0x4e00 + index)}`, `返答${index}${String.fromCharCode(0x5000 + index)}`,
      w.now(), { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: recalled }).id);
  }
  const memories = new ShannonMemoryService(w.store, w.store, w.now);
  const forgotten = ids.at(-1)!;
  memories.mutate('owner', { memoryId: forgotten, action: 'forget' });
  const skillDb = new DatabaseSync(':memory:'); cleanups.push(() => skillDb.close());
  const skillMemory = new SkillMemory({ database: skillDb, createsSchema: true, defer: work => work() });
  for (let index = 0; index < 6; index++) {
    const added = skillMemory.create('owner', { draft: { name: `mc-skill-${index}`, description: `手順${index}`, steps: `手順${index}の本文`,
      aids: '- 確認', references: '- 元資料' }, evidence: [] }, { carries: () => false }, w.now());
    if ('rejected' in added) throw new Error(added.rejected);
  }
  const skills = skillTurnPorts(skillMemory, scope => w.store.snapshot(scope), w.store);
  const skillSources = skills.indexSources!('owner')!;
  const readSourceVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: w.store, conversations: w.store,
    skill: (scope, id, revision) => skills.readSource!(scope, id, revision) });
  w.store.readSourceVisible = readSourceVisible;
  // Recalled ids that are visible today: the forgotten turn and every turn that recalled it are left out.
  const pool = ids.slice(10, 10 + 80).filter(id => id !== forgotten);
  return { w, ids, pool, forgotten, memories, skillSources, readSourceVisible };
}

const memoryRow = (stepId: string, observedAt: string, recalled: readonly string[], read: readonly string[] = []): TaskSource => ({
  kind: 'memory', stepId, experienceId: null, threadId: null, observedAt, recalledMemoryIds: recalled, ...(read.length ? { readSourceIds: read } : {}) });

describe('fcaProvenanceForCheck: the same verdict over fewer sources', () => {
  it('keeps every id once at its earliest observation, the earliest time of all, and leaves conversation turns as they are', () => {
    const turn: TaskSource = { kind: 'conversation', stepId: 'turn-1', experienceId: 'exp-1', threadId: 'thread', observedAt: '2026-10-14T01:00:00.000Z', recalledMemoryIds: ['a'] };
    const rows = [turn,
      memoryRow('memory:s1:x', '2026-10-14T01:00:05.000Z', []),
      memoryRow('memory:s2:x', '2026-10-14T01:00:10.000Z', ['a', 'b'], ['shannon-skill://one']),
      memoryRow('memory:s3:x', '2026-10-14T01:00:20.000Z', ['b', 'c'], ['shannon-skill://one']),
      memoryRow('memory:s4:x', '2026-10-14T01:00:30.000Z', ['a'], ['shannon-skill://one'])];
    expect(fcaProvenanceForCheck(rows)).toEqual([turn,
      memoryRow('memory:s1:x', '2026-10-14T01:00:05.000Z', []),
      memoryRow('memory:s2:x', '2026-10-14T01:00:10.000Z', ['a', 'b'], ['shannon-skill://one']),
      memoryRow('memory:s3:x', '2026-10-14T01:00:20.000Z', ['c'])]);
  });

  it('folds consecutive times into the earliest of them past the limit, never dropping an id', () => {
    const rows = Array.from({ length: 200 }, (_, index) => memoryRow(`memory:s${String(index).padStart(3, '0')}:x`,
      new Date(Date.parse('2026-10-14T01:00:00.000Z') + index * 1000).toISOString(), [`id-${index}`], [`shannon-skill://s${index % 7}`]));
    const folded = fcaProvenanceForCheck(rows, 10);
    expect(folded).toHaveLength(10);
    expect(new Set(folded.flatMap(source => source.recalledMemoryIds))).toEqual(new Set(rows.flatMap(row => row.recalledMemoryIds)));
    // Each id is judged no later than where any row observed it (stricter, never weaker).
    for (const source of folded) for (const id of source.recalledMemoryIds) {
      expect(source.observedAt <= rows.find(row => row.recalledMemoryIds.includes(id))!.observedAt).toBe(true);
    }
    expect(folded[0]!.observedAt).toBe(rows[0]!.observedAt);
  });
});

describe('the provenance guard over a long Minecraft task (task 788da00a)', () => {
  /** A Minecraft task's rows as production had them: per step one recall packet and one skill-index read, a second apart. */
  function stepRows(f: ReturnType<typeof world>, steps: number, start: number) {
    const rows: TaskSource[] = [];
    for (let step = 0; step < steps; step++) {
      const at = new Date(start + step * 30_000).toISOString();
      const recalled = Array.from({ length: 30 }, (_, k) => f.pool[(step * 5 + k) % 64]!);
      rows.push(memoryRow(`memory:step-${String(step).padStart(3, '0')}:${createHash('sha256').update(recalled.join()).digest('hex')}`, at, recalled));
      rows.push(memoryRow(`memory:step-${String(step).padStart(3, '0')}:read:skill-index`, at, [], f.skillSources));
    }
    return rows;
  }
  function guard(f: ReturnType<typeof world>) {
    const h = actionHarness(f.w.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: f.w.now, canRunTask: () => false,
      model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
    cleanups.push(() => driver.close());
    const visible = createFcaSourceGuard({ runtime: driver.runtime, state: f.w.store, conversations: f.w.store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: f.readSourceVisible });
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木のツルハシを作る', completionCriteria: '持ち物で確かめる' }, 'minecraft-cap');
    return { driver, visible, task };
  }

  it('shows a task with 100 rows over 64 distinct ids, with no cap and no stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = world(), g = guard(f);
    f.w.advance(60_000);
    const rows = stepRows(f, 50, Date.parse(f.w.now()));
    expect(rows.length).toBeGreaterThan(FCA_PROVENANCE_LIMITS.sources);
    expect(fcaProvenanceForCheck(rows).length).toBeLessThanOrEqual(FCA_PROVENANCE_LIMITS.sources);
    expect(g.visible.sources('owner', g.task, rows)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(warn.mock.calls.some(([line]) => String(line).includes('fca_provenance_capped'))).toBe(false);
    expect(['stopped', 'stopping']).not.toContain(g.driver.runtime.get('owner', g.task.id)!.phase);
  });

  it('gives the same verdict as every row judged on its own, for forgotten, corrected and clean ids', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = world(), g = guard(f);
    const corrected = f.ids.at(-2)!; // a recent turn, as the owner corrects one from his memory list
    f.w.advance(60_000);
    const before = Date.parse(f.w.now());
    f.w.advance(5 * 60_000);
    f.memories.mutate('owner', { memoryId: corrected, action: 'correct', text: '訂正された内容' });
    f.w.advance(5 * 60_000);
    const after = Date.parse(f.w.now());
    const clean = f.pool.filter(id => id !== corrected);
    const at = (base: number, index: number) => new Date(base + index * 1000).toISOString();
    const cases: Array<[string, TaskSource[]]> = [
      ['clean ids before and after the correction', [memoryRow('memory:a:1', at(before, 0), clean.slice(0, 20)), memoryRow('memory:a:2', at(after, 0), clean.slice(10, 40))]],
      ['the corrected id only after its correction', [memoryRow('memory:b:1', at(before, 0), clean.slice(0, 20)), memoryRow('memory:b:2', at(after, 0), [corrected, ...clean.slice(0, 5)])]],
      ['the corrected id before its correction, again after', [memoryRow('memory:c:1', at(before, 0), [corrected]), memoryRow('memory:c:2', at(after, 0), [corrected, ...clean.slice(0, 5)])]],
      ['the forgotten turn in a late row only', [memoryRow('memory:d:1', at(before, 0), clean.slice(0, 20)), memoryRow('memory:d:2', at(after, 5), [f.forgotten])]],
      ['a withheld skill read late', [memoryRow('memory:e:1', at(before, 0), [], f.skillSources), memoryRow('memory:e:2', at(after, 0), [], ['shannon-skill://missing-skill'])]],
    ];
    const verdicts = cases.map(([label, rows]) => [label, g.visible.sources('owner', g.task, rows), rows.every(row => g.visible.sources('owner', g.task, [row]))]);
    for (const [label, together, alone] of verdicts) expect(together, String(label)).toBe(alone);
    expect(verdicts.map(([, together]) => together)).toEqual([true, true, false, false, false]);
  });

  it('keeps a forgotten id withheld wherever it sits among 100 rows, even when folded past the limit', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = world(200), g = guard(f);
    f.w.advance(60_000);
    const start = Date.parse(f.w.now());
    const rows = stepRows(f, 50, start);
    // Over the limit even after reduction: each of 90 later steps recalls one id never seen before, so the walk is folded.
    const spread = Array.from({ length: 90 }, (_, index) => memoryRow(`memory:new-${index}:x`, new Date(start + 10_000_000 + index * 1000).toISOString(), [f.ids[100 + index]!]));
    expect(fcaProvenanceForCheck([...rows, ...spread]).length).toBe(FCA_PROVENANCE_LIMITS.sources);
    for (const position of [0, 37, rows.length - 1]) {
      const poisoned = rows.map((row, index) => index === position ? { ...row, recalledMemoryIds: [...row.recalledMemoryIds, f.forgotten] } : row);
      expect(g.visible.sources('owner', g.task, [...poisoned, ...spread]), `forgotten at row ${position}`).toBe(false);
    }
  });
});

describe('a Minecraft-shaped task with 60+ tool calls across several compactions (task 788da00a)', () => {
  const definition = (name: string, effect: 'read' | 'write'): FcaToolDefinition => ({ name, description: `${name} の身体操作。`,
    input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
  const TOOLS = [definition('minecraft.observe', 'read'), definition('mc.find-blocks', 'read'), definition('mc.dig-block-at', 'write'), definition('mc.craft-one', 'write')];
  const isSummary = (body: Record<string, unknown>) => (body.tools as Array<{ name?: string }>).some(tool => tool.name === 'fca_history_summary');
  const template = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [`${section}: 木のツルハシを作る作業の事実`]]));

  it('runs every step with its recall and skill index observed, and completes without the cap', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const f = world();
    f.w.advance(60_000);
    const STEPS = 34;
    const h = actionHarness(f.w.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
    let decisions = 0, toolCalls = 0, recalls = 0;
    const violations: string[] = [];
    const fixture = scriptedAnthropic(body => {
      const violation = anthropicRequestViolation(body);
      if (violation) { violations.push(violation); return anthropicRejection(violation); }
      if (isSummary(body)) return message([{ type: 'tool_use', id: `toolu_summary_${Math.random().toString(36).slice(2, 8)}`, name: 'fca_history_summary', input: { template: JSON.stringify(template) } }], 'tool_use');
      decisions += 1;
      if (decisions > STEPS) return message([{ type: 'tool_use', id: `toolu_complete_${decisions}`, name: 'fca_complete', input: { summary: '木のツルハシを作って装備した' } }], 'tool_use');
      return message(['minecraft.observe', 'mc.find-blocks', decisions % 2 ? 'mc.dig-block-at' : 'mc.craft-one']
        .map((name, index) => ({ type: 'tool_use', id: `toolu_${decisions}_${index}`, name: providerToolName(name), input: {} })), 'tool_use');
    });
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
    const summarizer = createAnthropicFcaSummarizer({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {} });
    const selector: FcaToolSelector = { async select(request) { return { names: request.tools.map(tool => tool.name), source: 'fallback' }; } };
    let visible!: ReturnType<typeof createFcaSourceGuard>;
    let only = '';
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now: f.w.now,
      canRunTask: (_runtime, id) => id === only,
      stepPorts: (runtime, step: TaskStep) => {
        const sourcesVisible = () => visible.sources('owner', step.snapshot.task, step.snapshot.sources);
        // As production observes them (`fcaSharedWiring.observeMemory`, `fcaResearchWiring.skillIndex`): one row per step each.
        const observe = (observationId: string, recalled: readonly string[], read?: readonly string[]) => {
          if (!runtime.observeSources(step, { observationId, recalledMemoryIds: recalled, ...(read ? { readSourceIds: read } : {}) })) return false;
          step.snapshot.sources = runtime.taskSources('owner', step.taskId, step.messageIds);
          return sourcesVisible();
        };
        const recall: TaskRecall = { start() {}, async finishSegment() {}, async cancelAll() {}, cancel() {},
          async packet(input) {
            recalls += 1;
            const sourceIds = Array.from({ length: 30 }, (_, k) => f.pool[(recalls * 5 + k) % 64]!);
            return { contextVersion: input.contextVersion, observedAt: f.w.now(), status: 'ready', items: [], sourceIds };
          } };
        const tools: FcaExternalTools = { definitions: TOOLS,
          skillIndex: () => observe('read:skill-index', [], f.skillSources) ? 'mc-skill-0..5: 木を集める手順' : '',
          async execute() { toolCalls += 1; return toolOk(JSON.stringify({ found: 'oak_log', distance: 12, inventory: 'x'.repeat(12_000) })); } };
        return { tools, selector, recall, sourcesVisible, taskVisible: () => true,
          observeMemory: (ids: readonly string[]) => observe(createHash('sha256').update(JSON.stringify([...new Set(ids)].sort())).digest('hex'), ids),
          history: { codec: anthropicFcaHistoryCodec, summarizer } };
      } });
    cleanups.push(() => driver.close());
    visible = createFcaSourceGuard({ runtime: driver.runtime, state: f.w.store, conversations: f.w.store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: f.readSourceVisible });
    const root = driver.runtime.ensureRoot('owner');
    const task: TaskView = driver.runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木のツルハシを作って装備する', completionCriteria: '持ち物と手元で確かめる' }, 'minecraft-long');
    only = task.id;
    for (let i = 0; i < 400 && !['completed', 'failed', 'unknown', 'stopped'].includes(driver.runtime.get('owner', task.id)?.phase ?? ''); i++) {
      await driver.tick(); await driver.drain(); f.w.advance(1_000);
    }
    const rows = driver.runtime.taskSources('owner', task.id);
    expect(violations).toEqual([]);
    expect(toolCalls).toBeGreaterThanOrEqual(60);
    expect(fixture.bodies.filter(isSummary).length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeGreaterThan(FCA_PROVENANCE_LIMITS.sources); // the shape that capped 788da00a
    expect(warn.mock.calls.some(([line]) => String(line).includes('fca_provenance_capped'))).toBe(false);
    expect(log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA step'))).toEqual([]);
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('completed');
  }, 120_000);
});
