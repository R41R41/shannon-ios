import { describe, expect, it, vi } from 'vitest';
import { createSleepFcaStep, sleepFcaHistoryCodec } from '../src/mind/sleep/sleepFcaPhases.js';
import type { SleepFcaPhaseHandler } from '../src/mind/sleep/sleepFcaPorts.js';
import { checkedTemplate } from '@shannon/mind';
import { sleepFcaHistorySummarizer } from '../src/mind/sleep/sleepFcaHistory.js';
const job = { id: 'night-1', scopeKey: 'owner', dayKey: '2026-10-09', startAt: '2026-10-08T15:00:00Z', endAt: '2026-10-09T15:00:00Z' };
const input = { task: { id: 'task-1', title: 'sleep', goal: 'sleep', completionCriteria: 'done' }, messages: [], history: [], tools: [] };
const signal = new AbortController().signal;
describe('sleep phases inside one common FCA step', () => {
  it('advances only after apply, resumes from committed checkpoint, and completes without another model', async () => {
    const memory: SleepFcaPhaseHandler = { decide: vi.fn(async () => ({ privateAnswer: 'not in the ledger' })), apply: vi.fn(async () => ({ done: true, summary: 'queued' })) };
    const make = (checkpoint?: unknown) => createSleepFcaStep({ job, checkpoint, handlers: { memory }, assertCurrent: () => true });
    const first = make(); const output = await first.model.decide(input, signal);
    expect(first.checkpoint()).toMatchObject({ sleepFca: { phase: 'memory' } });
    expect(output.decision.kind).toBe('tools'); if (output.decision.kind !== 'tools') return;
    const call = output.decision.calls[0]!;
    const result = await first.tools.execute({ scopeKey: job.scopeKey, taskId: input.task.id, operationId: 'step:call', name: call.name, input: call.input, signal });
    expect(result.text).toBe('queued'); expect(first.checkpoint()).toMatchObject({ sleepFca: { phase: 'done' } });
    const entries = [...output.history, first.model.toolResults([{ id: call.id, text: result.text, ok: result.ok }])];
    expect(JSON.stringify(entries)).not.toContain('privateAnswer');
    expect(sleepFcaHistoryCodec.project({ sequence: 1, stepId: 'step', committedAt: job.endAt, status: 'running', sources: [], entries })).toHaveLength(2);
    expect((await make(first.checkpoint().sleepFca).model.decide(input, signal)).decision.kind).toBe('complete');
    expect(memory.decide).toHaveBeenCalledTimes(1);
    await expect(first.tools.execute({ scopeKey: job.scopeKey, taskId: input.task.id, operationId: 'step:again', name: call.name, input: call.input, signal })).rejects.toThrow('SLEEP_FCA_OPERATION_MISMATCH');
  });
  it('does not replay an uncertain provider and never applies a late aborted answer', async () => {
    const uncertain = createSleepFcaStep({ job, handlers: { memory: { decide: async () => { throw Error('unknown'); }, apply: vi.fn() } }, assertCurrent: () => true });
    await expect(uncertain.model.decide(input, signal)).rejects.toThrow('unknown');
    await expect(uncertain.model.decide(input, signal)).rejects.toThrow('REPLAY');
    const controller = new AbortController(), apply = vi.fn();
    const late = createSleepFcaStep({ job, handlers: { memory: { decide: async () => { controller.abort(); return {}; }, apply } }, assertCurrent: () => true });
    await expect(late.model.decide(input, controller.signal)).rejects.toThrow(); expect(apply).not.toHaveBeenCalled();
    expect(late.checkpoint()).toMatchObject({ sleepFca: { phase: 'memory' } });
  });
  it('rejects a checkpoint for a different night and incomplete history', () => {
    expect(() => createSleepFcaStep({ job, checkpoint: { schemaVersion: 1, jobId: 'other', phase: 'done' }, handlers: { memory: { decide: vi.fn(), apply: vi.fn() } }, assertCurrent: () => true })).toThrow('CHECKPOINT');
    expect(sleepFcaHistoryCodec.project({ sequence: 1, stepId: 'step', committedAt: job.endAt, status: 'running', sources: [], entries: [{ sleepFca: 1, kind: 'decision', id: 'one', phase: 'memory' }] })).toBeNull();
  });
  it('compacts the closed ledger without a model and carries exact counts over successive epochs', async () => {
    const round = (sequence: number, phase: string, status: string) => ({ sequence, stepId: `step${sequence}`, messages: [
      { id: `call${sequence}`, role: 'tool_call' as const, callId: `call${sequence}`, content: `sleep phase: ${phase}` },
      { id: `result${sequence}`, role: 'tool_result' as const, callId: `call${sequence}`, content: 'do not copy this result text' },
      { id: `fca-round:${sequence}:status`, role: 'assistant' as const,
        content: `Committed task status after this round: ${status}. A requested completion is not proof of completion.` },
    ] });
    const first = checkedTemplate(await sleepFcaHistorySummarizer.summarize({ previous: null,
      rounds: [round(1, 'memory', 'running'), round(2, 'people', 'paused')] }, signal), { fromId: 'fca-round:1', toId: 'fca-round:2' })!;
    const next = checkedTemplate(await sleepFcaHistorySummarizer.summarize({ previous: first,
      rounds: [round(3, 'people', 'running')] }, signal))!;
    expect(next['済み']).toEqual(['phase:memory=1', 'phase:knowledge=0', 'phase:skills=0', 'phase:people=2', 'phase:export=0']);
    expect(next['途中']).toContain('status:running=2'); expect(next['重要な文脈']).toContain('rounds=3');
    expect(next['重要な文脈']).toContain('range=1:3'); expect(JSON.stringify(next)).not.toContain('do not copy');
    await expect(sleepFcaHistorySummarizer.summarize({ previous: null, rounds: [round(4, 'people', 'fabricated')] }, signal)).rejects.toThrow('STATUS');
  });
});
