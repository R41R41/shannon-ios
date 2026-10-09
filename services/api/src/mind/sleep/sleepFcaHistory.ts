import { emptyTemplate, type CompactionTemplate } from '@shannon/mind';
import type { FcaHistorySummarizer } from '../action/fca/fcaHistoryPorts.js';

const phases = ['memory', 'knowledge', 'skills', 'people', 'export'] as const;
const states = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'unknown'] as const;
const statusPattern = /^Committed task status after this round: (queued|running|paused|completed|failed|cancelled|unknown)\. A requested completion is not proof of completion\.$/u;
function count(previous: CompactionTemplate | null, key: string): number {
  if (!previous) return 0;
  const values = Object.values(previous).flat().filter((item): item is string => typeof item === 'string' && item.startsWith(`${key}=`));
  if (values.length !== 1 || !/^\d+$/u.test(values[0]!.slice(key.length + 1))) throw new Error('SLEEP_FCA_HISTORY_SUMMARY_INVALID');
  const value = Number(values[0]!.slice(key.length + 1));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('SLEEP_FCA_HISTORY_SUMMARY_INVALID');
  return value;
}

/** This ledger contains only code-authored phase receipts. The saved phase/cursor, never this summary, drives execution. */
export const sleepFcaHistorySummarizer: FcaHistorySummarizer = {
  async summarize(input, signal) {
    signal.throwIfAborted();
    if (!input.rounds.length) throw new Error('SLEEP_FCA_HISTORY_EMPTY');
    const phaseCounts = Object.fromEntries(phases.map(phase => [phase, count(input.previous, `phase:${phase}`)]));
    const stateCounts = Object.fromEntries(states.map(status => [status, count(input.previous, `status:${status}`)]));
    let rounds = count(input.previous, 'rounds'), through = 0, last = 'unknown';
    for (const round of input.rounds) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(round.sequence) || round.sequence <= through) throw new Error('SLEEP_FCA_HISTORY_ORDER');
      through = round.sequence; rounds += 1;
      const status = round.messages.find(message => message.id === `fca-round:${round.sequence}:status`);
      const matched = status?.role === 'assistant' ? statusPattern.exec(status.content) : null;
      if (!matched) throw new Error('SLEEP_FCA_HISTORY_STATUS');
      last = matched[1]!; stateCounts[last] = stateCounts[last]! + 1;
      for (const message of round.messages) if (message.role === 'tool_call') {
        const phase = /^sleep phase: (memory|knowledge|skills|people|export)$/u.exec(message.content)?.[1];
        if (!phase) throw new Error('SLEEP_FCA_HISTORY_PHASE');
        phaseCounts[phase] = phaseCounts[phase]! + 1;
      }
    }
    const first = input.previous?.coversFromId?.match(/^fca-round:(\d+)$/u)?.[1] ?? String(input.rounds[0]!.sequence);
    return {
      ...emptyTemplate(),
      '目的': ['Scheduled sleep maintenance; the checkpoint is authoritative.'],
      '制約': ['Compaction makes no model call.', 'Original coverage and source fences remain active.'],
      '済み': phases.map(phase => `phase:${phase}=${phaseCounts[phase]}`),
      '途中': ['queued', 'running', 'paused'].map(status => `status:${status}=${stateCounts[status]}`),
      '詰まり': ['failed', 'cancelled', 'unknown'].map(status => `status:${status}=${stateCounts[status]}`),
      '決めたこと': [`status:completed=${stateCounts.completed}`],
      '次': ['Resume the phase and cursor from the committed checkpoint.'],
      '重要な文脈': [`rounds=${rounds}`, `range=${first}:${through}`, `last=${last}`],
    };
  },
};
