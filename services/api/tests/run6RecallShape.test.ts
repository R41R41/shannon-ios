import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/turnCognitiveContext.js';
import { run6RecallShape, type Run6RecallShape } from './support/run6RecallShape.js';

/**
 * Minecraft run 6 (2026-10-14): the API's one thread was blocked 9.9 s, 3.3 s, 13.6 s and 10.6 s while a stop was being handed to
 * the body. Each FCA step rebuilt the recall graph walk three times (the task's deterministic context, `memory.search`, the
 * decision packet), and every text and voice turn once (`visible=3.6–4.0 s` in the slow-context line). On the production-shaped
 * fixture below each of these paths now takes 7–16 ms locally (before: 104–236 ms; production 3.6–4.0 s); the bounds are for CI.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
function shape(): Run6RecallShape { const f = run6RecallShape(); cleanups.push(() => f.close()); return f; }
const elapsed = (work: () => unknown) => { const started = performance.now(); work(); return performance.now() - started; };
const turn = (f: Run6RecallShape, channel: 'text' | 'voice') => prepareTurnCognitiveContext(f.world.store.snapshot('owner'), f.world.store, {
  scopeKey: 'owner', message: '調べもの12の結果を覚えてる？', occurredAt: f.world.now(), channel, present: f.present, threadId: 'thread-1' });
const timings: Record<string, number[]> = {};
const record = (name: string, ms: number) => { (timings[name] ??= []).push(Math.round(ms)); };

describe('run 6 recall shape', () => {
  it('prepares a text and a voice turn\'s deterministic context without a long block', () => {
    const f = shape();
    for (const channel of ['text', 'voice'] as const) for (let round = 0; round < 3; round++) record(`turn.${channel}`, elapsed(() => turn(f, channel)));
    console.info(`run6 timings ${JSON.stringify(timings)}`);
    expect(Math.max(...timings['turn.text']!.slice(1), ...timings['turn.voice']!.slice(1))).toBeLessThan(300);
  }, 300_000);

  it('runs one FCA step\'s recall (start, then the decision packet) without a long block', async () => {
    const f = shape();
    for (let round = 0; round < 4; round++) {
      // The run 6 cue (no memory matches it) and one that matches remembered task experiences (the packet then reads them).
      const cue = round % 2 ? '調べもの12の結果' : 'エンドラを討伐してください';
      const input = { scopeKey: 'owner', taskId: `task-${round}`, contextVersion: `v${round}`, cue, present: f.present, semantic: false };
      record('fca.start', elapsed(() => f.recall.start(input)));
      const started = performance.now(); const packet = await f.recall.packet(input); record('fca.packet', performance.now() - started);
      expect(['ready', 'no_match']).toContain(packet.status);
    }
    console.info(`run6 timings ${JSON.stringify(timings)}`);
    expect(Math.max(...timings['fca.start']!.slice(1), ...timings['fca.packet']!.slice(1))).toBeLessThan(300);
  }, 300_000);
});
