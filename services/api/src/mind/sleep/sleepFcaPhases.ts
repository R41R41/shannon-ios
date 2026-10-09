import { observeAsync, observerHandoff } from '../../infra/observer/observerContext.js';
import { randomUUID } from 'node:crypto';
import type { CompactionMessage } from '@shannon/mind';
import type { FcaHistoryCodec } from '../action/fca/fcaHistoryPorts.js';
import type { FcaToolDefinition } from '../action/fca/fcaPorts.js';
import type { SleepFcaCheckpoint, SleepFcaPhase, SleepFcaStep, SleepFcaStepOptions } from './sleepFcaPorts.js';
import { sleepFcaHistorySummarizer } from './sleepFcaHistory.js';

const PHASES: readonly SleepFcaPhase[] = ['memory', 'knowledge', 'skills', 'people', 'export', 'done'];
const APPLY = 'sleep.phase_apply';
const TOOL: FcaToolDefinition = { name: APPLY, description: '現在の睡眠整理の一回分を、元の根拠と記憶の制御を再確認して反映する。',
  domain: 'task_runtime', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
  input: { type: 'object', properties: { receipt: { type: 'string', description: 'この一回の判断に対応する受付ID', minLength: 1, maxLength: 160 } }, required: ['receipt'], additionalProperties: false } };
type Entry = { sleepFca: 1; kind: 'decision' | 'result' | 'complete'; phase?: SleepFcaPhase; id?: string; text?: string; ok?: boolean };

/** Each provider call is independent JSON, as before; this public phase ledger is never a signed native replay. */
export const sleepFcaHistoryCodec: FcaHistoryCodec = {
  bootstrap: text => [{ sleepFca: 1, kind: 'complete', text }],
  project(round) {
    const entries = round.entries as Entry[];
    if (!entries.length || entries.some(entry => !entry || entry.sleepFca !== 1)) return null;
    const calls = new Set<string>(); const results = new Set<string>();
    const projected: CompactionMessage[] = [];
    for (const [index, entry] of entries.entries()) {
      if (entry.kind === 'decision' && entry.id && PHASES.includes(entry.phase!)) {
        if (calls.has(entry.id)) return null;
        calls.add(entry.id); projected.push({ id: `${round.stepId}:${index}`, role: 'tool_call', callId: entry.id, content: `sleep phase: ${entry.phase}` });
      } else if (entry.kind === 'result' && entry.id && typeof entry.text === 'string' && typeof entry.ok === 'boolean') {
        if (!calls.has(entry.id) || results.has(entry.id)) return null;
        results.add(entry.id); projected.push({ id: `${round.stepId}:${index}`, role: 'tool_result', callId: entry.id, content: entry.text });
      } else if (entry.kind === 'complete' && typeof entry.text === 'string') projected.push({ id: `${round.stepId}:${index}`, role: 'assistant', content: entry.text });
      else return null;
    }
    return calls.size === results.size ? projected : null;
  },
};

/** The ordinary runFcaStep executes the one bounded phase. A lost paid answer is not reconstructed or replayed here. */
export function createSleepFcaStep(options: SleepFcaStepOptions): SleepFcaStep {
  let checkpoint = checkedCheckpoint(options.checkpoint, options.job.id);
  let pending: { id: string; answer: unknown; phase: Exclude<SleepFcaPhase, 'done'> } | null = null;
  let decided = false, applied = false;
  const check = (signal: AbortSignal) => { signal.throwIfAborted(); if (!options.assertCurrent()) throw new Error('SLEEP_FCA_FENCED'); };
  const next = (phase: SleepFcaPhase): SleepFcaPhase => PHASES.slice(PHASES.indexOf(phase) + 1)
    .find(candidate => candidate === 'done' || options.handlers[candidate]) ?? 'done';
  return {
    history: { codec: sleepFcaHistoryCodec, summarizer: sleepFcaHistorySummarizer },
    checkpoint: () => ({ sleepFca: structuredClone(checkpoint) }),
    model: {
      async decide(_input, signal) {
        check(signal);
        if (decided) throw new Error('SLEEP_FCA_DECISION_REPLAY');
        decided = true;
        while (checkpoint.phase !== 'done' && !options.handlers[checkpoint.phase]) checkpoint = { ...checkpoint, phase: next(checkpoint.phase), state: null };
        if (checkpoint.phase === 'done') return { decision: { kind: 'complete', summary: '睡眠整理の各工程を確認しました。' }, history: [{ sleepFca: 1, kind: 'complete', text: 'Sleep phases completed.' }] };
        const phase = checkpoint.phase;
        observerHandoff('fca', 'sleep', { phase, operation: 'decide' });
        const answer = await observeAsync('sleep', { phase, operation: 'decide' },
          () => options.handlers[phase]!.decide({ job: options.job, state: structuredClone(checkpoint.state), signal }));
        check(signal);
        pending = { phase, answer, id: `sleep-${randomUUID()}` };
        return { decision: { kind: 'tools', calls: [{ id: pending.id, name: APPLY, input: { receipt: pending.id } }] },
          history: [{ sleepFca: 1, kind: 'decision', phase, id: pending.id }] };
      },
      toolResults(results) {
        if (results.length !== 1 || !pending || results[0]?.id !== pending.id) throw new Error('SLEEP_FCA_RESULT_MISMATCH');
        const result = results[0]!;
        return { sleepFca: 1, kind: 'result', id: result.id, text: result.text, ok: result.ok };
      },
    },
    tools: { definitions: [TOOL], async execute(request) {
      check(request.signal);
      const input = request.input as { receipt?: unknown } | null;
      if (request.scopeKey !== options.job.scopeKey || request.name !== APPLY || !pending || applied
        || !input || Object.keys(input).length !== 1 || input.receipt !== pending.id) throw new Error('SLEEP_FCA_OPERATION_MISMATCH');
      applied = true; // An uncertain apply never runs twice, even before the parent commits its checkpoint.
      const phase = pending.phase, answer = pending.answer;
      observerHandoff('tools', 'sleep', { phase, operation: 'apply' });
      const outcome = await observeAsync('sleep', { phase, operation: 'apply' }, () => options.handlers[phase]!.apply(answer, { job: options.job, state: structuredClone(checkpoint.state),
        operationId: request.operationId, signal: request.signal }), value => ({ done: value.done }));
      check(request.signal);
      if (!outcome || typeof outcome.done !== 'boolean' || typeof outcome.summary !== 'string') throw new Error('SLEEP_FCA_OUTCOME_INVALID');
      checkpoint = checkedCheckpoint({ schemaVersion: 1, jobId: options.job.id,
        phase: outcome.done ? next(pending.phase) : pending.phase, state: outcome.done ? null : outcome.state ?? null }, options.job.id);
      return { ok: true, retryable: false, text: outcome.summary.slice(0, 2000) };
    } },
  };
}

function checkedCheckpoint(value: unknown, jobId: string): SleepFcaCheckpoint {
  if (value === undefined || value === null) return { schemaVersion: 1, jobId, phase: 'memory', state: null };
  const row = value as SleepFcaCheckpoint;
  if (!row || row.schemaVersion !== 1 || row.jobId !== jobId || !PHASES.includes(row.phase)
    || JSON.stringify(row).length > 32_000) throw new Error('SLEEP_FCA_CHECKPOINT_INVALID');
  return structuredClone(row);
}
