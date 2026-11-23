import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, planFromSeeds, planPath } from '@shannon/mind';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { queuePromptLines } from '../src/surfaces/minecraft/minecraftRequestQueue.js';
import type { QueueRecord, QueueSnapshot } from '../src/surfaces/minecraft/minecraftRequestQueue.js';
import { voiceHistoryProjection } from '../src/mind/action/respond/apiPromptProjection.js';
import { targetUpdateProblem } from '../src/surfaces/minecraft/minecraftPlanRequirements.js';

/**
 * 2026-11-23, what was left of the plan rewrite after the priority fix: the ids a decision may name, a lift aimed at the wrong node, a done on a node that
 * names an acquisition (said as: drop what is not needed), the ops that fit applied while the others come back with their reason, the request's own
 * sentence, and the dated lines of the list, the history and the recalled words.
 */
const plan = () => planFromSeeds([{ title: '羊を飼ってベッドを作る', forbid: ['羊を倒さない'], children: [
  { title: '羊2頭を囲いで飼う', target: { item: 'sheep', count: 2 }, doneWhen: 'have:sheep>=2' },
  { title: '小麦を育てる' },
  { title: 'ベッドを作る' },
] }])!;

describe('the ids of the live plan', () => {
  it('lists every node id, the ones that are neither now nor next too', () => {
    const view = planPath(plan());
    expect(view.ids.split('・')).toEqual(['p1', 'p1.1', 'p1.2', 'p1.3']);
  });
});

describe('a lift aimed at another node', () => {
  it('says which node holds the line', () => {
    const result = applyPlanUpdate(plan(), { ops: [{ op: 'lift', id: 'p1.1', text: '羊を倒さない' }] });
    expect(result.problem).toContain('同じ文は p1 の行にある');
    expect(applyPlanUpdate(plan(), { ops: [{ op: 'lift', id: 'p1', text: '羊を倒さない' }] }).problem).toBeNull();
  });
});

describe('a done on a node with an acquisition target', () => {
  it('is turned away with the way to drop it', () => {
    const before = plan();
    const after = applyPlanUpdate(before, { ops: [{ op: 'set', id: 'p1.1', state: 'done' }] }).tree;
    const problem = targetUpdateProblem(before, after, null);
    expect(problem).toContain('drop');
    expect(problem).toContain('現物を持っている節だけ');
  });
});

describe('plan.update applies the ops that fit', () => {
  const open = () => createFcaPlanTools({ taskId: 't1', checkpoint: { fcaPlanTree: plan() }, rules: true });

  it('keeps the good op, names the wrong one and how it went wrong', async () => {
    const parts = open();
    const out = await parts.tools.execute!({ name: 'plan.update', input: { ops: [{ op: 'drop', id: 'p1.2' }, { op: 'drop', id: 'p3' }] },
      signal: new AbortController().signal } as never);
    expect(JSON.stringify(out)).toContain('一部だけ通した');
    expect(JSON.stringify(out)).toContain('ops[1]');
    expect(parts.port.tree().nodes.some(node => node.id === 'p1.2')).toBe(false);
    expect(parts.port.tree().nodes.some(node => node.id === 'p1.3')).toBe(true);
  });

  it('changes nothing when every op is turned away', async () => {
    const parts = open();
    const out = await parts.tools.execute!({ name: 'plan.update', input: { ops: [{ op: 'drop', id: 'p9' }] }, signal: new AbortController().signal } as never);
    expect(JSON.stringify(out)).toContain('計画は変えていない');
    expect(parts.port.tree().nodes).toHaveLength(4);
  });

  it('keeps the owner\'s own sentence of the request and shows it in the live plan', async () => {
    const parts = open();
    await parts.tools.execute!({ name: 'plan.update', input: { goal: '羊は飼わず、倒して羊毛でベッドを作る' }, signal: new AbortController().signal } as never);
    expect(parts.port.tree().goal).toBe('羊は飼わず、倒して羊毛でベッドを作る');
    expect(parts.port.view()?.goal).toContain('倒して羊毛');
  });
});

describe('the list, the history and the recalled words are dated', () => {
  const record = (over: Partial<QueueRecord>): QueueRecord => ({ id: 'a', seq: 8, goal: '羊を飼ってベッドを作る', state: 'running', pos: 0, origin: 'voice', requestId: null,
    experienceId: null, observedAt: null, askedBy: null, taskId: null, createdAt: '2026-11-23T08:29:58Z', updatedAt: '2026-11-23T08:29:58Z', endedAt: null, note: null,
    resumeAfter: null, ...over } as QueueRecord);
  const snapshot = (entries: QueueRecord[]) => ({ autoRun: true, nextSeq: 9, entries, rev: 1 }) as unknown as QueueSnapshot;

  it('marks a row that changed in the last quarter of an hour, with the time of the owner\'s clock', () => {
    const lines = queuePromptLines(snapshot([
      record({}), record({ id: 'b', seq: 7, state: 'paused', pos: 1, goal: 'ケーキを作る', updatedAt: '2026-11-23T08:29:56Z', resumeAfter: 'a' })]), '2026-11-23T08:35:00Z');
    expect(lines[0]).toContain('変わった: 17:29 に始まった');
    expect(lines[1]).toContain('変わった: 17:29 に保留。いまはしていない');
  });

  it('says nothing more of a row that changed long ago, or without a clock', () => {
    const rows = snapshot([record({})]);
    expect(queuePromptLines(rows, '2026-11-23T10:00:00Z')[0]).not.toContain('変わった');
    expect(queuePromptLines(rows)[0]).not.toContain('変わった');
  });

  it('puts the time at the head of a history line and says why', () => {
    const text = voiceHistoryProjection([{ role: 'assistant', content: 'ケーキ作りの途中なので', observedAt: '2026-11-23T08:29:20Z' }]);
    expect(text).toContain('[17:29] Shannon: ケーキ作りの途中なので');
    expect(text).toContain('その時刻の話');
    expect(voiceHistoryProjection([{ role: 'user', content: 'こんにちは' }])).toBe('[Recent conversation]\nUser: こんにちは');
  });
});

describe('a pair of ops that fit only together', () => {
  it('keeps a target set in one op and its doneWhen in the next (the rule judges the whole, as before the ops were taken one by one)', () => {
    const before = plan();
    const check = (after: Parameters<typeof targetUpdateProblem>[1]) => targetUpdateProblem(before, after, null);
    const pair = [{ op: 'set' as const, id: 'p1.1', target: { item: 'sheep', count: 3 } }, { op: 'set' as const, id: 'p1.1', doneWhen: 'have:sheep>=3' }];
    const result = applyPlanUpdate(before, { ops: pair }, { partial: true, check });
    expect(result.problem).toBeNull();
    expect(result.rejected).toBeUndefined();
    expect(result.tree.nodes.find(node => node.id === 'p1.1')?.doneWhen).toBe('have:sheep>=3');
  });
  it('still turns away an op that does not fit even as a whole', () => {
    const before = plan();
    const check = (after: Parameters<typeof targetUpdateProblem>[1]) => targetUpdateProblem(before, after, null);
    const ops = [{ op: 'set' as const, id: 'p1.1', target: { item: 'sheep', count: 3 } }, { op: 'set' as const, id: 'p1.2', title: '小麦を3つ育てる' }];
    const result = applyPlanUpdate(before, { ops }, { partial: true, check });
    expect(result.rejected?.length).toBe(1);
    expect(result.tree.nodes.find(node => node.id === 'p1.2')?.title).toBe('小麦を3つ育てる');
  });
});
