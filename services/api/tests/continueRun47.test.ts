import { afterEach, describe, expect, it } from 'vitest';
import type { MinecraftControlCommand } from '../src/contracts/minecraftControlContract.js';
import { createLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { stopFactsOf } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { forgetStalls, noteRan, resumeStalls, sameSpotStops } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { operatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';

/**
 * Run 47, hold 3 (a go stuck at (156,67,200) behind a board at head height; the resume with --skip-replay; the first decision after it sent the same go again, and was stuck a third
 * time in the same place). Its input had the held act as 「stuck（今 (156,67,200)）」 only (the body's own sentence with the fix and the hint was not in it), and two lines
 * 「行き先まで 1.4 m（道探しの先端からは 0 m）」, which read as nearly there.
 */
afterEach(() => forgetStalls());

const BODY_SENTENCE = 'go 止まった stuck（今 (156,67,200)）。3 秒位置が変わらず、直しを 5 回しても進まない。view で周りを見て、別の手を（頭の高さの板があれば dig で外す）';
const stuckGo = (at = { x: 156, y: 67, z: 200 }) => JSON.stringify({ v: 1, ok: false, done: 0, of: 1, at, hp: 20, food: 20, ms: 9_000,
  lines: [{ i: 1, do: 'go', status: 'stopped', line: BODY_SENTENCE, goal: 'partial', end: 'finished', code: 'stuck', motorOps: 3,
    progress: { unit: 'meter', done: 5, left: 1.4, at, fromStopM: 1.4, searchEndM: 0 } }] });

describe('a stuck go is said as what it is, and the same place is counted', () => {
  it('the facts line of a stuck go says the way is found and the body cannot move on it, with the nth time at the place; no distance that reads as nearly there', () => {
    expect(stopFactsOf(stuckGo(), () => 2)).toEqual(['go の止まり: 止まった位置 (156,67,200) で、道は見つかるが体が進めない（同じ所で 2 回目）']);
    // a result read without the stall watch's count (after a restart) says no number rather than a wrong one
    expect(stopFactsOf(stuckGo())).toEqual(['go の止まり: 止まった位置 (156,67,200) で、道は見つかるが体が進めない']);
    expect(stopFactsOf(stuckGo(), () => 2)[0]).not.toContain('行き先まで');
    // another stop keeps the distance (a search that timed out: the tip of the search is information)
    const timeout = JSON.parse(stuckGo()) as { lines: Array<{ code: string }> };
    timeout.lines[0]!.code = 'search_timeout';
    expect(stopFactsOf(JSON.stringify(timeout))).toEqual(['go の止まり: 止まった位置 (156,67,200) から行き先まで 1.4 m（道探しの先端からは 0 m）']);
  });

  it('the count is the stall watch\'s: two stops in the same place make 2 when the next decision reads the line, once, however many results said it', () => {
    const task = 'run47-task';
    const events = createLlmcEvents(task);
    for (const [index, at] of [{ x: 156, y: 67, z: 200 }, { x: 156, y: 67, z: 201 }].entries()) {
      const result = stuckGo(at);
      // the order of the listeners is the queue's: the line is noted before or after the watch counted it; it is read at the decision
      events.noteStops(result);
      noteRan(task, { hands: [{ do: 'go' }], result });
      expect(sameSpotStops(task, at)).toBe(index + 1);
    }
    events.take();
    expect(events.stops()).toEqual(['go の止まり: 止まった位置 (156,67,200) で、道は見つかるが体が進めない（同じ所で 2 回目）', 'go の止まり: 止まった位置 (156,67,201) で、道は見つかるが体が進めない（同じ所で 2 回目）']);
    expect(sameSpotStops(task, { x: 170, y: 67, z: 200 })).toBe(0);
  });
});

describe('the count survives the hold and the resume (run 47: the third stop in the place was the third, not the first again)', () => {
  it('two stops make the hold; after the resume the next stop in the same place is the third; a hand that got somewhere starts it again', () => {
    const task = 'run47-resume';
    const at = { x: 156, y: 67, z: 200 };
    expect(noteRan(task, { hands: [{ do: 'go' }], result: stuckGo(at) })).toBeNull();
    expect(noteRan(task, { hands: [{ do: 'go' }], result: stuckGo(at) })).toMatchObject({ kind: 'same_spot_stops' });
    expect(sameSpotStops(task, at)).toBe(2);
    resumeStalls(task);
    expect(sameSpotStops(task, at)).toBe(2);
    expect(noteRan(task, { hands: [{ do: 'go' }], result: stuckGo(at) })).toBeNull();
    expect(sameSpotStops(task, at)).toBe(3);
    const done = JSON.stringify({ v: 1, ok: true, done: 1, of: 1, at, hp: 20, food: 20, ms: 4_000, lines: [{ i: 1, do: 'go', status: 'done', line: 'go 着いた', goal: 'done', end: 'finished', motorOps: 2 }] });
    noteRan(task, { hands: [{ do: 'go' }], result: done });
    expect(sameSpotStops(task, at)).toBe(0);
  });
});

describe('the held act a resume with --skip-replay does not send again is told with the body\'s own sentence', () => {
  const COMMAND = 'skill:c17';
  const command = { id: COMMAND, kind: 'skill', skill: 'act', queue: { item: 'q17' }, arguments: { hands: [{ do: 'go', to: { x: 155, y: 66, z: 200 } }] } } as unknown as MinecraftControlCommand;
  const requests = operatorMinecraftRequests({ control: { store: { command: (id: string) => id === COMMAND ? command : null, receipt: (id: string) => id === COMMAND ? { result: stuckGo() } : null } } as never,
    runtime: {} as never, ownerScope: 'owner', stop: async () => [], atomic: work => work(), bound: () => [], spec: () => ({}) as never });

  it('names the act and its hand, and gives the hand line to the end (the fix and the hint), not the code alone', () => {
    const words = requests.heldActWords(COMMAND, 'go_stuck');
    expect(words).toContain('保留した act q17（go (155,66,200)）は出し直さなかった。前の結果: go 止まった stuck（今 (156,67,200)）');
    expect(words).toContain('直しを 5 回しても進まない');
    expect(words).toContain('view で周りを見て、別の手を（頭の高さの板があれば dig で外す）');
  });

  it('run 47 resume 3: the stop fact of a stuck go is made from the receipt of the act held before a restart, with the reason of the hold that carries the count', () => {
    const words = requests.heldActWords(COMMAND, 'go が同じ所 (156,67,200) の 3 マス以内で 2 回、done にならず止まった（partial・stuck）');
    expect(words).toContain('go の止まり: 止まった位置 (156,67,200) で、道は見つかるが体が進めない');
    expect(words).toContain('保留の理由: go が同じ所 (156,67,200) の 3 マス以内で 2 回');
    expect(words).not.toContain('行き先まで');
  });

  it('without a receipt it says the reason the act was held for', () => {
    expect(requests.heldActWords('skill:none', 'go_stuck')).toContain('前の結果: go_stuck');
  });
});
