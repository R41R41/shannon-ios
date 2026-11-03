import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { ActHandLine } from '../src/contracts/minecraftActContract.js';
import { repeatedTypedFailure, typedFailureAttemptsOf, typedFailureLines } from '../src/surfaces/minecraft/minecraftLlmcTypedFailure.js';

/** The two stops of a go that kept the run59 holds 6, 7 and 8 open (the model sent the same go again, 8 of 8): said as typed failures. */
const AT = Date.parse('2026-11-03T00:00:00Z');
const frame = (x: number, z: number, at = AT): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: new Date(at).toISOString(),
  receivedAt: new Date(at + 5).toISOString(), connected: true, facts: {},
  state: { world: { dimension: 'the_nether', position: { x, y: 71, z }, health: 20, food: 20, inventory: [] } as never } });
const line = (code: string): ActHandLine => ({ i: 1, do: 'go', status: 'stopped', goal: 'partial', end: 'finished', code, line: `go 止まった ${code}` });
const result = (code: string) => JSON.stringify({ v: 1, ok: false, done: 0, of: 1, lines: [line(code)], at: { x: 0, y: 71, z: 0 }, hp: 20, food: 20, ms: 100 });
const sent = (x: number, z: number) => ({ hands: [{ do: 'go', to: { x, y: 71, z } }] });

describe('search_timeout and go_stuck of a go', () => {
  it('a search that timed out over a long way offers one point on the straight line, 80 m from her feet, as unverified', () => {
    const [attempt] = typedFailureAttemptsOf(result('search_timeout'), frame(0, 0), sent(120, 0));
    expect(attempt!.failure.code).toBe('search_timeout');
    expect(attempt!.failure.candidateArgs).toHaveLength(1);
    expect(attempt!.failure.candidateArgs[0]).toMatchObject({ hand: { do: 'go', to: { x: 80, y: 71, z: 0 } }, verified: false });
    const lines = typedFailureLines(attempt!, frame(0, 0, AT + 2000)).join('\n');
    expect(lines).toContain('候補:');
    expect(lines).toContain('未確認');
  });
  it('offers nothing when the way is short, and stops offering when thirty seconds have passed', () => {
    expect(typedFailureAttemptsOf(result('search_timeout'), frame(0, 0), sent(60, 0))[0]!.failure.candidateArgs).toEqual([]);
    const [attempt] = typedFailureAttemptsOf(result('search_timeout'), frame(0, 0), sent(120, 0));
    expect(typedFailureLines(attempt!, frame(0, 0, AT + 31_000)).join('\n')).not.toContain('候補:');
  });
  it('the same go stopped the same way again says the candidate was tried (go_stuck)', () => {
    const first = typedFailureAttemptsOf(result('go_stuck'), frame(25, 4), sent(76, 21))[0]!;
    const second = typedFailureAttemptsOf(result('go_stuck'), frame(25, 4, AT + 20_000), sent(76, 21))[0]!;
    expect(first.failure.code).toBe('go_stuck');
    expect(repeatedTypedFailure(second, [first])).toBe(true);
    expect(typedFailureLines(second, frame(25, 4, AT + 21_000), [first]).join('\n')).toContain('同じ候補はもう試した');
    const other = typedFailureAttemptsOf(result('go_stuck'), frame(25, 4, AT + 40_000), sent(90, 30))[0]!;
    expect(repeatedTypedFailure(other, [second])).toBe(false);
  });
});
