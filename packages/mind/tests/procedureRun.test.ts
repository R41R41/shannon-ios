import { describe, expect, it } from 'vitest';
import { procedureRunLines, runProcedures, type Procedure, type ProcedureRunPorts } from '../src/procedureRun.js';

/** mb-arch: a procedure run through by the executor until it is done or the planner must decide. */
interface World { logs: number; planks: number; night: boolean; upkeepDue: boolean }
const gather: Procedure<World, string> = {
  id: '木', done: world => world.logs >= 3,
  next: () => ({ kind: 'do', item: 'mine', key: 'mine-log', why: '原木を掘る' }),
};
const craft: Procedure<World, string> = {
  id: '板', done: world => world.planks >= 4,
  next: world => world.logs > 0 ? { kind: 'do', item: 'craft', key: 'craft-planks', why: '板にする' } : { kind: 'stuck', why: '原木が無い' },
};

function ports(world: World, options: { fail?: string; stopAt?: number } = {}): ProcedureRunPorts<World, string> & { ran: string[] } {
  let clock = 0;
  const ran: string[] = [];
  return {
    ran, now: () => clock, signal: new AbortController().signal, facts: () => ({ ...world }),
    stopWhy: () => options.stopAt !== undefined && ran.length >= options.stopAt ? '夜になった' : null,
    upkeep: facts => facts.upkeepDue ? { kind: 'do', item: 'eat', key: 'eat', why: '食べる' } : null,
    final: failure => failure === 'night_unprepared',
    async run(item) {
      ran.push(item);
      clock += 1_000;
      if (item === options.fail) return { ok: false, text: '', failure: item === 'craft' ? 'night_unprepared' : 'target_not_found' };
      if (item === 'mine') world.logs += 1;
      if (item === 'craft') { world.logs -= 1; world.planks += 4; }
      if (item === 'eat') world.upkeepDue = false;
      return { ok: true, text: 'ok' };
    },
  };
}

describe('procedure run (mb-arch)', () => {
  it('runs each procedure until it is done, upkeep first, and says what it passed', async () => {
    const world = { logs: 0, planks: 0, night: false, upkeepDue: true };
    const p = ports(world);
    const result = await runProcedures([gather, craft], p);
    expect(p.ran).toEqual(['eat', 'mine', 'mine', 'mine', 'craft']);
    expect(result).toMatchObject({ outcome: 'done', at: null, passed: ['木', '板'], elapsedMs: 5_000 });
    expect(procedureRunLines(result)[0]).toBe('最後まで着いた: すべて着いた（5手・5秒）');
  });

  it('hands the turn back for a reason from outside, for nothing to do, and for the same work failing twice', async () => {
    const stopped = await runProcedures([gather], ports({ logs: 0, planks: 0, night: false, upkeepDue: false }, { stopAt: 1 }));
    expect(stopped).toMatchObject({ outcome: 'stopped', at: '木', why: '夜になった', passed: [] });
    const stuck = await runProcedures([craft], ports({ logs: 0, planks: 0, night: false, upkeepDue: false }));
    expect(stuck).toMatchObject({ outcome: 'stuck', why: '原木が無い' });
    const failing = ports({ logs: 0, planks: 0, night: false, upkeepDue: false }, { fail: 'mine' });
    const failed = await runProcedures([gather], failing);
    expect(failing.ran).toEqual(['mine', 'mine']);
    expect(failed).toMatchObject({ outcome: 'failed', why: '原木を掘るが2回できなかった（target_not_found）' });
  });

  it('ends at once on a final failure, and does not go round on work that never moves the procedure on', async () => {
    const night = await runProcedures([craft], ports({ logs: 1, planks: 0, night: false, upkeepDue: false }, { fail: 'craft' }));
    expect(night).toMatchObject({ outcome: 'failed', why: '板にするができなかった（night_unprepared）' });
    const round: Procedure<World, string> = { id: '回る', done: () => false, next: () => ({ kind: 'do', item: 'noop', key: 'noop', why: '同じ手' }) };
    const result = await runProcedures([round], ports({ logs: 0, planks: 0, night: false, upkeepDue: false }));
    expect(result).toMatchObject({ outcome: 'stuck', why: '同じ手を6回しても先へ進まない' });
    expect(result.items).toHaveLength(6);
  });

  it('keeps to its bounds and to a stop', async () => {
    const round: Procedure<World, string> = { id: '回る', done: () => false, next: (_, memory) => ({ kind: 'do', item: 'noop',
      key: `noop${memory.succeeded('x')}${Math.random()}`, why: '同じ手' }) };
    const limited = await runProcedures([round], ports({ logs: 0, planks: 0, night: false, upkeepDue: false }),
      { items: 3, ms: 60_000, failuresPerKey: 2, failures: 6, repeatsPerKey: 6 });
    expect(limited).toMatchObject({ outcome: 'limit', why: '一度に流す上限（3手・60秒）' });
    const stop = new AbortController();
    stop.abort();
    const cancelled = await runProcedures([gather], { ...ports({ logs: 0, planks: 0, night: false, upkeepDue: false }), signal: stop.signal });
    expect(cancelled.outcome).toBe('cancelled');
  });
});
