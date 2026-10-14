import { describe, expect, it } from 'vitest';
import type { CompactionMessage } from '@shannon/mind';
import { FCA_HISTORY_POLICY, fallbackFcaHistory } from '../src/mind/action/fca/fcaHistory.js';
import type { FcaHistoryCodec } from '../src/mind/action/fca/fcaHistoryPorts.js';
import type { TaskHistoryRound, TaskHistoryWindow } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * Review of 8da89bc7 (2026-10-14, after a production incident from a pinned main thread): the summary fallback ran on the event
 * loop and re-clipped every remaining round from the start for each round it left out, measuring the whole replay at each cut —
 * 20 rounds × 10 messages × 5,000 characters took 6.2 s, 40 × 10 × 5,000 took 56 s. Its work must stay about linear in the
 * rounds and messages: these tests count the replays it measures and bound its time.
 */
const LONG = (index: number, characters: number) => `結果 "${index}" \\ ${'観測した値 x='.repeat(characters / 8)}`.slice(0, characters);
function shape(rounds: number, messages: number, characters: number) {
  const projected = new Map<number, CompactionMessage[]>();
  const window: TaskHistoryWindow = { revision: 0, sourceRevision: 'r', tailSequence: rounds, summary: null,
    rounds: Array.from({ length: rounds }, (_, index) => {
      const sequence = index + 1;
      projected.set(sequence, Array.from({ length: messages }, (_, at) => at % 2
        ? { id: `${sequence}:${at}`, role: 'tool_result' as const, callId: `call-${sequence}-${at - 1}`, content: LONG(at, characters) }
        : { id: `${sequence}:${at}`, role: 'tool_call' as const, callId: `call-${sequence}-${at}`, content: LONG(at, characters) }));
      return { sequence, stepId: `step-${sequence}`, entries: [], status: 'queued', sources: [] } as unknown as TaskHistoryRound;
    }) };
  let measured = 0;
  const codec: FcaHistoryCodec = { project: round => projected.get(round.sequence)!, bootstrap: text => { measured++; return [{ role: 'user', content: text }]; } };
  return { window, codec, measured: () => measured };
}
const replayed = (history: readonly unknown[]) => JSON.parse((history[0] as { content: string }).content) as {
  kind: string; omittedRounds?: number; rounds: Array<{ sequence: number; messages: CompactionMessage[] }> };

describe('the summary fallback replay stays about linear (review of 8da89bc7)', () => {
  it.each([[20, 10, 5_000], [40, 10, 5_000], [30, 20, 2_000]] as const)('%i rounds × %i messages × %i characters', (rounds, messages, characters) => {
    const f = shape(rounds, messages, characters);
    const started = performance.now();
    const replay = fallbackFcaHistory(f.window, f.codec);
    const elapsed = performance.now() - started;
    expect(JSON.stringify(replay.history).length).toBeLessThanOrEqual(FCA_HISTORY_POLICY.maximumNativeCharacters);
    const epoch = replayed(replay.history);
    expect(epoch.kind).toBe('fca_public_history');
    // The newest rounds are kept, in order, each whole in its messages; the left-out oldest ones are counted.
    expect(epoch.rounds.at(-1)!.sequence).toBe(rounds);
    expect(epoch.rounds.map(round => round.sequence)).toEqual(Array.from({ length: epoch.rounds.length }, (_, index) => rounds - epoch.rounds.length + 1 + index));
    expect((epoch.omittedRounds ?? 0) + epoch.rounds.length).toBe(rounds);
    expect(replay.omittedRounds).toBe(epoch.omittedRounds ?? 0);
    expect(epoch.rounds.every(round => round.messages.length === messages + 1)).toBe(true);
    for (const message of epoch.rounds.flatMap(round => round.messages)) {
      if (message.role !== 'assistant' && message.content.length < characters) expect(message.content).toMatch(/…（長いため後略: \d+字）$/u);
    }
    // Replays measured: a bounded number per round plus a bounded search, never per cut per left-out round.
    expect(f.measured()).toBeLessThanOrEqual(2 * rounds + 64);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('keeps every round, unclipped, when they fit, and clips only what is needed', () => {
    const f = shape(3, 4, 1_000);
    const replay = fallbackFcaHistory(f.window, f.codec);
    expect(replay).toMatchObject({ omittedRounds: 0, clippedMessages: 0 });
    expect(replayed(replay.history).rounds.map(round => round.sequence)).toEqual([1, 2, 3]);
    const tight = fallbackFcaHistory(f.window, f.codec, { maximumNativeCharacters: 12_000 });
    expect(tight.omittedRounds).toBe(0);
    expect(tight.clippedMessages).toBeGreaterThan(0);
    expect(JSON.stringify(tight.history).length).toBeLessThanOrEqual(12_000);
    expect(JSON.stringify(tight.history).length).toBeGreaterThan(11_000); // cut to the budget, not far below it
  });

  it('holds with FCA_HISTORY_RECENT_LIMIT when the newest round alone cannot fit', () => {
    const f = shape(5, 40, 5_000);
    expect(() => fallbackFcaHistory(f.window, f.codec, { maximumNativeCharacters: 10_000 })).toThrow('FCA_HISTORY_RECENT_LIMIT');
  });
});
