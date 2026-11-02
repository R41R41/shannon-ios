import { afterEach, describe, expect, it, vi } from 'vitest';
import { planFromSeeds } from '@shannon/mind';
import type { FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { TaskBodyRecoveryStore } from '../src/mind/action/taskRuntime/store/taskBodyRecoveryStore.js';
import { forgetReplans, REPLAN, type ReplanLedger } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { createReplanFlow, type ReplanSources } from '../src/surfaces/minecraft/minecraftLlmcReplanFlow.js';
import { forgetStalls, type Stall } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { minecraftWorld } from './support/fcaBodyRecoveryWorld.js';

/**
 * Codex's fifth review of the head (2026-11-03): after a new plan was asked for, a decision that came back unknown was recovered from the checkpoint
 * the step began with, so the ask was given back to the limits (10 minutes between two, 3 for a node, 30 for a run) and Opus was asked again; 13 asks
 * in under 10 minutes in the reproduction. The ask is now counted in the checkpoint before it is sent (`TaskBodyRecoveryStore.saveKeys`, the flow's
 * `persist`), so an unknown result and a killed process both leave it counted.
 */
const worlds: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  forgetReplans();
  forgetStalls();
  for (const world of worlds.splice(0).reverse()) await world.close();
});
function world() {
  for (const method of ['log', 'warn', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  const made = minecraftWorld();
  worlds.push(made);
  return made;
}
type World = ReturnType<typeof world>;

const stall: Stall = { kind: 'node_stalled', key: 'p1', why: '節 p1 が 130 秒、進みが無い' };
const tree = planFromSeeds([{ title: '木', kind: 'wood', doneWhen: 'have:log>=3' }])!;
const sources = (): ReplanSources => ({ node: 'p1', goal: '木', seconds: 600, tree, doneStatus: null, now: [], facts: [], results: [], queue: [], knowledge: '' });
const done: FcaModelOutput = { decision: { kind: 'complete', summary: 'done' }, history: [{ role: 'assistant', text: 'done' }] };
const row = (w: World, taskId: string) => w.db.prepare('SELECT step_id,checkpoint_json FROM fca_task_checkpoints WHERE task_id=?').get(taskId) as
  { step_id: string | null; checkpoint_json: string | null } | undefined;
const keptLedger = (w: World, taskId: string): ReplanLedger | null => {
  const json = row(w, taskId)?.checkpoint_json;
  return json ? (JSON.parse(json) as { minecraftReplans?: ReplanLedger }).minecraftReplans ?? null : null;
};
/** The flow of the step the task is in, keeping the ledger as the Minecraft wiring does (`serverFcaWiring.ts`). */
function flowIn(w: World, taskId: string, reply: () => Promise<unknown>) {
  const keeper = new TaskBodyRecoveryStore(w.db), stepId = row(w, taskId)!.step_id!;
  return createReplanFlow({ taskId, saved: undefined, replanner: reply, clock: () => 1_000, sources, check: () => null, log: () => undefined,
    persist: keys => keeper.saveKeys(taskId, stepId, keys) });
}
/** The flow of a later step, from the ledger the recovery kept: it is asked again at `at` ms of the running clock, and says whether it asked. */
async function askedAgain(saved: ReplanLedger | null, at: number): Promise<boolean> {
  let asked = false;
  const flow = createReplanFlow({ taskId: 't', saved, replanner: async () => { asked = true; return { ops: [], why: '' }; }, clock: () => at, sources, check: () => null,
    log: () => undefined });
  flow.note(stall);
  await flow.run(new AbortController().signal);
  return asked;
}

describe('the ask for a new plan is counted in the checkpoint before it is sent', () => {
  it('a decision that comes back unknown after the ask is recovered with the ask counted: the gap holds, the counts go on', async () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    w.connectBody(api, 'c1', 'complete');
    const asks: string[] = [];
    w.script.push(async () => {
      const flow = flowIn(w, task.id, async () => { asks.push('first'); return { ops: [], why: '' }; });
      flow.note(stall);
      await flow.run(new AbortController().signal);
      throw new Error('FCA_MODEL_RESPONSE_UNKNOWN');
    });
    let recovered: ReplanLedger | null = null;
    w.script.push(() => {
      recovered = keptLedger(w, task.id);
      return done;
    });
    await w.until(api, () => w.phase(api) === 'completed', 'the task is recovered and completes');
    expect(asks).toEqual(['first']);
    expect(w.events()).toEqual(expect.arrayContaining(['fca_recovery_unknown', 'fca_body_recovered']));
    expect(recovered).toMatchObject({ total: 1, nodes: { p1: 1 } });
    expect(await askedAgain(recovered, 1_000 + REPLAN.gapMs - 1)).toBe(false);
    expect(await askedAgain(recovered, 1_000 + REPLAN.gapMs)).toBe(true);
  });

  it('a process killed after the ask was sent is recovered with the ask counted too', async () => {
    const w = world();
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(async (input, signal) => {
      const flow = flowIn(w, task.id, () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('model_abort')), { once: true })));
      flow.note(stall);
      await flow.run(signal);
      signal.throwIfAborted(); // the world's closing aborts the ask; the decision then ends with it
      return w.hangs(input, signal);
    });
    await w.until(first, () => keptLedger(w, task.id) !== null, 'the ask is counted before it is sent');
    w.kill(body);
    let recovered: ReplanLedger | null = null;
    w.script.push(() => {
      recovered = keptLedger(w, task.id);
      return done;
    });
    const api = w.startApi();
    w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.phase(api) === 'completed', 'the task is recovered after the kill');
    expect(recovered).toMatchObject({ total: 1, nodes: { p1: 1 } });
    expect(await askedAgain(recovered, 1_000 + REPLAN.gapMs - 1)).toBe(false);
  });
});

describe('TaskBodyRecoveryStore.saveKeys', () => {
  it('writes the keys beside the others only while the step holds the task, and says whether it did', () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    const keeper = new TaskBodyRecoveryStore(w.db);
    expect(keeper.saveKeys(task.id, 'no-step', { a: 1 })).toBe(false);
    expect(keeper.saveKeys('no-task', 'no-step', { a: 1 })).toBe(false);
    w.db.prepare("UPDATE fca_task_checkpoints SET step_id='s1',checkpoint_json=? WHERE task_id=?").run(JSON.stringify({ kept: true, a: 0 }), task.id);
    expect(keeper.saveKeys(task.id, 's2', { a: 2 })).toBe(false);
    expect(JSON.parse(row(w, task.id)!.checkpoint_json!)).toEqual({ kept: true, a: 0 });
    expect(keeper.saveKeys(task.id, 's1', { a: 1, b: [2] })).toBe(true);
    expect(JSON.parse(row(w, task.id)!.checkpoint_json!)).toEqual({ kept: true, a: 1, b: [2] });
    expect(row(w, task.id)!.step_id).toBe('s1');
  });
});

describe('the flow keeps the ledger before it asks', () => {
  const make = (persist: (keys: { minecraftReplans: ReplanLedger; minecraftReplanPending: unknown }) => boolean) => {
    const events: string[] = [], lines: string[] = [], kept: Array<{ minecraftReplans: ReplanLedger; minecraftReplanPending: unknown }> = [];
    const flow = createReplanFlow({ taskId: 'flow', saved: undefined, replanner: async () => {
      events.push('asked');
      return { ops: [], why: '' };
    }, clock: () => 0, sources, check: () => null, log: line => lines.push(line), persist: keys => {
      events.push('kept');
      kept.push(keys);
      return persist(keys);
    } });
    return { flow, events, lines, kept };
  };
  const signal = new AbortController().signal;

  it('keeps the ledger with the ask counted and no waiting stall, then asks', async () => {
    const { flow, events, kept } = make(() => true);
    flow.note(stall);
    await flow.run(signal);
    expect(events).toEqual(['kept', 'asked']);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.minecraftReplans).toMatchObject({ total: 1, nodes: { p1: 1 } });
    expect(kept[0]!.minecraftReplans.last[0]).toMatchObject({ outcome: 'failed', why: '頼んだ（答えを待っている）' });
    expect(kept[0]!.minecraftReplanPending).toBeNull();
    expect(flow.ledger().total).toBe(1);
  });

  it('asks nothing when the ledger could not be kept (false or a throw), keeps the stall for the next decision, and says it once', async () => {
    let answer: boolean | 'throw' = false;
    const { flow, events, lines } = make(() => {
      if (answer === 'throw') throw new Error('disk');
      return answer;
    });
    flow.note(stall);
    await flow.run(signal);
    answer = 'throw';
    await flow.run(signal);
    expect(events).toEqual(['kept', 'kept']);
    expect(lines.filter(line => line.includes('why=not_kept'))).toHaveLength(1);
    expect(flow.ledger().total).toBe(0);
    expect(flow.checkpoint().minecraftReplanPending).not.toBeNull();
    answer = true;
    await flow.run(signal);
    expect(events).toEqual(['kept', 'kept', 'kept', 'asked']);
    expect(flow.ledger().total).toBe(1);
    expect(flow.checkpoint().minecraftReplanPending).toBeNull();
  });

  it('is as it was where nothing keeps the ledger', async () => {
    const asks: number[] = [];
    const flow = createReplanFlow({ taskId: 'x', saved: undefined, replanner: async () => { asks.push(1); return { ops: [], why: '' }; }, clock: () => 0, sources,
      check: () => null, log: () => undefined });
    flow.note(stall);
    await flow.run(signal);
    expect(asks).toHaveLength(1);
    expect(flow.ledger().total).toBe(1);
  });
});
