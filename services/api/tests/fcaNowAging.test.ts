import { expect, it } from 'vitest';
import { fcaNowProjection } from '../src/infra/http/fcaNowProjection.js';
import type { TaskRuntime } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

const NOW = Date.parse('2026-10-12T14:00:00.000Z');

function runtimeWith(tasks: Array<{ id: string; phase: string; updatedAt: string; kind?: string }>): TaskRuntime {
  const rows = tasks.map(task => ({ parentId: 'root', kind: 'research', origin: 'owner_request', title: task.id, summary: '', revision: 1, ...task }));
  return { list: () => rows, taskSources: () => [] } as unknown as TaskRuntime;
}

it('keeps live work in "now" and lets finished or unknown work leave it after an hour', () => {
  const runtime = runtimeWith([
    { id: 'running', phase: 'executing', updatedAt: '2026-10-12T01:00:00.000Z' },
    { id: 'waiting', phase: 'waiting', updatedAt: '2026-10-12T01:00:00.000Z' },
    { id: 'failed-old', phase: 'failed', updatedAt: '2026-10-12T01:31:00.000Z' },
    { id: 'failed-new', phase: 'failed', updatedAt: '2026-10-12T13:30:00.000Z' },
    { id: 'unknown-old', phase: 'unknown', updatedAt: '2026-10-12T12:00:00.000Z' },
    { id: 'done-old', phase: 'completed', updatedAt: '2026-10-11T18:46:00.000Z' },
    { id: 'conversation', phase: 'executing', updatedAt: '2026-10-12T13:59:00.000Z', kind: 'conversation' },
  ]);
  const view = fcaNowProjection(runtime, 'owner', () => true, undefined, () => NOW);
  expect(view.tasks.map(task => task.id)).toEqual(['running', 'waiting', 'failed-new']);
});
