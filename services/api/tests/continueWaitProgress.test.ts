import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { forgetStalls, noteRan, resumeStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

afterEach(forgetStalls);
it('does not call the recorded withdrawal and crafting sequence a wait-only loop', () => {
  const trace = JSON.parse(readFileSync(new URL('./fixtures/run54-wait-progress.json', import.meta.url), 'utf8'));
  for (const row of trace) expect(noteRan('trace', row), row.at).toBeNull();
});
const result = (lines: unknown[]) => JSON.stringify({ v: 1, done: lines.length, of: lines.length, ms: 1000, lines });
const delta = (id = 'crafted:1', count = 1) => [{ id, count, reason: 'crafted', item: 'iron_sword', obsSeq: 1 }];
const wait = () => noteRan('t', { hands: [{ do: 'wait' }], result: result([{ i: 1, do: 'wait', status: 'done', goal: 'done', end: 'finished' }]) });
const work = (over: Record<string, unknown> = {}) => noteRan('t', { hands: [{ do: 'make' }], result: result([{ i: 1, do: 'make', status: 'done', goal: 'done', end: 'finished', delta: delta(), ...over }]) });
it('credits a real new output even when crafting consumes more items than it creates', () => {
  wait(); wait();
  expect(work({ delta: [{ id: 'in:1', item: 'iron_ingot', count: -2, reason: 'ingredient' }, ...delta()] })).toBeNull();
  expect(wait()).toBeNull(); expect(wait()).toBeNull();
  expect(wait()?.kind).toBe('wait_loop');
});
it.each([
  { delta: [] }, { delta: delta('zero', 0) }, { goal: 'failed', delta: [] },
  { goal: 'not_started', end: 'not_run' }, { end: 'unknown' }, { delta: delta('bad', NaN) },
])('does not credit an empty/failed/unexecuted/unsettled claim %j', change => {
  wait(); wait(); work(change);
  expect(wait()?.kind).toBe('wait_loop');
});
it('does not renew from the same positive event replayed after a resume', () => {
  work(); resumeStalls('t'); wait(); wait();
  expect(work()).toBeNull();
  expect(wait()?.kind).toBe('wait_loop');
});
it('keeps the reconnect rule in the instructions without treating estimates as inventory', () => {
  expect(V2_ALWAYS).toContain('jobs は見込み');
  expect(V2_ALWAYS).toContain('残り秒で待ち直さず');
  expect(V2_ALWAYS).toContain('安全な前提作業・帰路を先に進める');
  expect(V2_ALWAYS).toContain('furnace op=take');
});
