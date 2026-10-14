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
import { FcaProvenanceFoldCache } from '../src/mind/action/fca/fcaProvenanceFold.js';
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

/** The real source guard over a world, with a root and one Minecraft task under it. */
function guard(f: Pick<ReturnType<typeof world>, 'w' | 'readSourceVisible'>, provenance?: FcaProvenanceFoldCache) {
  const h = actionHarness(f.w.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: f.w.now, canRunTask: () => false,
    model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
  cleanups.push(() => driver.close());
  const visible = createFcaSourceGuard({ runtime: driver.runtime, state: f.w.store, conversations: f.w.store, ownerScope: 'owner', ownerAlone: () => true,
    readSourceVisible: f.readSourceVisible, ...(provenance ? { provenance } : {}) });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木のツルハシを作る', completionCriteria: '持ち物で確かめる' }, 'minecraft-cap');
  return { driver, visible, task, root };
}

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
    const selector: FcaToolSelector = { async select(request) { return { names: request.tools.map(tool => tool.name), source: 'catalog' }; } };
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

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const pad = (index: number) => String(index).padStart(4, '0');

describe('a task the cap does not apply to is never folded (review of 6f6b6f80)', () => {
  it('keeps a root with more than 64 times across a correction visible (runnable), where a capped task folds closed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = world(200), g = guard(f);
    const corrected = f.ids.at(-2)!;
    f.w.advance(60_000);
    f.memories.mutate('owner', { memoryId: corrected, action: 'correct', text: '訂正された内容' });
    const boundary = Date.parse(f.w.now());
    f.w.advance(10 * 60_000);
    // 100 times, one new id each; the correction falls between the 49th and the 50th, and the corrected id is observed only at
    // the 50th (after it). Folded to 64, the 49th and 50th share a bucket judged at the 49th's time, before the correction.
    const rows = Array.from({ length: 100 }, (_, index) => memoryRow(`memory:root-${pad(index)}:x`,
      iso(index < 49 ? boundary - (49 - index) * 1000 : boundary + (index - 48) * 1000), index === 49 ? [f.ids[index]!, corrected] : [f.ids[index]!]));
    expect(fcaProvenanceForCheck(rows, Infinity)).toHaveLength(100);
    const folded = fcaProvenanceForCheck(rows, FCA_PROVENANCE_LIMITS.sources);
    expect(folded.find(source => source.recalledMemoryIds.includes(corrected))!.observedAt <= iso(boundary)).toBe(true);
    expect(rows.every(row => g.visible.sources('owner', g.root, [row]))).toBe(true);
    expect(g.visible.sources('owner', g.root, rows)).toBe(true);
    expect(g.visible.sources('owner', { ...g.root, kind: 'conversation' }, rows)).toBe(true);
    expect(g.visible.sources('owner', { ...g.root, kind: 'sleep', origin: 'maintenance' }, rows)).toBe(true);
    // A capped task is folded and judged closed (stricter, never weaker): the accepted cost of a bounded walk.
    expect(g.visible.sources('owner', g.task, rows)).toBe(false);
  });
});

describe('the fold is computed once per set of rows (review of 6f6b6f80: 2,000 rows of 2,000 ids, ~164 ms a call)', () => {
  it('reuses the fold of 2,000 rows of 2,000 ids for every repeated check, and folds again only when a row is added', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = new FcaProvenanceFoldCache();
    const f = world(), g = guard(f, cache);
    const ids = Array.from({ length: 2000 }, (_, index) => `memory-perf-${index}`);
    const start = Date.parse(f.w.now());
    const rows = Array.from({ length: 2000 }, (_, index) => memoryRow(`memory:perf-${pad(index)}:x`, iso(start + index * 1000), ids));
    const began = performance.now();
    g.visible.sources('owner', g.root, rows);
    const first = performance.now() - began;
    const again = performance.now();
    for (let check = 0; check < 20; check++) g.visible.sources('owner', g.root, rows);
    const repeated = (performance.now() - again) / 20;
    expect(cache.misses).toBe(1);
    expect(repeated).toBeLessThan(Math.max(first, 50)); // each repeat skips the per-id pass (measured: a few ms against ~100+)
    g.visible.sources('owner', g.root, [...rows, memoryRow('memory:perf-new:x', iso(start + 3_000_000), ['memory-perf-new'])]);
    expect(cache.misses).toBe(2);
  });
});

/** A small deterministic generator (mulberry32), so that a failing case can be replayed from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The reviewer's fuzz (review of 6f6b6f80): worlds with two corrections, a forget, a reject and a forget later restored, at random
 * times between the rows' times; turns that recalled the corrected items; skill reads, one of a skill that does not exist; and
 * task words that restate a corrected turn as it was before.
 */
function fuzzWorld(seed: number) {
  const next = random(seed), w = memoryWorld(); cleanups.push(() => w.close());
  const ids: string[] = [], said = (index: number) => `質問${index}について${String.fromCharCode(0x4e00 + index * 3)}${'あ'.repeat(24)}`;
  for (let index = 0; index < 40; index++) {
    w.advance(60_000);
    const recalled = index >= 30 ? [ids[20 + (index % 10)]!, ids[20 + ((index + 3) % 10)]!] : index > 0 ? [ids[(index * 7) % index]!] : [];
    ids.push(w.store.appendTurn('owner', `thread-${index % 2}`, said(index), `返答${index}${String.fromCharCode(0x5000 + index)}`, w.now(),
      { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: recalled }).id);
  }
  const skillDb = new DatabaseSync(':memory:'); cleanups.push(() => skillDb.close());
  const skillMemory = new SkillMemory({ database: skillDb, createsSchema: true, defer: work => work() });
  for (let index = 0; index < 3; index++) {
    const added = skillMemory.create('owner', { draft: { name: `fuzz-skill-${index}`, description: `手順${index}`, steps: `本文${index}`, aids: '- 確認',
      references: '- 元資料' }, evidence: [] }, { carries: () => false }, w.now());
    if ('rejected' in added) throw new Error(added.rejected);
  }
  const skills = skillTurnPorts(skillMemory, scope => w.store.snapshot(scope), w.store);
  const readSourceVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: w.store, conversations: w.store,
    skill: (scope, id, revision) => skills.readSource!(scope, id, revision) });
  w.store.readSourceVisible = readSourceVisible;
  // Six mutations at random slots between eight row times; a restore always after its forget.
  const ops: Array<[MemoryMutationAction, string]> = [['correct', ids[22]!], ['correct', ids[25]!], ['forget', ids[27]!], ['reject', ids[28]!],
    ['forget', ids[24]!], ['restore', ids[24]!]];
  for (let index = ops.length - 1; index > 0; index--) { const swap = Math.floor(next() * (index + 1)); [ops[index], ops[swap]] = [ops[swap]!, ops[index]!]; }
  const forgetAt = ops.findIndex(([action, id]) => action === 'forget' && id === ids[24]), restoreAt = ops.findIndex(([action]) => action === 'restore');
  if (restoreAt < forgetAt) [ops[restoreAt], ops[forgetAt]] = [ops[forgetAt]!, ops[restoreAt]!];
  const start = Date.parse(w.now()) + 60_000, times = Array.from({ length: 8 }, (_, slot) => iso(start + slot * 60_000));
  const memories = new ShannonMemoryService(w.store, w.store, w.now);
  let applied = 0;
  ops.forEach(([action, memoryId], slot) => {
    w.clock.at = start + slot * 60_000 + 30_000;
    memories.mutate('owner', { memoryId, action, ...(action === 'correct' ? { text: `訂正${memoryId.slice(0, 4)}` } : {}) });
    applied += 1;
  });
  w.clock.at = start + 9 * 60_000;
  const reads = [...skills.indexSources!('owner')!, 'shannon-skill://missing-skill'];
  return { w, ids, next, times, reads, readSourceVisible, applied, restated: [said(22), said(25)] };
}
type MemoryMutationAction = 'correct' | 'forget' | 'reject' | 'restore';

describe('the batched verdict equals every row judged on its own, and folding never loosens it (800 random cases)', () => {
  it('holds across corrections, a forget, a reject, a restore, recalled corrected turns, skill reads and restated words', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tally = { shown: 0, withheld: 0, cases: 0 };
    for (let seed = 1; seed <= 8; seed++) {
      const f = fuzzWorld(seed * 7919), g = guard(f);
      expect(f.applied).toBe(6);
      const pick = <T>(items: readonly T[]) => items[Math.floor(f.next() * items.length)]!;
      for (let index = 0; index < 100; index++) {
        const rows = Array.from({ length: 1 + Math.floor(f.next() * 6) }, (_, row) => memoryRow(`memory:fuzz-${seed}-${index}-${row}:x`, pick(f.times),
          Array.from({ length: Math.floor(f.next() * 5) }, () => pick(f.ids)), Array.from({ length: Math.floor(f.next() * 3) }, () => pick(f.reads))));
        const task = { ...g.task, goal: f.next() < 0.3 ? `${pick(f.restated)}を確かめる` : g.task.goal };
        const batched = g.visible.sources('owner', task, rows);
        const each = rows.every(row => g.visible.sources('owner', task, [row]));
        expect(batched, `seed ${seed} case ${index}`).toBe(each);
        for (const limit of [1, 2, 3]) {
          const folded = g.visible.sources('owner', task, fcaProvenanceForCheck(rows, limit));
          expect(!folded || batched, `seed ${seed} case ${index} limit ${limit}`).toBe(true);
        }
        tally.cases += 1; tally[batched ? 'shown' : 'withheld'] += 1;
      }
    }
    expect(tally.cases).toBe(800);
    expect(tally.shown).toBeGreaterThan(50);
    expect(tally.withheld).toBeGreaterThan(50);
  }, 120_000);
});
