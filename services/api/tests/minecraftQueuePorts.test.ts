import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { queueTaskPorts } from '../src/wiring/fcaMinecraftQueuePorts.js';
import type { QueueRecord } from '../src/surfaces/minecraft/minecraftRequestQueue.js';

const entry = (origin: QueueRecord['origin']): QueueRecord => ({ id: 'e1', seq: 1, goal: 'エンドラを倒して', state: 'running', pos: 0, origin, requestId: null,
  experienceId: null, observedAt: null, askedBy: null, taskId: null, createdAt: 'x', updatedAt: 'x', endedAt: null, note: null, resumeAfter: null });

describe('how an entry becomes a task', () => {
  const made = (origin: QueueRecord['origin']) => {
    const newTask = vi.fn(async () => 'task-1');
    const ports = queueTaskPorts({ db: {} as DatabaseSync, control: { available: () => ['body'] } as never, runtime: {} as never, ownerScope: 'owner',
      atomic: work => work(), stop: async () => [], log: () => undefined, spec: goal => ({ title: goal, goal }), requestOrigin: () => null, newTask });
    return ports.start(entry(origin)).then(() => (newTask.mock.calls as unknown as string[][])[0]![0]!);
  };

  it('hands his typed words (the game chat, the mod list) to the task maker as his words, and nothing for what she or the voice wrote', async () => {
    expect(await made('chat')).toBe('エンドラを倒して');
    expect(await made('mod')).toBe('エンドラを倒して');
    expect(await made('voice')).toBe('');
    expect(await made('app')).toBe('');
  });
});
