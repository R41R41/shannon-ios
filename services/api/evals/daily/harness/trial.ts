import type { ShannonChatModel } from '../../../src/infra/models/chatModel.js';
import type { EvalClaude } from '../claude.js';
import { nextOwnerTurn } from '../simulator.js';
import type { DailyEvalTask } from '../types.js';
import { randomUUID } from 'node:crypto';
import { advanceEvalClock, setEvalClock } from './clock.js';
import type { FakeDeviceState } from './device.js';
import type { FixtureLog } from './fixtures.js';
import { OWNER_SCOPE, applyEnvironment, createEvalRuntime, evalEnvironment, type EvalRuntime, type ToolCallRecord } from './runtime.js';
import { textTurn, voiceTurn, type InnerNoteHooksView, type TurnRecord } from './turns.js';
import type { OwnerTurn } from '../types.js';

/** A research task (an FCA child of the conversation) as the trial watched it. Times are real ms from the trial's start. */
export interface ResearchObservation {
  id: string;
  title: string;
  kind: string;
  /** The owner turn whose request created it (the latest turn started before it was first seen). */
  turn: number;
  seenMs: number;
  completedMs: number | null;
  failedMs: number | null;
  phase: string;
  summary: string;
}

export interface ModelUsage { calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number }

export interface ThreadMessage { role: string; content: string; observedAt: string; reportCard?: { status: string; title: string; answer: string } }

export interface TrialObservation {
  taskId: string;
  trial: number;
  /** The utterance variant this trial used (voice ASR noise). */
  variant: number;
  turns: TurnRecord[];
  /** Each turn's start, real ms from the trial's start (the clock of `research`). */
  turnStartsMs: number[];
  toolCalls: (Omit<ToolCallRecord, 'at'> & { atMs: number })[];
  research: ResearchObservation[];
  device: FakeDeviceState;
  fixtures: FixtureLog;
  messages: ThreadMessage[];
  shannonCostUsd: number;
  modelCalls: number;
  fcaComposed: boolean;
  harnessLog: string[];
  durationMs: number;
  /** Shannon's model calls by model name (from the recorded usage): whether Sonnet actually answered. */
  modelCallsByModel?: Record<string, number>;
  /** Shannon's recorded usage by model: calls, tokens (input includes what the call wrote to the cache) and spend in USD. */
  usageByModel?: Record<string, ModelUsage>;
  /** Sonnet-mode turns that Sonnet did not finish (`TieredChatModel`): fell back to luna, or ended with her fixed line. Set by the runner. */
  sonnetFallbacks?: { toLuna: number; fixedLine: number; reasons: string[] };
  /** Requests that asked Anthropic for its own server-side web tools (set by the runner; they bypass the fixtures). */
  nativeWebRequests?: number;
  /** ADR-0012 (K tasks): every note of the trial, oldest first, with her words (the judge reads them with the replies). */
  innerNotes?: (InnerNoteHooksView & { at: string; triggers: string[]; text: Record<string, string>; summary: string | null })[];
  error?: string;
}

const RESEARCH_KINDS = new Set(['research', 'generic']);
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function watchResearch(runtime: EvalRuntime, origin: number, turnStarts: number[], log: (line: string) => void) {
  const seen = new Map<string, ResearchObservation>();
  const sample = () => {
    let tasks: ReturnType<EvalRuntime['tasks']> = [];
    try { tasks = runtime.tasks(); } catch (error) { log(`task list failed: ${error instanceof Error ? error.message : 'unknown'}`); return; }
    const at = performance.now() - origin;
    for (const task of tasks) {
      if (!RESEARCH_KINDS.has(task.kind) || task.origin !== 'owner_request') continue;
      let entry = seen.get(task.id);
      if (!entry) {
        const turn = Math.max(0, turnStarts.filter(start => start - origin <= at).length - 1);
        entry = { id: task.id, title: task.title, kind: task.kind, turn, seenMs: Math.round(at), completedMs: null, failedMs: null, phase: task.phase, summary: '' };
        seen.set(task.id, entry);
      }
      entry.phase = task.phase; entry.summary = task.summary;
      if (task.phase === 'completed' && entry.completedMs === null) entry.completedMs = Math.round(at);
      if (task.phase === 'failed' && entry.failedMs === null) entry.failedMs = Math.round(at);
    }
  };
  const timer = setInterval(sample, 250);
  return { sample, stop: () => { clearInterval(timer); sample(); return [...seen.values()]; }, current: () => [...seen.values()] };
}

function utteranceOf(task: DailyEvalTask, turnIndex: number, trial: number): { text: string; variant: number } {
  const turn = task.turns[turnIndex]!;
  const forms = [turn.say, ...(task.surface === 'voice' ? turn.asrVariants ?? [] : [])];
  const variant = trial % forms.length;
  return { text: forms[variant]!, variant };
}

/** Runs one trial of a task from a fresh state and returns everything the graders read. */
export async function runTrial(task: DailyEvalTask, trial: number, options: {
  live: boolean; simulator: EvalClaude | null; log?: (line: string) => void; model?: ShannonChatModel; modelMode?: 'haiku' | 'sonnet';
}): Promise<TrialObservation> {
  const harnessLog: string[] = [];
  const log = (line: string) => { harnessLog.push(line); options.log?.(line); };
  const environment = evalEnvironment(process.env, task.initial);
  applyEnvironment(environment);
  setEvalClock(task.initial.clock, task.initial.timeZone);
  const origin = performance.now();
  const runtime = await createEvalRuntime(task, environment, { live: options.live, log, ...(options.model ? { model: options.model } : {}),
    ...(options.modelMode ? { modelMode: options.modelMode } : {}) });
  const turnStarts: number[] = [];
  const watcher = watchResearch(runtime, origin, turnStarts, log);
  const turns: TurnRecord[] = [];
  let variant = 0, error: string | undefined;
  const say = async (text: string, by: TurnRecord['by']) => {
    turnStarts.push(performance.now());
    const record = task.surface === 'voice' ? await voiceTurn(runtime, task, text, turns.length, by) : await textTurn(runtime, task, text, turns.length, by);
    if (runtime.innerNote) record.innerNote = await settledNote(runtime);
    turns.push(record);
    watcher.sample();
    return record;
  };
  try {
    for (let index = 0; index < task.turns.length; index += 1) {
      if (task.turns[index]!.afterSeconds) await delay(task.turns[index]!.afterSeconds! * 1_000);
      await beforeTurn(runtime, task.turns[index]!);
      const utterance = utteranceOf(task, index, trial);
      if (index === 0) variant = utterance.variant;
      await say(utterance.text, 'script');
    }
    if (task.simulator) {
      if (!options.simulator) log('simulator turns skipped: no simulator model (live only)');
      for (let index = 0; options.simulator && index < task.simulator.maxTurns; index += 1) {
        if (task.simulator.afterSeconds) await delay(task.simulator.afterSeconds * 1_000);
        const next = await nextOwnerTurn(options.simulator, task, turns.map(turn => ({ owner: turn.said, shannon: turn.reply })));
        if (!next) break;
        await say(next, 'simulator');
      }
    }
    await settle(task, watcher, () => threadMessages(runtime).filter(message => message.reportCard).length);
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}`.slice(0, 400) : 'unknown';
    log(`trial failed: ${error}`);
  }
  const research = watcher.stop();
  const messages = threadMessages(runtime);
  const observation: TrialObservation = {
    taskId: task.id, trial, variant, turns, turnStartsMs: turnStarts.map(start => Math.round(start - origin)),
    toolCalls: runtime.toolCalls.map(call => ({ tool: call.tool, surface: call.surface, ok: call.ok, atMs: Math.round(call.at - origin) })),
    research, device: structuredClone(runtime.device), fixtures: structuredClone(runtime.fixtures), messages,
    shannonCostUsd: runtime.usage.reduce((sum, event) => sum + event.estimatedCostUsd, 0), modelCalls: runtime.usage.length,
    modelCallsByModel: runtime.usage.reduce<Record<string, number>>((counts, event) => ({ ...counts, [event.model]: (counts[event.model] ?? 0) + 1 }), {}),
    usageByModel: runtime.usage.reduce<Record<string, ModelUsage>>((totals, event) => {
      const total = totals[event.model] ?? { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
      totals[event.model] = { calls: total.calls + 1, inputTokens: total.inputTokens + event.inputTokens, cachedInputTokens: total.cachedInputTokens + event.cachedInputTokens,
        outputTokens: total.outputTokens + event.outputTokens, costUsd: Math.round((total.costUsd + event.estimatedCostUsd) * 1e6) / 1e6 };
      return totals;
    }, {}),
    fcaComposed: runtime.fcaComposed, harnessLog, durationMs: Math.round(performance.now() - origin), ...(error ? { error } : {}),
    ...(runtime.innerNote ? { innerNotes: runtime.innerNotes().reverse().map(note => ({ ...hooksView(note), at: note.createdAt, triggers: [...note.triggers],
      text: { ...note.text }, summary: note.summary })) } : {}),
  };
  try { await runtime.close(); } catch (caught) { log(`close failed: ${caught instanceof Error ? caught.message : 'unknown'}`); }
  return observation;
}

/**
 * Watches research after the last reply: until each task ended, its report card reached the conversation and a short grace
 * passed, or the task's settle time ran out. (Without waiting for the cards, a result that completed near the end of the
 * grace was graded as never told: the first live run, 2026-10-13.)
 */
async function settle(task: DailyEvalTask, watcher: ReturnType<typeof watchResearch>, cards: () => number): Promise<void> {
  const started = performance.now(), limit = started + (task.settleSeconds ?? 0) * 1_000;
  let endedAt: number | null = null;
  while (performance.now() < limit) {
    await delay(500);
    watcher.sample();
    const research = watcher.current();
    // Research is admitted inside the turn, so none after a few seconds means none was asked for.
    if (!research.length) { if (performance.now() - started > 3_000) break; continue; }
    const open = research.some(item => !['completed', 'failed', 'stopped'].includes(item.phase));
    if (open) { endedAt = null; continue; }
    // A completed task is told with a report card; wait for each one (a failed task may have none, so the limit bounds this).
    if (cards() < research.filter(item => item.phase === 'completed').length) { endedAt = null; continue; }
    endedAt ??= performance.now();
    // A late failure notice is what this grace is for (the report card ticks every 5 s).
    if (performance.now() - endedAt > 7_000) break;
  }
}

function threadMessages(runtime: EvalRuntime): ThreadMessage[] {
  try {
    return runtime.store.conversationHistory(OWNER_SCOPE, runtime.threadId).map(message => ({
      role: message.role, content: message.content, observedAt: message.observedAt,
      ...(message.reportCard ? { reportCard: { status: message.reportCard.status, title: message.reportCard.title, answer: message.reportCard.answer } } : {}),
    }));
  } catch { return []; }
}

/** ADR-0012 (K tasks): what comes before the owner's words: the clock moved on (and her note's sweep), a new Talk, a touch. */
async function beforeTurn(runtime: EvalRuntime, turn: OwnerTurn): Promise<void> {
  if (turn.advanceMinutes) {
    advanceEvalClock(turn.advanceMinutes);
    await runtime.innerNote?.sweep();
    await runtime.innerNote?.idle();
  }
  if (turn.newThread) runtime.threadId = runtime.store.createThread(OWNER_SCOPE, '新しいトーク');
  if (!turn.touchBefore || !runtime.innerNote) return;
  runtime.innerNote.touched({ scopeKey: OWNER_SCOPE, audience: 'owner', at: new Date().toISOString(), touchId: `eval-${randomUUID()}`,
    phrase: turn.touchBefore.phrase, ...(turn.touchBefore.reflex ? { reflex: turn.touchBefore.reflex } : {}) });
  await runtime.innerNote.flush(OWNER_SCOPE);
}

/** Her newest note once the reflection of the turn settled. */
async function settledNote(runtime: EvalRuntime): Promise<InnerNoteHooksView | null> {
  await runtime.innerNote!.flush(OWNER_SCOPE);
  const note = runtime.innerNotes()[0];
  return note ? hooksView(note) : null;
}

function hooksView(note: ReturnType<EvalRuntime['innerNotes']>[number]): InnerNoteHooksView {
  return { id: note.id, intent: note.hooks.intent, shown: note.hooks.shown, tell: note.hooks.tell, scale: note.hooks.scale, until: note.hooks.until,
    closed: note.closedAt !== null, flags: Object.keys(note.flags), dayKey: note.dayKey };
}
