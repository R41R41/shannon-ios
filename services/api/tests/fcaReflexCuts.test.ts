import { describe, expect, it } from 'vitest';
import { NO_REFLEX_CUTS, REPEATED_REFLEX_INTERRUPTION, reflexCutCheckpoint, reflexCutRunOf, repeatedFailureReason, settleReflexStep, type ReflexCutRun, type StepCall } from '../src/mind/action/fca/fcaReflexCuts.js';

const cut = (name = 'mc.mine-block'): StepCall => ({ name, ok: false, read: false, cut: true });
const observe: StepCall = { name: 'minecraft.observe', ok: true, read: true, cut: false };
const write = (ok: boolean, name = 'mc.move-to'): StepCall => ({ name, ok, read: false, cut: false });

describe('settleReflexStep (P8 review M2)', () => {
  it('counts a cut call whatever read worked beside it, and does not let the read clear the count', () => {
    let run: ReflexCutRun = NO_REFLEX_CUTS, failures = 0;
    for (let step = 0; step < 6; step++) ({ failures, run } = settleReflexStep(failures, run, [observe, cut()]));
    expect(run).toEqual({ total: 6, tool: 'mc.mine-block', toolRun: 6 }); expect(failures).toBe(4);
  });
  it('leaves a run alone for a step that only reads, and a step with no outcome at all', () => {
    const run: ReflexCutRun = { total: 4, tool: 'mc.mine-block', toolRun: 4 };
    expect(settleReflexStep(2, run, [observe])).toEqual({ failures: 2, run, byCuts: false });
    expect(settleReflexStep(2, run, [])).toEqual({ failures: 2, run, byCuts: false });
    // With no run going a read that worked is a success, as it always was.
    expect(settleReflexStep(3, NO_REFLEX_CUTS, [observe])).toEqual({ failures: 0, run: NO_REFLEX_CUTS, byCuts: false });
  });
  it('ends the run for an outcome of its own: a write that worked, any failure (a failed read too), and keeps counting the failures', () => {
    const run: ReflexCutRun = { total: 2, tool: 'mc.mine-block', toolRun: 2 };
    expect(settleReflexStep(1, run, [write(true)])).toEqual({ failures: 0, run: NO_REFLEX_CUTS, byCuts: false });
    expect(settleReflexStep(1, run, [write(false)])).toEqual({ failures: 2, run: NO_REFLEX_CUTS, byCuts: false });
    expect(settleReflexStep(1, run, [{ ...observe, ok: false }])).toEqual({ failures: 2, run: NO_REFLEX_CUTS, byCuts: false });
    // A cut beside a write that worked: the write is the outcome, the cut is not counted.
    expect(settleReflexStep(1, run, [cut(), write(true)])).toEqual({ failures: 0, run: NO_REFLEX_CUTS, byCuts: false });
  });
  it('counts a step of several cut tools as no single tool, and the total still runs', () => {
    const first = settleReflexStep(0, NO_REFLEX_CUTS, [cut('mc.mine-block'), cut('mc.move-to')]);
    expect(first.run).toEqual({ total: 1, tool: '', toolRun: 1 });
  });
  it('names the stop after the cuts only when the cuts are what pushed the count over the limit (P8 third review)', () => {
    expect(repeatedFailureReason(true)).toBe(REPEATED_REFLEX_INTERRUPTION);
    expect(repeatedFailureReason(false)).toBe('repeated_tool_failure');
  });
  it('byCuts is true for the step that counted a cut as a failure, and false for a failure of its own or a cut not yet counted', () => {
    // Cuts: the first two are free, the third of the same tool is a failure.
    let failures = 0, run: ReflexCutRun = NO_REFLEX_CUTS;
    const bys: boolean[] = [];
    for (let step = 0; step < 4; step++) { const next = settleReflexStep(failures, run, [cut()]); ({ failures, run } = next); bys.push(next.byCuts); }
    expect(bys).toEqual([false, false, true, true]); expect(failures).toBe(2);
    // An ordinary failure on top of a running run of cuts: its own, not the cuts'.
    const own = settleReflexStep(4, { total: 5, tool: 'mc.mine-block', toolRun: 5 }, [write(false)]);
    expect(own).toMatchObject({ failures: 5, byCuts: false });
    // A cut that is counted pushes it over.
    const pushed = settleReflexStep(4, { total: 5, tool: 'mc.mine-block', toolRun: 5 }, [cut()]);
    expect(pushed).toMatchObject({ failures: 5, byCuts: true });
  });
  it('the reason follows who pushed it over: seven cuts in a row is the reflex-interruption reason; six cuts then an ordinary failure is a tool failure', () => {
    const reasonAfter = (steps: StepCall[][]) => {
      let failures = 0, run: ReflexCutRun = NO_REFLEX_CUTS, last = false;
      for (const calls of steps) ({ failures, run, byCuts: last } = settleReflexStep(failures, run, calls));
      return { failures, reason: repeatedFailureReason(last) };
    };
    // Cuts of the same tool: the 3rd, 4th, 5th, 6th ... are failures.
    const cuts = (n: number) => Array.from({ length: n }, () => [cut()]);
    expect(reasonAfter([...cuts(7)])).toEqual({ failures: 5, reason: REPEATED_REFLEX_INTERRUPTION });
    expect(reasonAfter([...cuts(6), [write(false)]])).toEqual({ failures: 5, reason: 'repeated_tool_failure' });
    // Real failures pushed over by one counted cut (the run was already at its limit).
    expect(reasonAfter([...cuts(6), [write(false)], [write(false)]]).reason).toBe('repeated_tool_failure');
  });
  it('reads the run from a checkpoint, and an old or damaged one is no run', () => {
    expect(reflexCutRunOf({ consecutiveToolFailures: 2 })).toEqual(NO_REFLEX_CUTS);
    expect(reflexCutRunOf({ consecutiveReflexCuts: 'many', reflexCutTool: 7, reflexCutToolRun: -1 })).toEqual(NO_REFLEX_CUTS);
    expect(reflexCutRunOf({ consecutiveReflexCuts: 3, reflexCutTool: 'a' })).toEqual({ total: 3, tool: 'a', toolRun: 0 });
    // Nothing is written for no run; an explicit zero only when a stored run has to be cleared.
    expect(reflexCutCheckpoint(NO_REFLEX_CUTS, {})).toEqual({});
    expect(reflexCutCheckpoint(NO_REFLEX_CUTS, { consecutiveReflexCuts: 2 })).toEqual({ consecutiveReflexCuts: 0, reflexCutTool: '', reflexCutToolRun: 0 });
  });
});
