import type { DatabaseSync } from 'node:sqlite';
import type { ActionLease, ActionThreads } from '../contracts/actionThreadContract.js';
import type { TaskAuthority, TaskRecord, TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { BodyRecheckResult } from './minecraftBodyRecheckWiring.js';

export interface FcaBodyRecoveryParts {
  db: DatabaseSync;
  authority: TaskAuthority;
  runtime: TaskRuntime;
  actions: Pick<ActionThreads, 'reconcile'>;
  scopeKey: string;
  now(): string;
  /** Whether this process is executing the task's step right now. */
  running(taskId: string): boolean;
  body: {
    /** The body a task is bound to, or null for a task that is not a Minecraft body task. */
    bound(taskId: string): string | null;
    connected(bodyId: string): boolean;
    release(step: { actionId: string; scopeKey: string; lease: ActionLease }): Promise<BodyRecheckResult>;
  };
  /**
   * A-17: whether a hold of the operator stands for the task (an open row of the audit: the head's own hold or the
   * body's). A held
   * request is the owner's to resume: it is never retired by
   * the unknown exit, never put back in the queue by itself, and a step lost meanwhile ends in a pause (stopped,
   * resumable), not in a failure.
   */
  held?(taskId: string): boolean;
  windowMs?: number;
  limit?: { count: number; withinMs: number };
  /** The least time between two background passes (tests: 0). */
  passMs?: number;
  log?(line: string): void;
}

export interface FcaBodyRecovery {
  /** A Minecraft request the owner made: bound to a body, directly the owner's work. */
  isBodyTask(task: Pick<TaskRecord, 'id' | 'origin' | 'kind'>): boolean;
  /** Whether `retireUnknown` must leave this unknown task alone: it is waiting for its body. */
  holds(task: TaskRecord): boolean;
  /** Whether the task still has a lost step to close, or a notice to send: it is not admitted until then. */
  blocks(taskId: string): boolean;
  /** Pauses (as stopped, not failed) the tasks whose body did not return in time. Synchronous: it runs before `retireUnknown`. */
  expire(): void;
  /** One background pass: closes lost steps, then returns the unknown tasks to the queue. Never throws. */
  advance(): Promise<void>;
  idle(): Promise<void>;
  /** Diagnostics: what is kept per lost step and per task. Every count returns to zero once nothing is waited for (L-8). */
  retained(): { releasing: number; told: number; awaiting: number; exhausted: number; unannounced: number };
}

/** How the body is asked for a step's proof: while its task is active (`attempts`) or paused (`held`). */
export interface ReleaseState {
  at: number;
  attempts: number;
  held: number;
}
