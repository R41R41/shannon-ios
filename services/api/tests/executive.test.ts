import { describe, expect, it } from 'vitest';
import type { AutonomyTextRequest, AutonomyTextResult } from '../src/mind/action/ownTime/autonomyTextModel.js';
import { createExecutive, triggerOf, type ExecutiveChoices, type ExecutiveTasks } from '../src/mind/action/executive/executive.js';
import { FakeModel, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

/** Answers the Executive's deliberation from a queue; every other call is the harness's. */
class ExecutiveModel extends FakeModel {
  answers: unknown[] = [];
  deliberations = 0;
  override async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    if (!request.system.includes('次に何をするかを、一つだけ選ぶ')) return super.generate(request);
    this.calls.push(request);
    this.deliberations += 1;
    const answer = this.answers.shift() ?? { capability: 'rest', reason: '少し休みます。', nextThinkMinutes: 60 };
    return { text: JSON.stringify(answer), usage: { inputTokens: 1_000, outputTokens: 200 } };
  }
}

function world(options: { tasks?: ExecutiveTasks; choices?: ExecutiveChoices } = {}) {
  const model = new ExecutiveModel();
  const executive = createExecutive({ ...(options.tasks ? { tasks: options.tasks } : {}), ...(options.choices ? { choices: options.choices } : {}) });
  const harness = loopHarness({ model, executive });
  const goal = harness.service.addPursuit(scope, { kind: 'work', title: '雨の日の物語', why: '書きたいからです。', origin: 'self' }).pursuit!;
  return { ...harness, model, goal };
}

function fakeTasks() {
  const created: Array<{ capability: string; requestId: string }> = [];
  const status = new Map<string, ReturnType<ExecutiveTasks['status']>>();
  const tasks: ExecutiveTasks = {
    create(_scope, spec) { created.push(spec); status.set(`task-${created.length}`, 'running'); return `task-${created.length}`; },
    status: (_scope, id) => status.get(id) ?? null,
  };
  return { tasks, created, status };
}

describe('the Executive (ADR-0009 stage 2, E5)', () => {
  it('replaces the old thought: one deliberation, then the one step it chose, and the old planner is never asked', async () => {
    const { loop, model, store, goal } = world();
    model.answers.push({ capability: 'create.story', goalId: goal.id, args: { intent: '雨の音から始まる話' }, reason: '今日は書けそう', nextThinkMinutes: 600 });
    const ticks = await runUntilIdle(loop);
    expect(ticks.at(-1)).toBe('cycle-ended');
    expect(model.deliberations).toBe(1);
    expect(model.kinds()).not.toContain('think');
    expect(model.kinds()).toContain('draft');
    const record = store.deliberations.last(scope)!;
    expect(record).toMatchObject({ capability: 'create.story', goalId: goal.id, dispatch: 'procedure', trigger: 'first', reason: '今日は書けそう', outcome: 'pending' });
    // Her chosen time is held inside three hours while she is awake.
    expect(Date.parse(record.nextThinkAt) - Date.parse(record.at)).toBe(180 * 60_000);
    expect(store.loop.steps(record.cycleId!).map(step => step.step.kind)).toEqual(['think', 'draft']);
  });

  it('starts nothing inside the gap, inside a rest she chose, in quiet hours or while the owner talks', async () => {
    const { loop, model, store, advance, showing, clock } = world();
    model.answers.push({ capability: 'rest', reason: '休む', nextThinkMinutes: 120 });
    await runUntilIdle(loop);
    expect(store.deliberations.last(scope)?.dispatch).toBe('none');
    advance(30 * 60_000);
    expect(triggerOf({ store }, scope, clock.at)).toBeNull();
    expect(await loop.tick()).toBe('idle');
    advance(91 * 60_000);
    showing.may = 'quiet-hours';
    expect(await loop.tick()).toBe('idle');
    showing.may = 'ok';
    showing.ownerActive = true;
    expect(await loop.tick()).toBe('owner-active');
    showing.ownerActive = false;
    expect(await runUntilIdle(loop)).toContain('cycle-ended');
    expect(model.deliberations).toBe(2);
    expect(store.deliberations.last(scope)?.trigger).toBe('interval');
  });

  it('thinks again when the owner reacts to her work, but not within twenty minutes', async () => {
    const { loop, model, store, advance, clock } = world();
    model.answers.push({ capability: 'notify.none', reason: 'まだ言わない', nextThinkMinutes: 150 });
    await runUntilIdle(loop);
    const piece = store.study.create(scope, { kind: 'story', title: '雨', body: 'x'.repeat(200) }, clock.at);
    if (typeof piece === 'string') throw new Error(piece);
    advance(5 * 60_000);
    (store as unknown as { database: import('node:sqlite').DatabaseSync }).database.prepare(`
      INSERT INTO study_feedback (feedback_id, scope_key, piece_id, version, reaction, comment, created_at) VALUES ('f1', ?, ?, 1, 'like', '', ?)
    `).run(scope, piece.id, clock.at);
    expect(triggerOf({ store }, scope, clock.at)).toBeNull();
    advance(20 * 60_000);
    expect(triggerOf({ store }, scope, clock.at)).toBe('attention');
    expect(model.deliberations).toBe(1);
  });

  it('dispatches research as one own-time task, and records what came of it to the goal and the choice ledger', async () => {
    const { tasks, created, status } = fakeTasks();
    const reports: Array<[string, number]> = [];
    const choices: ExecutiveChoices = { choose: () => 'choice-1', report: (_scope, id, success) => { reports.push([id, success]); } };
    const { loop, model, store, goal, advance } = world({ tasks, choices });
    store.pursuits.goals.setPredicate(scope, goal.id, { type: 'research_report' }, 'shannon', '2026-10-02T01:00:00.000Z');
    model.answers.push({ capability: 'research.read', goalId: goal.id, args: { intent: '雨の音の科学' }, reason: '調べたい', nextThinkMinutes: 90 });
    await runUntilIdle(loop);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ capability: 'research.read' });
    const record = store.deliberations.last(scope)!;
    expect(record).toMatchObject({ dispatch: 'fca', taskId: 'task-1', outcome: 'pending', choiceId: 'choice-1', cycleId: null });
    // The cycle held only the deliberation: the task runs in the API process.
    expect(model.kinds().filter(kind => kind !== 'revise')).toEqual([]);
    status.set('task-1', 'done');
    advance(25 * 60_000);
    await loop.tick();
    expect(store.deliberations.since(scope, '2000-01-01T00:00:00.000Z').find(row => row.id === record.id)?.outcome).toBe('done');
    expect(reports).toEqual([['choice-1', 1]]);
    expect(store.pursuits.get(scope, goal.id)?.status).toBe('done');
    expect(store.pursuits.goals.columns(scope).get(goal.id)?.closedReason).toBe('evidence');
  });

  it('keeps an unknown or refused answer from dispatching anything, and does not ask again at once', async () => {
    const { loop, model, store } = world();
    model.answers.push({ capability: 'minecraft.session', reason: '遊びたい' });
    await runUntilIdle(loop);
    expect(store.deliberations.last(scope)).toBeNull();
    expect(await loop.tick()).toBe('idle');
    expect(model.deliberations).toBe(1);
  });

  it('stays out of the way when the budget is spent', async () => {
    const { loop, model, store, config } = world();
    store.recordSpend(scope, '2026-10-02', '2026-10-02T00:30:00.000Z', { model: 'x', inputTokens: 0, outputTokens: 0, costUsd: 20, costYen: config.dailyBudgetYen });
    expect(await loop.tick()).toBe('budget');
    expect(model.deliberations).toBe(0);
  });
});
