import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionRecorder, HEAD_HOLD_ROWS } from '../src/infra/decisionRecords/decisionRecorder.js';
import { noteRedecide as noteRedecideRow } from '../src/infra/decisionRecords/decisionRecordNotes.js';
import { tailRun } from '../src/infra/decisionRecords/decisionRecordRead.js';
import { withDecisionScope } from '../src/infra/decisionRecords/decisionRecordScope.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { toolFailure, toolOk } from '../src/mind/tools/shannonTools.js';
import { SAME_IN_QUEUE_WORDS } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { meterLine, meterParts } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { v2tree } from './helpers/planTreeV2.js';
import {
  forgetStalls, MOVING, movedOn, noteDeath, noteProgress, noteRan, noteRedecide, noteRefusal, resumeStalls, stallIncidentId, stallQuiet, STALL, watchStalls, type ProgressSnapshot, type Stall,
} from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { headIncidentKind, setIncidentHoldPort, type IncidentHoldPort, type IncidentNote } from '../src/wiring/minecraftIncidentHold.js';
import { controlId } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { createOperatorMinecraft, type OperatorActivity, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import type { OperatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import { benchC, until, type BenchC } from './helpers/benchC.js';

/**
 * Amendment A-12 (owner's decision 2026-10-29: 「新しい版だけ・詰まったら止めて直す」): the head finds five kinds of stall itself, and a request that asked to be held (`--hold-on-failure`)
 * is held for them: node_stalled, same_spot_stops, wait_loop, decide_error and death. Part 1 is the detection (pure, per task, no clock but the one it is given); part 2 the box the
 * head writes (the reason and the last rows of the decision record); part 3 the operator's side (the audit line, the activity, the resume); part 4 the real step parts on the
 * bench C (the hold port is played by the test; no model is called).
 */
const TASK = 'task-stalls';

describe('run54: a repaired dig permission is distinct from falling gravel', () => {
  const ceiling = () => stopAt(20, 40, 22, { code: 'dead_end', line: '頭の上 (20,42,22) が copper_ore で登れない（掘ってよい物に無い）。canDig に足すか、別の場所から' });
  const gravel = () => stopAt(20, 43, 22, { do: 'vertical', code: 'displaced', line: '跳んでいる間に足のマス (20,42,22) が gravel になった' });
  it('gives the new physical cause one attempt, retaining a repeat of that cause', () => {
    expect(ranGo([ceiling()])).toBeNull();
    expect(ranGo([gravel()])).toBeNull();
    expect(ranGo([gravel()])).toMatchObject({ kind: 'same_spot_stops' });
  });
  it('still holds the same unrepaired ceiling permission twice', () => {
    expect(ranGo([ceiling()])).toBeNull();
    expect(ranGo([ceiling()])).toMatchObject({ kind: 'same_spot_stops' });
  });
});
afterEach(() => { forgetStalls(); setIncidentHoldPort(null); });

// ---- 1. the detection ---------------------------------------------------------------------------------------------------------------------------------
const snapshot = (over: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({ node: 'p3', state: 'doing', milestone: '鉄の道具', items: 10, ...over });
const line = (over: Record<string, unknown>) => ({ do: 'go', status: 'stopped', goal: 'failed', end: 'finished', line: '', ...over });
const result = (lines: Array<Record<string, unknown>>, at = { x: 1, y: 64, z: 1 }) => JSON.stringify({ v: 1, ok: false, done: 0, of: lines.length, ms: 1000, at, hp: 20, food: 20,
  lines: lines.map((item, index) => ({ i: index + 1, ...item })) });
const stopAt = (x: number, y: number, z: number, over: Record<string, unknown> = {}) => line({ goal: 'partial', end: 'cut', progress: { unit: 'meter', done: 3, left: 9, at: { x, y, z } }, ...over });
const doneGo = (over: Record<string, unknown> = {}) => line({ status: 'done', goal: 'done', end: 'finished', ...over });
const waitLine = (over: Record<string, unknown> = {}) => line({ do: 'wait', status: 'done', goal: 'done', end: 'finished', ...over });
const ranGo = (lines: Array<Record<string, unknown>>, command = 'skill:c1') => noteRan(TASK, { hands: [{ do: 'go' }], result: result(lines), command });
const ranWait = (lines: Array<Record<string, unknown>> = [waitLine()]) => noteRan(TASK, { hands: [{ do: 'wait' }], result: result(lines) });

describe('node_stalled: the current node, 120 seconds of the task\'s running time, no progress', () => {
  it('fires at 120 s of nothing, and not before', () => {
    expect(noteProgress(TASK, snapshot(), 0)).toBeNull();
    expect(noteProgress(TASK, snapshot(), 119_000)).toBeNull();
    const stall = noteProgress(TASK, snapshot(), 120_000)!;
    expect(stall).toMatchObject({ kind: 'node_stalled', key: 'p3' });
    expect(stall.why).toContain('120 秒');
    expect(stall.why).toContain('p3');
    expect(stallQuiet(TASK)).toBe(true);
  });

  it('the clock starts again when the node, its state, the meter\'s next milestone or the pack\'s count moves on', () => {
    expect(STALL.nodeMs).toBe(120_000);
    const moves: Array<Partial<ProgressSnapshot>> = [{ node: 'p4' }, { state: 'done' }, { milestone: 'ネザーに入る' }, { items: 11 }];
    for (const move of moves) {
      forgetStalls();
      expect(noteProgress(TASK, snapshot(), 0)).toBeNull();
      expect(noteProgress(TASK, snapshot(), 100_000)).toBeNull();
      expect(noteProgress(TASK, snapshot(move), 110_000)).toBeNull();
      // 110 s after the start, 10 s after the move: 125 s from the start but 15 s from the move.
      expect(noteProgress(TASK, snapshot(move), 125_000)).toBeNull();
      expect(noteProgress(TASK, snapshot(move), 229_000)).toBeNull();
      expect(noteProgress(TASK, snapshot(move), 230_000)).toMatchObject({ kind: 'node_stalled' });
    }
  });

  it('a pack that grew then shrank by spending is not progress, and a shrinking pack alone does not restart the clock', () => {
    expect(movedOn(snapshot({ items: 10 }), snapshot({ items: 9 }))).toBe(false);
    expect(movedOn(snapshot({ items: 10 }), snapshot({ items: 10 }))).toBe(false);
    expect(movedOn(snapshot({ items: 10 }), snapshot({ items: 11 }))).toBe(true);
    noteProgress(TASK, snapshot({ items: 10 }), 0);
    expect(noteProgress(TASK, snapshot({ items: 6 }), 60_000)).toBeNull();
    expect(noteProgress(TASK, snapshot({ items: 6 }), 120_000)).toMatchObject({ kind: 'node_stalled' });
  });

  it('counts the running seconds only: a clock that stands still while the task is held does not run (wall clock less the held time)', () => {
    // The caller gives `wall - heldMs`. Held for 500 s in between: 100 s of running at wall 600 s, 140 s at wall 640 s.
    const active = (wall: number, held: number) => wall - held;
    expect(noteProgress(TASK, snapshot(), active(0, 0))).toBeNull();
    expect(noteProgress(TASK, snapshot(), active(600_000, 500_000))).toBeNull();
    expect(noteProgress(TASK, snapshot(), active(640_000, 500_000))).toMatchObject({ kind: 'node_stalled' });
    // Without taking the held time out the same task would have been found 500 s earlier.
    forgetStalls();
    noteProgress(TASK, snapshot(), 0);
    expect(noteProgress(TASK, snapshot(), 600_000)).toMatchObject({ kind: 'node_stalled' });
  });

  it('a plan with no current node counts nothing', () => {
    expect(noteProgress(TASK, snapshot({ node: null, state: null }), 0)).toBeNull();
    expect(noteProgress(TASK, snapshot({ node: null, state: null }), 500_000)).toBeNull();
    expect(noteProgress(TASK, snapshot(), 600_000)).toBeNull();
    expect(noteProgress(TASK, snapshot(), 720_000)).toMatchObject({ kind: 'node_stalled' });
  });

  it('the meter\'s next milestone is the one its line points at, whatever the seconds; a plan that is not the dragon\'s has none', () => {
    const tree = { ...v2tree({ revision: 1, current: 'p1', nodes: [
      { id: 'p1', parentId: null, order: 0, title: '鉄', state: 'continue', kind: 'iron' } as never,
      { id: 'p2', parentId: null, order: 1, title: 'エンドでドラゴン', state: 'wait', kind: 'dragon' } as never] }), promises: [] };
    const frame = { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
      state: { world: { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [{ name: 'bread', count: 8 }] } }, facts: {} } as never;
    const early = meterParts(tree, frame, 0)!, late = meterParts(tree, frame, 900 / 60)!;
    expect(early.next).toBeTruthy();
    expect(late.next).toBe(early.next);
    expect(early.line).toContain(`次の節目 ${early.next}`);
    expect(meterLine(tree, frame, 900 / 60)).toBe(late.line);
    expect(meterParts(null, null, 0)).toBeNull();
    expect(meterParts(v2tree({ revision: 1, current: 'p1', nodes: [{ id: 'p1', parentId: null, order: 0, title: '鉄', state: 'continue', kind: 'iron' } as never] }), frame, 0)).toBeNull();
  });
});

describe('same_spot_stops: go or vertical stopped short twice within 3 blocks', () => {
  it('fires at the second stop in the same place, with the command to send again', () => {
    expect(ranGo([stopAt(10, 64, 10, { code: 'go_stuck' })])).toBeNull();
    const stall = ranGo([stopAt(12, 64, 11, { code: 'go_stuck' })], 'skill:c2')!;
    expect(stall).toMatchObject({ kind: 'same_spot_stops', command: 'skill:c2', key: '10,64,10', at: { x: 10, y: 64, z: 10 } });
    expect(stall.why).toContain('(10,64,10)');
    expect(stall.why).toContain('go_stuck');
  });

  it('does not fire when the second stop is farther than 3 blocks (3 itself is the same place)', () => {
    expect(ranGo([stopAt(10, 64, 10)])).toBeNull();
    expect(ranGo([stopAt(14, 64, 10)])).toBeNull();
    forgetStalls();
    expect(ranGo([stopAt(10, 64, 10)])).toBeNull();
    expect(ranGo([stopAt(13, 64, 10)])).toMatchObject({ kind: 'same_spot_stops' });
  });

  it('a done go or vertical between the two stops ends the run; a stop of another kind of hand is not counted', () => {
    expect(ranGo([stopAt(10, 64, 10)])).toBeNull();
    expect(ranGo([doneGo()])).toBeNull();
    expect(ranGo([stopAt(10, 64, 10)])).toBeNull();
    forgetStalls();
    expect(ranGo([stopAt(10, 64, 10)])).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'dig' }], result: result([stopAt(10, 64, 10, { do: 'dig' })]) })).toBeNull();
    expect(stallQuiet(TASK)).toBe(false);
  });

  it('counts vertical as go, places a stop without a position at the act\'s end, and counts the not_started and failed ones', () => {
    expect(noteRan(TASK, { hands: [{ do: 'vertical' }], result: result([stopAt(5, 40, 5, { do: 'vertical' })]) })).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'vertical' }], result: result([stopAt(6, 41, 5, { do: 'vertical', goal: 'failed', end: 'finished' })]) })).toMatchObject({ kind: 'same_spot_stops' });
    forgetStalls();
    // `where` when there is no progress.at; the act's own end when neither.
    const moved = { progress: { unit: 'meter', done: 1, left: 4 } };   // a stop counts when it spent a step (A-13)
    expect(ranGo([line({ goal: 'not_started', where: { x: 7, y: 64, z: 7 }, ...moved })])).toBeNull();
    expect(ranGo([line({ goal: 'failed', where: { x: 8, y: 64, z: 7 }, ...moved })])).toMatchObject({ kind: 'same_spot_stops', at: { x: 7, y: 64, z: 7 } });
    forgetStalls();
    expect(ranGo([line({ goal: 'failed', ...moved })])).toBeNull();
    expect(ranGo([line({ goal: 'failed', ...moved })])).toMatchObject({ kind: 'same_spot_stops', at: { x: 1, y: 64, z: 1 } });
  });

  it('A-13 (run 46): the quick refusals with their mend are not stops in one place; the real ones are', () => {
    const quick = (code: string, goal: string, x: number) => ranGo([line({ goal, code, where: { x, y: 28, z: 212 }, progress: { unit: 'meter', done: 0, left: 3, at: { x, y: 28, z: 212 } }, motorOps: 0 })]);
    // dead_end (no path, 0 steps, 1 s) then, after other work, no_floor (0 steps): neither is a stop that spent anything
    expect(quick('dead_end', 'partial', 187)).toBeNull();
    expect(quick('no_floor', 'not_started', 186)).toBeNull();
    expect(stallQuiet(TASK)).toBe(false);
    // the same place twice with time spent (3 s and more in the only hand that ran) is held
    const slow = (x: number) => noteRan(TASK, { hands: [{ do: 'go' }], result: JSON.stringify({ v: 1, ok: false, done: 0, of: 1, ms: 5_000, at: { x, y: 28, z: 212 }, hp: 20, food: 20,
      lines: [{ i: 1, ...line({ goal: 'partial', end: 'cut', code: 'search_timeout', progress: { unit: 'meter', done: 0, left: 9, at: { x, y: 28, z: 212 } } }) }] }) });
    expect(slow(187)).toBeNull();
    expect(slow(186)).toMatchObject({ kind: 'same_spot_stops' });
    // a step, a dig or a placing counts without the seconds
    forgetStalls();
    const dug = (x: number) => ranGo([line({ goal: 'partial', progress: { unit: 'step', done: 0, left: 2, at: { x, y: 28, z: 212 }, work: { dug: 1 } } })]);
    expect(dug(187)).toBeNull();
    expect(dug(186)).toMatchObject({ kind: 'same_spot_stops' });
  });

  it('A-13 (run 46): other work done between the two stops (it dug, placed, made, smelted) counts the stops again', () => {
    const slowStop = (x: number) => ranGo([stopAt(x, 28, 212)]);
    expect(slowStop(187)).toBeNull();
    // iron dug, a table and a furnace placed, iron smelted: done hands that changed the pack and the world
    expect(noteRan(TASK, { hands: [{ do: 'dig' }, { do: 'place' }, { do: 'smelt' }], result: result([line({ do: 'dig', status: 'done', goal: 'done', end: 'finished' }),
      line({ do: 'place', status: 'done', goal: 'done', end: 'finished' }), line({ do: 'smelt', status: 'done', goal: 'done', end: 'finished' })]) })).toBeNull();
    expect(slowStop(186)).toBeNull();   // the first stop of a new count
    expect(slowStop(186)).toMatchObject({ kind: 'same_spot_stops' });
    // the run 46 order: a dead end of 0 steps, other work, a no_floor of 0 steps: no hold
    forgetStalls();
    const quick = (code: string, x: number) => ranGo([line({ goal: 'partial', code, progress: { unit: 'meter', done: 0, left: 3, at: { x, y: 28, z: 212 } }, motorOps: 0 })]);
    expect(quick('dead_end', 187)).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'dig' }], result: result([line({ do: 'dig', status: 'done', goal: 'done', end: 'finished' })]) })).toBeNull();
    expect(quick('no_floor', 186)).toBeNull();
    // a hand that was 'already' (nothing changed) does not count the stops again
    forgetStalls();
    expect(slowStop(187)).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'dig' }], result: result([line({ do: 'dig', status: 'done', goal: 'already', end: 'finished' })]) })).toBeNull();
    expect(slowStop(186)).toMatchObject({ kind: 'same_spot_stops' });
  });

  it('a hand that was not run, and a result that does not read, are not stops', () => {
    expect(ranGo([line({ status: 'skipped', goal: 'not_started', end: 'not_run' })])).toBeNull();
    expect(ranGo([line({ status: 'skipped', goal: 'not_started', end: 'not_run' })])).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'go' }], result: 'not json' })).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'go' }], result: undefined })).toBeNull();
  });

  it('two stops in one act (a repeating act) are two', () => {
    expect(ranGo([stopAt(10, 64, 10), stopAt(11, 64, 10)])).toMatchObject({ kind: 'same_spot_stops' });
  });
});

describe('wait_loop: acts of nothing but wait, three in a row', () => {
  it('fires at the third, not at the second', () => {
    expect(STALL.waits).toBe(3);
    expect(ranWait()).toBeNull();
    expect(ranWait()).toBeNull();
    expect(ranWait()).toMatchObject({ kind: 'wait_loop', key: '3' });
  });

  it('an act with a hand that moves the body between them ends the run', () => {
    expect(ranWait()).toBeNull();
    expect(ranWait()).toBeNull();
    expect(ranGo([doneGo()])).toBeNull();
    expect(ranWait()).toBeNull();
    expect(ranWait()).toBeNull();
    expect(stallQuiet(TASK)).toBe(false);
    expect(ranWait()).toMatchObject({ kind: 'wait_loop' });
    for (const kind of ['go', 'walk', 'vertical', 'dig', 'place', 'pillarUp', 'attack', 'fight']) expect(MOVING.has(kind)).toBe(true);
    for (const kind of ['wait', 'look', 'equip', 'eat', 'craft']) expect(MOVING.has(kind)).toBe(false);
  });

  it('an act of waits with another hand that does not move (look, equip) is not a wait-only act and is neither a wait nor a move', () => {
    expect(ranWait()).toBeNull();
    expect(noteRan(TASK, { hands: [{ do: 'wait' }, { do: 'look' }], result: result([waitLine(), line({ do: 'look', status: 'done', goal: 'done' })]) })).toBeNull();
    expect(ranWait()).toBeNull();
    expect(ranWait()).toMatchObject({ kind: 'wait_loop' });
  });

  it('an act that did not run is not a wait', () => {
    const notRun = [waitLine({ status: 'skipped', goal: 'not_started', end: 'not_run' })];
    expect(ranWait(notRun)).toBeNull();
    expect(ranWait(notRun)).toBeNull();
    expect(ranWait(notRun)).toBeNull();
    expect(ranWait()).toBeNull();
  });
});

describe('decide_error: the decision again, Opus\'s act, and the checks before sending', () => {
  it('a decision again that failed or ran out of time (the record\'s row: kept_first, failed)', () => {
    const stall = noteRedecide(TASK, { asked: true, count: 1, outcome: 'kept_first', why: 'failed', failed: 'timeout after 60000 ms' })!;
    expect(stall).toMatchObject({ kind: 'decide_error', key: 'redecide_failed' });
    expect(stall.why).toContain('timeout');
  });

  it('Opus\'s act refused by the checks (after its mend, when the code mends)', () => {
    const stall = noteRedecide(TASK, { asked: true, outcome: 'kept_first', why: 'refused', repairs: 1, refusedBy: '手が無い', repairRefusedBy: '届かない' })!;
    expect(stall).toMatchObject({ kind: 'decide_error', key: 'redecide_refused' });
    expect(stall.why).toContain('書き直しも断られた');
    expect(stall.why).toContain('届かない');
    forgetStalls();
    expect(noteRedecide(TASK, { asked: true, outcome: 'kept_first', why: 'refused', refusedBy: '手が無い' })).toMatchObject({ key: 'redecide_refused' });
  });

  it('A-18: Opus act that the queue or the world answered (stateAnswer: the same work is queued, a precondition) is not an error; a failed mend still is', () => {
    expect(noteRedecide(TASK, { asked: true, outcome: 'kept_first', why: 'refused', repairs: 1, refusedBy: '同じ手が列にある', stateAnswer: true })).toBeNull();
    expect(stallQuiet(TASK)).toBe(false);
    expect(noteRedecide(TASK, { asked: true, outcome: 'kept_first', why: 'refused', repairs: 1, refusedBy: '同じ手が列にある', stateAnswer: true, repairFailed: 'no_act' }))
      .toMatchObject({ key: 'redecide_refused' });
  });

  it('the other rows are not errors: used, the same act, no act, urgent, no stronger model, nothing asked', () => {
    for (const row of [{ outcome: 'used' }, { outcome: 'kept_first', why: 'no_act' }, { outcome: 'kept_first', why: 'no_act:max_tokens' }, { skipped: 'urgent', asked: false },
      { skipped: 'no_stronger_model', asked: false }, { asked: false, count: 0 }]) expect(noteRedecide(TASK, row)).toBeNull();
    expect(stallQuiet(TASK)).toBe(false);
  });

  it('two refusals before sending in a row, with no accepted act between, are one stall; an accepted act ends the run', () => {
    expect(STALL.refusals).toBe(2);
    expect(noteRefusal(TASK, { accepted: false, why: '手が多い' })).toBeNull();
    expect(noteRefusal(TASK, { accepted: true })).toBeNull();
    expect(noteRefusal(TASK, { accepted: false, why: '手が多い' })).toBeNull();
    const stall = noteRefusal(TASK, { accepted: false, why: '前提を満たさない\n体には何も送っていない' })!;
    expect(stall).toMatchObject({ kind: 'decide_error', key: 'check_refused' });
    expect(stall.why).toContain('2 回');
    expect(stall.why).not.toContain('\n');
  });

  it('the rows reach the step by the task, only for a recorded decision (the scope\'s record flag)', () => {
    const found: Stall[] = [];
    const unwatch = watchStalls(TASK, stall => found.push(stall));
    withDecisionScope({ taskId: TASK, stepId: 's1', record: false }, () => noteRedecideRow({ outcome: 'kept_first', why: 'failed', failed: 'x' }));
    expect(found).toHaveLength(0);
    withDecisionScope({ taskId: 'another', stepId: 's1', record: true }, () => noteRedecideRow({ outcome: 'kept_first', why: 'failed', failed: 'x' }));
    expect(found).toHaveLength(0);
    withDecisionScope({ taskId: TASK, stepId: 's1', record: true }, () => noteRedecideRow({ outcome: 'used' }));
    expect(found).toHaveLength(0);
    withDecisionScope({ taskId: TASK, stepId: 's1', record: true }, () => noteRedecideRow({ outcome: 'kept_first', why: 'failed', failed: 'x' }));
    expect(found).toMatchObject([{ kind: 'decide_error', key: 'redecide_failed' }]);
    unwatch();
    resumeStalls(TASK);
    withDecisionScope({ taskId: TASK, stepId: 's1', record: true }, () => noteRedecideRow({ outcome: 'kept_first', why: 'failed', failed: 'x' }));
    expect(found).toHaveLength(1);
  });
});

describe('death: a rise of the body\'s death counter', () => {
  const counter = (deathSeq: number, deathEpoch = 'de-1') => ({ deathEpoch, deathSeq });
  it('fires at the rise within one epoch; the first sight only remembers; a new epoch is not a death', () => {
    expect(noteDeath(TASK, counter(1))).toBeNull();
    expect(noteDeath(TASK, counter(1))).toBeNull();
    // A new epoch starts at 0 (the file was made again): that is not a death; its first reading above 0 is.
    expect(noteDeath(TASK, counter(0, 'de-2'))).toBeNull();
    expect(noteDeath(TASK, counter(1, 'de-2'))).toMatchObject({ kind: 'death', key: 'de-2-1' });
    forgetStalls();
    expect(noteDeath(TASK, null)).toBeNull();
    expect(noteDeath(TASK, {})).toBeNull();
  });

  it('is the same death after a full loss, and after the task is resumed (the death it held for is not found again); the next death is', () => {
    noteDeath(TASK, counter(0));
    expect(noteDeath(TASK, counter(1))).toMatchObject({ kind: 'death' });
    expect(stallQuiet(TASK)).toBe(true);
    // Quiet: the counter is still followed, nothing is found.
    expect(noteDeath(TASK, counter(2))).toBeNull();
    resumeStalls(TASK);
    expect(stallQuiet(TASK)).toBe(false);
    expect(noteDeath(TASK, counter(2))).toBeNull();
    expect(noteDeath(TASK, counter(3))).toMatchObject({ kind: 'death' });
  });
});

describe('a task that found a stall counts nothing more until it is resumed', () => {
  it('quiet, then resumed from nothing', () => {
    ranWait(); ranWait();
    expect(ranWait()).toMatchObject({ kind: 'wait_loop' });
    expect(ranWait()).toBeNull();
    expect(ranWait()).toBeNull();
    expect(ranWait()).toBeNull();
    expect(noteRefusal(TASK, { accepted: false, why: 'a' })).toBeNull();
    expect(noteRefusal(TASK, { accepted: false, why: 'a' })).toBeNull();
    resumeStalls(TASK);
    expect(ranWait()).toBeNull();
    expect(ranWait()).toBeNull();
    expect(ranWait()).toMatchObject({ kind: 'wait_loop' });
  });

  it('another task is not touched', () => {
    ranWait(); ranWait();
    expect(noteRan('other', { hands: [{ do: 'wait' }], result: result([waitLine()]) })).toBeNull();
    expect(ranWait()).toMatchObject({ kind: 'wait_loop' });
    expect(stallQuiet('other')).toBe(false);
  });

  it('the incident id names the kind, the key and the time, and is plain text', () => {
    const id = stallIncidentId({ kind: 'same_spot_stops', key: '10,64,10', why: 'x' }, 1_700_000_000_000);
    expect(id).toMatch(/^head:same_spot_stops:10_64_10:[0-9a-z]+$/u);
    expect(headIncidentKind(id)).toBe('same_spot_stops');
    expect(headIncidentKind('20261028T000000-act-ab12')).toBeNull();
    expect(headIncidentKind(undefined)).toBeNull();
    expect(stallIncidentId({ kind: 'node_stalled', key: 'p1 /../x', why: 'x' }, 1)).toMatch(/^head:node_stalled:p1__\.\._x:1$/u);
    // The commands that name an incident carry its id (`unhold:<id>:…`), and the control takes only ids of letters, digits and `_.:-`: a key with commas or spaces would make every poll invalid.
    for (const key of ['10,64,10', 'p1.1 鉄', 'a/b\\c', 'x'.repeat(100)]) {
      const made = stallIncidentId({ kind: 'same_spot_stops', key, why: 'x' }, 1_793_216_247_116);
      expect(controlId(`unhold:${made}:1793216247116`.slice(0, 150))).toBe(true);
      expect(controlId(`take:${made}`)).toBe(true);
      expect(made.length).toBeLessThanOrEqual(75);
    }
  });
});

// ---- 2. the box ---------------------------------------------------------------------------------------------------------------------------------------
describe('the head\'s box: the reason and the last rows of the decision record', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const recorder = () => {
    const root = mkdtempSync(join(tmpdir(), 'head-hold-'));
    roots.push(root);
    return { root, recorder: new DecisionRecorder({ root, head: { revision: 'test', source: 'git', node: process.version }, log: () => undefined }) };
  };

  it('writes <run>/head-holds/<id>.json with the reason and the last 20 rows, names it in the record, and returns its path below the root', () => {
    const { root, recorder: made } = recorder();
    for (let index = 0; index < 30; index += 1) made.append(TASK, { ev: 'applied', n: index });
    const path = made.headHold(TASK, { id: 'head:wait_loop:3:abc', kind: 'wait_loop', why: 'wait だけの act が 3 回続いた', detail: { current: 'p3' } })!;
    expect(path).toBe(`${TASK}/head-holds/head_wait_loop_3_abc.json`);
    const box = JSON.parse(readFileSync(join(root, path), 'utf8'));
    expect(HEAD_HOLD_ROWS).toBe(20);
    expect(box).toMatchObject({ v: 1, id: 'head:wait_loop:3:abc', kind: 'wait_loop', why: 'wait だけの act が 3 回続いた', taskId: TASK, detail: { current: 'p3' }, rows: 20 });
    expect(box.tail).toHaveLength(20);
    expect(box.tail.at(-1)).toMatchObject({ ev: 'applied', n: 29 });
    expect(box.tail[0]).toMatchObject({ ev: 'applied', n: 10 });
    const rows = readFileSync(join(root, TASK, 'events.jsonl'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
    expect(rows.at(-1)).toMatchObject({ ev: 'head_hold', id: 'head:wait_loop:3:abc', kind: 'wait_loop', file: path, rows: 20 });
    // The box holds the rows before its own line.
    expect(box.tail.some((row: { ev: string }) => row.ev === 'head_hold')).toBe(false);
  });

  it('keeps a run with fewer rows whole, never keeps a secret, and returns null for a recorder that cannot write', () => {
    const { root, recorder: made } = recorder();
    made.append(TASK, { ev: 'note', text: 'key sk-ant-abcdefghijklmnop' });
    const path = made.headHold(TASK, { id: 'head:death:de-1-2:x', kind: 'death', why: '死んだ' })!;
    const text = readFileSync(join(root, path), 'utf8');
    expect(text).not.toContain('sk-ant-abcdefghijklmnop');
    expect(JSON.parse(text).tail.map((row: { ev: string }) => row.ev)).toEqual(['run', 'note']);
    const blocked = mkdtempSync(join(tmpdir(), 'head-hold-file-'));
    roots.push(blocked);
    writeFileSync(join(blocked, 'x'), '');
    expect(new DecisionRecorder({ root: join(blocked, 'x'), log: () => undefined }).headHold(TASK, { id: 'head:death:1', kind: 'death', why: 'x' })).toBeNull();
  });

  it('tailRun reads from the end of the file: a window that starts in the middle of a line and a line cut at the end are left out', () => {
    const { root } = recorder();
    const dir = join(root, 'run-x');
    const rows = Array.from({ length: 50 }, (_, index) => JSON.stringify({ ev: 'r', n: index, pad: 'x'.repeat(40) }));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), `${rows.join('\n')}\n{"ev":"cut","n":`);
    expect(tailRun(dir, 5).map(row => row.n)).toEqual([45, 46, 47, 48, 49]);
    const small = tailRun(dir, 1_000, 600);
    expect(small.length).toBeGreaterThan(3);
    expect(small.length).toBeLessThan(50);
    expect(small.at(-1)!.n).toBe(49);
    expect(small.every(row => typeof row.n === 'number')).toBe(true);
    expect(tailRun(join(root, 'nothing'), 5)).toEqual([]);
    expect(tailRun(dir, 0)).toEqual([]);
  });
});

// ---- 3. the operator's side --------------------------------------------------------------------------------------------------------------------------
describe('the operator reads a hold the head found', () => {
  const OP_TASK = '11111111-2222-4333-8444-555555555555';
  const at = '2026-10-29T00:00:00.000Z';
  const view = (phase: TaskView['phase']) => ({ id: OP_TASK, phase, goal: 'エンドラを討伐して' } as unknown as TaskView);
  function service(bodyHold: { id: string; task: string; why: string } | null = null) {
    const auditDb = new DatabaseSync(':memory:'), audit = new OperatorAuditStore(auditDb);
    const tasks = new Map<string, TaskView>(), activity: OperatorActivity[] = [], released: string[] = [];
    const requests = { body: () => 'minecraft:world', open: () => [], get: (id: string) => tasks.get(id) ?? null,
      admit: () => { tasks.set(OP_TASK, view('ready')); return { ok: true as const, task: tasks.get(OP_TASK)!, bodyId: 'minecraft:world' }; },
      stop: async (id: string) => { tasks.set(id, view('stopped')); return [tasks.get(id)!]; },
      resume: (id: string) => { tasks.set(id, view('ready')); return tasks.get(id)!; }, position: () => [7.5, 100, 0.5] as [number, number, number],
      // A body that holds nothing answers `done` to a release naming a hold; one that holds another keeps it and says which.
      incident: async (op: string, incident: string) => {
        released.push(`${op}:${incident}`);
        if (bodyHold && incident !== bodyHold.id && !released.includes(`resume:${bodyHold.id}`)) return { ok: false, words: `completed done=false hold=${bodyHold.id}` };
        return { ok: true, words: 'completed done=true hold=- unfreeze=ok' };
      },
      bodyHold: () => bodyHold && !released.includes(`resume:${bodyHold.id}`) ? bodyHold : null, heldActWords: () => '保留した act', wake: () => undefined,
      resolveHolds: () => [] } as unknown as OperatorMinecraftRequests & { wake(): void };
    const parts: OperatorMinecraftParts = { scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => at, audit, lifecycle: null, requests,
      actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'], lifecycleUnresolved: () => false, activity: (_at, entry) => activity.push(entry), note: () => undefined };
    const envelope = (op: string, args: Record<string, unknown> = {}) => ({ v: 1, operator: 'ops.ryo', domain: 'minecraft', op, args });
    return { operator: createOperatorMinecraft(parts), audit, auditDb, requests: requests as unknown as Record<string, unknown>, tasks, activity, released, envelope };
  }
  const note: IncidentNote & { command: string } = { id: 'head:same_spot_stops:10_64_10:abc', heavy: true, why: 'go が同じ所 (10,64,10) の 3 マス以内で 2 回止まった', held: true, frozen: false,
    command: 'skill:c2', record: 'task-x/head-holds/head_same_spot_stops_10,64,10_abc.json', start: [10.5, 64, 10.5], end: [10.5, 64, 10.5] };
  async function held() {
    const s = service();
    await s.operator.handle(s.envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(OP_TASK, view('executing'));
    return s;
  }

  it('holds the request with the reason and the box in the audit line, and says in the activity that the head found it and the world was not stopped', async () => {
    const s = await held();
    expect(await s.operator.hold(OP_TASK, note)).toBe(true);
    const detail = JSON.parse(s.audit.heldOf(OP_TASK)!.detail!);
    expect(detail).toMatchObject({ incident: note.id, why: note.why, frozen: false, command: 'skill:c2', record: note.record });
    expect(s.audit.heldOf(OP_TASK)!.detail!.length).toBeLessThanOrEqual(600);
    const entry = s.activity.find(item => item.tool === 'operator.minecraft.hold')!;
    expect(entry.reasonCode).toBe('operator_hold_head');
    expect(entry.summary).toContain('頭が見つけた詰まり');
    expect(entry.summary).toContain('同じ所で止まり続ける');
    expect(entry.summary).toContain('世界は止めていない');
    expect(entry.detail).toContain(note.id);
    expect(entry.detail).toContain('2 回止まった');
  });

  it('a hold of the body\'s is written as before (the world stopped, the box and the scene)', async () => {
    const s = await held();
    await s.operator.hold(OP_TASK, { id: '20261029T000000-act-ab12', why: 'go_stuck', frozen: true, command: 'skill:c1' });
    const entry = s.activity.find(item => item.tool === 'operator.minecraft.hold')!;
    expect(entry.reasonCode).toBe('operator_hold');
    expect(entry.summary).toContain('世界を止め');
  });

  it('`held` says it is the head\'s alone, and a body hold beside it is a disagreement', async () => {
    const s = await held();
    await s.operator.hold(OP_TASK, note);
    const reply = await s.operator.handle(s.envelope('held'));
    expect((reply.body as { held: Array<{ body: string }> }).held[0]!.body).toContain('頭が見つけた詰まりの保留');
    expect((reply.body as { held: Array<{ body: string }> }).held[0]!.body).not.toContain('食い違い');
    const other = service({ id: 'body-1', task: OP_TASK, why: 'go_stuck' });
    await other.operator.handle(other.envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    other.tasks.set(OP_TASK, view('executing'));
    await other.operator.hold(OP_TASK, note);
    const both = await other.operator.handle(other.envelope('held'));
    expect((both.body as { held: Array<{ body: string }> }).held[0]!.body).toContain('食い違い');
  });

  it('resumes: a body that holds nothing answers done to the release naming it, and the task is queued again', async () => {
    const s = await held();
    await s.operator.hold(OP_TASK, note);
    const reply = await s.operator.handle(s.envelope('resume', { taskId: OP_TASK }));
    expect(reply.body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(s.released).toEqual([`resume:${note.id}`]);
  });

  it('resumes a hold the body took beside it by ending that one too, so that neither side goes on without the other', async () => {
    const s = service({ id: 'body-1', task: OP_TASK, why: 'death' });
    await s.operator.handle(s.envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(OP_TASK, view('executing'));
    await s.operator.hold(OP_TASK, note);
    const reply = await s.operator.handle(s.envelope('resume', { taskId: OP_TASK }));
    expect(reply.body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(s.released).toEqual([`resume:${note.id}`, 'resume:body-1']);
  });

  it('a hold of the body\'s own is still refused its resume when the body keeps it (nothing changed for the body\'s holds)', async () => {
    const s = service({ id: 'body-1', task: OP_TASK, why: 'go_stuck' });
    await s.operator.handle(s.envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(OP_TASK, view('executing'));
    await s.operator.hold(OP_TASK, { id: 'some-other', why: 'go_stuck', frozen: true, command: 'skill:c1' });
    const reply = await s.operator.handle(s.envelope('resume', { taskId: OP_TASK }));
    expect(reply.body).toMatchObject({ outcome: 'refused' });
    expect(s.released).toEqual(['resume:some-other']);
  });

  it('A-17 (run 46): a hold the unknown exit failed is reopened by the resume (the exit own failure only), then resumed as any hold; a failed task the exit did not fail stays refused', async () => {
    const s = await held();
    await s.operator.hold(OP_TASK, note);
    s.tasks.set(OP_TASK, view('failed'));
    // Another failure (the stub says the exit did not fail it): refused, nothing is sent to the body.
    s.requests.reopenRetired = () => null;
    const refused = await s.operator.handle(s.envelope('resume', { taskId: OP_TASK, skipReplay: true }));
    expect(refused.body).toMatchObject({ outcome: 'refused', code: 'not_running' });
    expect(s.released).toEqual([]);
    expect(s.audit.heldOf(OP_TASK)).not.toBeNull();
    // The exit failure: stopped again, resumed with --skip-replay by --latest.
    s.requests.reopenRetired = (id: string) => { s.tasks.set(id, view('stopped')); return s.tasks.get(id); };
    const reply = await s.operator.handle(s.envelope('resume', { latest: true, skipReplay: true }));
    expect(reply.body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(s.released).toEqual([`resume:${note.id}`]);
    expect(s.tasks.get(OP_TASK)?.phase).toBe('ready');
    const rows = s.auditDb.prepare("SELECT detail FROM operator_audit WHERE command='resume' AND event='accepted'").all() as Array<{ detail: string }>;
    expect(rows.map(row => row.detail).join('|')).toContain('reopened=retire_unknown');
    expect(s.audit.heldOf(OP_TASK)).toBeNull();
  });

  it('A-20 (run 47): a request a refused decision failed (the credit) is reopened by the resume that names it, and resumed as one the recovery paused; a failed task of another kind is refused', async () => {
    const s = service();
    await s.operator.handle(s.envelope('request', { goal: 'エンドラを討伐して' }));
    s.tasks.set(OP_TASK, view('failed'));
    s.requests.reopenRejected = () => null;
    const refused = await s.operator.handle(s.envelope('resume', { taskId: OP_TASK }));
    expect(refused.body).toMatchObject({ outcome: 'refused', code: 'not_held' });
    expect(s.released).toEqual([]);
    s.requests.reopenRejected = (id: string) => { s.tasks.set(id, view('stopped')); return s.tasks.get(id); };
    const reply = await s.operator.handle(s.envelope('resume', { taskId: OP_TASK }));
    expect(reply.body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(s.released).toEqual([`resume:recovered:${OP_TASK.slice(0, 12)}`]);
    const rows = s.auditDb.prepare("SELECT detail FROM operator_audit WHERE command='resume' AND event='accepted'").all() as Array<{ detail: string }>;
    expect(rows.map(row => row.detail).join('|')).toContain('reopened=rejected_step');
    // only by its id: --latest does not look for failed requests
    s.tasks.set(OP_TASK, view('failed'));
    s.requests.reopenRejected = () => { throw new Error('must not be asked'); };
    expect((await s.operator.handle(s.envelope('resume', { latest: true }))).body).toMatchObject({ outcome: 'refused' });
  });

  it('A-17: a held task still unknown (paused, unknown, fca_unknown) is not resumed: the runtime cannot queue an unknown step, so nothing is sent to the body until the recovery has paused it', async () => {
    const s = await held();
    await s.operator.hold(OP_TASK, note);
    s.tasks.set(OP_TASK, view('unknown'));
    const reply = await s.operator.handle(s.envelope('resume', { latest: true, skipReplay: true }));
    expect(reply.body).toMatchObject({ outcome: 'refused', code: 'not_running' });
    expect(s.released).toEqual([]);
    s.tasks.set(OP_TASK, view('stopped'));
    const again = await s.operator.handle(s.envelope('resume', { latest: true, skipReplay: true }));
    expect(again.body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
  });
});

// ---- 4. the real step parts ----------------------------------------------------------------------------------------------------------------------------
describe('the step parts hold a request that asked to be held, for what the head finds', () => {
  const benches: BenchC[] = [];
  afterEach(() => { for (const bench of benches.splice(0)) bench.close(); });
  const make = (scene: string) => { const bench = benchC({ scene, run: `stalls-${scene}` }); benches.push(bench); return bench; };
  /** The hold port as a test plays it: what it was asked for (the task, the incident), and the held time it reports. */
  function holdPort(over: Partial<IncidentHoldPort> & { requested?: boolean } = {}) {
    const calls: Array<IncidentNote & { command: string }> = [], checked: string[] = [];
    const time = { held: 0 };
    const port: IncidentHoldPort = { holdRequested: () => over.requested ?? true, hold: async (_task, incident) => { calls.push(incident); return true; }, notHeld: () => undefined,
      bodyHeld: async () => true, resumePending: over.resumePending ?? (() => null), resumeChecked: (_task, text) => { checked.push(text); }, heldMs: () => time.held };
    setIncidentHoldPort(port);
    return { calls, checked, time };
  }
  const waitHands = [{ do: 'wait' as const, seconds: 1 }];
  async function runAct(bench: BenchC, hands: Parameters<BenchC['add']>[0], finish: Parameters<BenchC['body']['finish']>[1], mark: string) {
    await bench.decide('次', () => bench.add(hands));
    expect(await until(() => bench.body.hasBeenHanded(mark))).toBe(true);
    const id = bench.body.idOf(mark);
    bench.body.begin(id);
    bench.body.finish(id, finish);
    await bench.settle(90);
  }

  it('wait_loop: the third wait act holds the request, with the head\'s box (its reason and the last rows of the record) named in the hold', async () => {
    const port = holdPort();
    const bench = make('wait-loop');
    await bench.begin();
    for (const mark of ['q1', 'q2', 'q3']) await runAct(bench, waitHands, { hands: [{ do: 'wait', goal: 'done', line: 'wait 1 秒' }] }, mark);
    expect(await until(() => port.calls.length > 0)).toBe(true);
    expect(port.calls).toHaveLength(1);
    const incident = port.calls[0]!;
    expect(incident).toMatchObject({ heavy: true, held: true, frozen: true, take: 'held', command: '' });
    expect(incident.id).toMatch(/^head:wait_loop:3:/u);
    expect(incident.why).toContain('wait だけの act が 3 回続いた');
    expect(incident.record).toMatch(/^stalls-wait-loop\/head-holds\/head_wait_loop_3_[0-9a-z]+\.json$/u);
    const box = JSON.parse(readFileSync(join(bench.records, incident.record!), 'utf8'));
    expect(box).toMatchObject({ kind: 'wait_loop', id: incident.id, taskId: bench.run });
    expect(box.tail.length).toBeGreaterThan(0);
    expect(box.tail.length).toBeLessThanOrEqual(HEAD_HOLD_ROWS);
    // The rows are the decision record's: the acts sent, the decisions.
    expect(box.tail.map((row: { ev: string }) => row.ev)).toEqual(expect.arrayContaining(['sent', 'request']));
    expect(bench.events().filter(row => row.ev === 'head_hold')).toMatchObject([{ id: incident.id, file: incident.record, kind: 'wait_loop' }]);
    // Held once: the head refuses a fourth act before it reaches the frozen body.
    const late = await bench.decide('次', () => bench.head.queue.add(bench.spec(waitHands)));
    expect(late).toMatchObject({ ok: false, text: expect.stringContaining('保留の作成・確定中') });
    expect(bench.body.handed.filter(command => command.kind === 'skill' && command.skill === 'act')).toHaveLength(3);
    await bench.settle(60);
    expect(port.calls).toHaveLength(1);
  }, 30_000);

  it('does nothing for a request that did not ask to be held (no stall, no box, no hold)', async () => {
    const port = holdPort({ requested: false });
    const bench = make('not-asked');
    await bench.begin();
    for (const mark of ['q1', 'q2', 'q3']) await runAct(bench, waitHands, { hands: [{ do: 'wait', goal: 'done', line: 'wait 1 秒' }] }, mark);
    await bench.settle(100);
    expect(port.calls).toHaveLength(0);
    expect(existsSync(join(bench.records, bench.run, 'head-holds'))).toBe(false);
    expect(bench.events().some(row => row.ev === 'head_hold')).toBe(false);
    // And no hold port at all (the switch off, a test) is the same.
    setIncidentHoldPort(null);
  }, 30_000);

  it('same_spot_stops: the second go that stopped there holds it, and names the stopped act to send again', async () => {
    const port = holdPort();
    const bench = make('same-spot');
    await bench.begin();
    const stop = (x: number) => ({ outcome: 'failed' as const, hands: [{ do: 'go', status: 'stopped' as const, goal: 'partial' as const, end: 'cut' as const, code: 'go_stuck', cutBy: 'noProgress', line: 'go 止まった go_stuck',
      progress: { unit: 'meter', done: 4, left: 20, at: { x, y: 64, z: 10 } } }], stoppedBy: 'noProgress' });
    await runAct(bench, [{ do: 'go', to: { x: 50, y: 64, z: 10 } }], stop(10), 'q1');
    expect(port.calls).toHaveLength(0);
    await runAct(bench, [{ do: 'go', to: { x: 50, y: 64, z: 10 } }], stop(12), 'q2');
    expect(await until(() => port.calls.length > 0)).toBe(true);
    const incident = port.calls[0]!;
    expect(incident.id).toMatch(/^head:same_spot_stops:10_64_10:/u);
    expect(incident.command).toBe(bench.body.idOf('q2'));
    expect(incident.start).toEqual([0.5, 64, 0.5]);
    expect(incident.why).toContain('go_stuck');
  }, 30_000);

  it('a stall the body already holds for (the same result carries its held incident) is left to the body; one it chose not to hold is not held either', async () => {
    const port = holdPort();
    const bench = make('left-to-body');
    await bench.begin();
    const heldBy = { incident: { id: 'body-box-1', heavy: true, why: 'go_stuck', held: true, frozen: true, start: [0.5, 64, 0.5], end: [10, 64, 10] } };
    const stop = { outcome: 'failed' as const, hands: [{ do: 'go', status: 'stopped' as const, goal: 'partial' as const, end: 'cut' as const, code: 'go_stuck', line: 'go 止まった go_stuck',
      progress: { unit: 'meter', done: 4, left: 20, at: { x: 10, y: 64, z: 10 } } }], result: heldBy };
    await runAct(bench, [{ do: 'go', to: { x: 50, y: 64, z: 10 } }], stop, 'q1');
    await runAct(bench, [{ do: 'go', to: { x: 50, y: 64, z: 10 } }], stop, 'q2');
    // The body's own path holds (its receipt says so): the head's stall is not a second hold.
    expect(port.calls.map(call => call.id)).toEqual(['body-box-1', 'body-box-1']);
    expect(bench.events().some(row => row.ev === 'head_hold')).toBe(false);
    expect(bench.head.lines.some(text => text.includes('head stall left to the body'))).toBe(true);
  }, 30_000);

  it('node_stalled: found at a look 120 s of running time later, not counting the time it was held; the decision waits only for the hold to be made', async () => {
    const port = holdPort();
    const bench = make('node-stalled');
    await bench.begin();
    await bench.planUpdate('計画', { ops: [{ op: 'add', title: '鉄を掘る', doneWhen: 'have:iron_ingot>=3' }] });
    const node = bench.plan.tree().current!;
    expect(node).toBeTruthy();
    const body = bench.lifecycle();
    const controller = new AbortController();
    // The clock of the running time is the wall clock less the held time; the test moves it by what the port reports (a wall clock that went on `wall` seconds, `held` of them held).
    const clock = (wall: number, held: number) => { port.time.held = (held - wall) * 1_000; };
    clock(0, 0);
    expect(await body.beforeDecision!(controller.signal)).toBeUndefined();
    expect(port.calls).toHaveLength(0);
    clock(100, 0);
    await body.beforeDecision!(controller.signal);
    expect(port.calls).toHaveLength(0);
    // 700 s of wall clock, 600 s of them held: 100 s of running, the clock stood still while it was held.
    clock(700, 600);
    await body.beforeDecision!(controller.signal);
    expect(port.calls).toHaveLength(0);
    clock(740, 600);
    // Not aborted: the decision's start waits for the body to be asked and the hold to be asked for (at once with the stand-in body), not for the stop.
    const began = Date.now();
    await body.beforeDecision!(controller.signal);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({ heavy: true, held: true, frozen: true, take: 'held' });
    expect(bench.body.takes).toHaveLength(1);
    expect(port.calls[0]!.id.startsWith(`head:node_stalled:${node}:`)).toBe(true);
    expect(port.calls[0]!.why).toContain(node);
    expect(port.calls[0]!.why).toContain('秒、進みが無い');
    expect(JSON.parse(readFileSync(join(bench.records, port.calls[0]!.record!), 'utf8')).detail).toMatchObject({ current: node });
  }, 30_000);

  it('node_stalled: a node that moves on (its state) in between starts the clock again', async () => {
    const port = holdPort();
    const bench = make('node-moves');
    await bench.begin();
    await bench.planUpdate('計画', { ops: [{ op: 'add', title: '鉄を掘る', doneWhen: 'have:iron_ingot>=3' }] });
    const node = bench.plan.tree().current!;
    expect(node).toBeTruthy();
    const body = bench.lifecycle();
    const controller = new AbortController();
    const clock = (wall: number) => { port.time.held = -wall * 1_000; };
    clock(0);
    await body.beforeDecision!(controller.signal);
    clock(100);
    await body.beforeDecision!(controller.signal);
    await bench.planUpdate('進んだ', { ops: [{ op: 'set', id: node, note: 'x', state: 'blocked', reason: 'y' }] });
    clock(110);
    await body.beforeDecision!(controller.signal);
    clock(200);
    await body.beforeDecision!(controller.signal);
    expect(port.calls).toHaveLength(0);
    clock(232);
    controller.abort();
    await body.beforeDecision!(controller.signal);
    expect(await until(() => port.calls.length > 0)).toBe(true);
    expect(port.calls[0]!.id).toMatch(/^head:node_stalled:/u);
  }, 30_000);

  it('death: a rise of the death counter at the decision\'s start holds it (once), and a request that did not ask is not held', async () => {
    const port = holdPort();
    const bench = make('death');
    await bench.begin();
    const body = bench.lifecycle();
    const controller = new AbortController();
    controller.abort();
    await body.beforeDecision!(controller.signal);
    expect(port.calls).toHaveLength(0);
    const observation = bench.body.observation.bind(bench.body);
    let seq = 0;
    bench.body.observation = () => { const seen = observation(); (seen.state as { life: { deathSeq: number } }).life.deathSeq = seq; return seen; };
    bench.body.poll();
    await bench.settle(30);
    await body.beforeDecision!(controller.signal);
    expect(port.calls).toHaveLength(0);
    seq = 1;
    bench.body.poll();
    await bench.settle(30);
    await body.beforeDecision!(controller.signal);
    expect(await until(() => port.calls.length > 0)).toBe(true);
    expect(port.calls[0]).toMatchObject({ heavy: true, held: true, frozen: true, take: 'held', command: '' });
    expect(port.calls[0]!.id).toMatch(/^head:death:de-bench-1:/u);
    await body.beforeDecision!(controller.signal);
    expect(port.calls).toHaveLength(1);
  }, 30_000);

  it('death: nothing is found when the request did not ask to be held', async () => {
    const port = holdPort({ requested: false });
    const bench = make('death-not-asked');
    await bench.begin();
    const body = bench.lifecycle();
    const controller = new AbortController();
    controller.abort();
    const observation = bench.body.observation.bind(bench.body);
    let seq = 0;
    bench.body.observation = () => { const seen = observation(); (seen.state as { life: { deathSeq: number } }).life.deathSeq = seq; return seen; };
    bench.body.poll();
    await bench.settle(30);
    await body.beforeDecision?.(controller.signal);
    seq = 3;
    bench.body.poll();
    await bench.settle(30);
    await body.beforeDecision?.(controller.signal);
    await bench.settle(50);
    expect(port.calls).toHaveLength(0);
  }, 30_000);

  it('decide_error: the decision again that failed (its record row) and two refusals before sending hold the request; an accepted act ends the run of refusals', async () => {
    const port = holdPort();
    const bench = make('decide-error');
    await bench.begin();
    const body = bench.lifecycle();
    const call = { id: 'c1', name: 'mc.act', input: {}, operationId: 'op-1', signal: new AbortController().signal } as never;
    body.noteResult!(call, toolFailure('invalid_input', '範囲の外', { retryable: false }));
    body.noteResult!(call, toolOk('列に入れた q1'));
    body.noteResult!(call, toolFailure('invalid_input', '手の形が違う', { retryable: false }));
    expect(port.calls).toHaveLength(0);
    body.noteResult!(call, toolFailure('invalid_input', '必須が無い', { retryable: false }));
    expect(await until(() => port.calls.length > 0)).toBe(true);
    expect(port.calls[0]!.id).toMatch(/^head:decide_error:check_refused:/u);
    expect(port.calls[0]!.why).toContain('2 回');
    // Another kind of failure of the call (the body away, a timeout) is neither a refusal nor an acceptance.
    forgetStalls();
    resumeStalls(bench.run);
    body.noteResult!(call, toolFailure('invalid_input', 'a', { retryable: false }));
    body.noteResult!(call, toolFailure('unavailable', 'b'));
    body.noteResult!(call, toolFailure('timeout', 'c'));
    expect(port.calls).toHaveLength(1);
  }, 30_000);

  it('A-18 (runs 46): the answers of the queue and the world (the same wait beside its twin, the urgent limit, a full queue, a stopped body, a precondition) are not counted; two of a wrong form or value still hold', async () => {
    const port = holdPort();
    const bench = make('decide-error-answers');
    await bench.begin();
    const body = bench.lifecycle();
    const call = { id: 'c1', name: 'mc.act', input: {}, operationId: 'op-1', signal: new AbortController().signal } as never;
    const answers = [
      toolFailure('refused', `送らなかった: q31 ${SAME_IN_QUEUE_WORDS}（待ち）。列は live の queue`, { retryable: true }),
      toolFailure('refused', '手 1 wait: 急ぎの判断は 3 手まで（system の「急ぎの時」）。4 手目から先は送っていない。続きは次の判断で出せる', { retryable: true }),
      toolFailure('refused', '送らなかった: 列がいっぱい（実行中を含めて 3 つ）', { retryable: true }),
      toolFailure('refused', '送らなかった: q2 の結果が不明で、体を止めたことをまだ確かめていない', { retryable: true }),
      toolFailure('refused', '送らなかった: 前提 hp>10 を今は満たさない。体には何も送っていない', { retryable: true }),
    ];
    for (let round = 0; round < 3; round++) for (const answer of answers) body.noteResult!(call, answer);
    await bench.settle(50);
    expect(port.calls).toHaveLength(0);
    // The run of wrong forms is ended by such an answer: a wrong form, an answer, a wrong form do not make two in a row.
    body.noteResult!(call, toolFailure('invalid_input', '手の形が違う', { retryable: false }));
    body.noteResult!(call, answers[1]!);
    body.noteResult!(call, toolFailure('invalid_input', '手の形が違う', { retryable: false }));
    await bench.settle(50);
    expect(port.calls).toHaveLength(0);
    // Two in a row of a wrong form (or value) still hold the request.
    body.noteResult!(call, toolFailure('invalid_input', '範囲の外', { retryable: false }));
    expect(await until(() => port.calls.length > 0)).toBe(true);
    expect(port.calls[0]!.id).toMatch(/^head:decide_error:check_refused:/u);
    expect(port.calls[0]!.why).toContain('2 回');
  }, 30_000);

  it('A-20 (run 47): a decision refused for the credit holds the request (the body asked to hold, the audit hold) with the reason billing, and the error goes on to the runner; any other error does not', async () => {
    const port = holdPort();
    let refuse = 'FCA_MODEL_BILLING';
    const bench = benchC({ scene: 'billing', run: 'stalls-billing', model: { name: 'main', model: { decide: async () => { throw new Error(refuse); }, toolResults: () => '' } } });
    benches.push(bench);
    await bench.begin();
    await expect(bench.model.decide({} as never, new AbortController().signal)).rejects.toThrow('FCA_MODEL_BILLING');
    expect(await until(() => port.calls.length > 0)).toBe(true);
    expect(port.calls[0]!.id).toMatch(/^head:decide_error:billing:/u);
    expect(port.calls[0]!.why).toContain('billing');
    expect(port.calls[0]).toMatchObject({ heavy: true, held: true });
    // another error of the model holds nothing
    forgetStalls();
    port.calls.length = 0;
    refuse = 'FCA_MODEL_HTTP_400';
    await expect(bench.model.decide({} as never, new AbortController().signal)).rejects.toThrow('FCA_MODEL_HTTP_400');
    await bench.settle(60);
    expect(port.calls).toHaveLength(0);
  }, 30_000);

  it('decide_error: a decision again that failed or ran out of time, told by the record\'s row, holds the request', async () => {
    const port = holdPort();
    const bench = make('decide-redecide');
    await bench.begin();
    await bench.decide('決め直し', () => noteRedecideRow({ asked: true, count: 1, outcome: 'kept_first', why: 'failed', failed: 'aborted: timeout 60000' }));
    expect(await until(() => port.calls.length > 0)).toBe(true);
    expect(port.calls[0]!.id).toMatch(/^head:decide_error:redecide_failed:/u);
    expect(port.calls[0]!.why).toContain('timeout');
    // The box holds the `redecide` row among the last rows.
    const box = JSON.parse(readFileSync(join(bench.records, port.calls[0]!.record!), 'utf8'));
    expect(box.tail.some((row: { ev: string; why?: string }) => row.ev === 'redecide' && row.why === 'failed')).toBe(true);
  }, 30_000);

  it('a task resumed from a hold counts again from nothing, and the resume says there was no act to send again', async () => {
    const port = holdPort({ resumePending: () => ({ incident: 'head:wait_loop:3:abc', command: '' }) });
    const bench = make('resumed');
    // A stall found before (the task is quiet) is forgotten when the step begins with a resume pending.
    for (let count = 0; count < 3; count += 1) noteRan(bench.run, { hands: [{ do: 'wait' }], result: result([waitLine()]) });
    expect(stallQuiet(bench.run)).toBe(true);
    await bench.begin();
    expect(stallQuiet(bench.run)).toBe(false);
    const lifecycle = bench.lifecycle();
    lifecycle.start(new AbortController().signal);
    expect(await until(() => port.checked.length > 0)).toBe(true);
    expect(port.checked[0]).toContain('頭が見つけた詰まり（wait_loop）');
    expect(port.checked[0]).toContain('出し直す act が無い');
  }, 30_000);
});
