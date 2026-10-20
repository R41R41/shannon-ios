import { describe, expect, it } from 'vitest';
import { fcaMinecraftVoice, type FcaMinecraftVoiceParts } from '../src/wiring/fcaMinecraftVoice.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

const task = (id: string, goal: string): TaskView => ({
  id, scopeKey: 'owner', parentId: 'root', kind: 'task', origin: 'owner_request', title: goal, goal, completionCriteria: '', status: 'ready',
  pauseReason: null, summary: '', revision: 1, createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z', phase: 'executing', childIds: [],
} as unknown as TaskView);

function fixture(options: { bodies?: string[]; running?: TaskView | null; visible?: boolean; finished?: boolean } = {}) {
  const calls: string[] = [];
  const bound = options.running ? [options.running] : [];
  const parts: FcaMinecraftVoiceParts = {
    control: { available: () => options.bodies ?? ['minecraft:world'], store: { bind: (id: string, body: string) => { calls.push(`bind ${id} ${body}`); return true; } } } as never,
    runtime: {
      observeExternal: (_scope: string, id: string, event: { eventId: string; experienceIds: string[]; text: string }) => {
        if (options.finished && id === 't1') throw new Error('FCA_TARGET_FINISHED');
        calls.push(`observe ${id} ${event.eventId} ${event.experienceIds.join(',')} ${event.text}`);
        return { accepted: true, duplicate: false };
      },
      ensureRoot: () => ({ id: 'root' }),
      createChild: (_scope: string, parent: string, spec: { goal: string }, request: string, choices: { sources: string }) => {
        calls.push(`child ${parent} ${spec.goal} ${request} ${choices.sources}`);
        return task('new-task', spec.goal);
      },
    } as never,
    ownerScope: 'owner',
    stop: async (id: string, reason: string) => { calls.push(`stop ${id} ${reason}`); return []; },
    sourceVisible: () => options.visible ?? true,
    atomic: work => work(),
    bound: () => bound,
    openRequest: () => options.running ?? undefined,
    spec: goal => ({ title: goal, goal }),
    log: () => undefined,
  };
  return { port: fcaMinecraftVoice(parts), calls };
}

const input = (fields: Record<string, unknown> = {}) => ({
  scopeKey: 'owner', requestId: 'r1', observedAt: '2026-10-20T12:00:00.000Z', experienceId: 'exp-1', allowNew: false,
  intent: { kind: 'task' as const, goal: 'まず鉄の剣を作って' }, ...fields,
});

describe('the owner\'s spoken request, as the task tree takes it', () => {
  it('says whether the body is connected and what he asked of it', () => {
    expect(fixture({ bodies: [] }).port.state()).toEqual({ connected: false, running: null });
    expect(fixture({ bodies: ['a', 'b'] }).port.state()).toEqual({ connected: false, running: null });
    expect(fixture().port.state()).toEqual({ connected: true, running: null });
    expect(fixture({ running: task('t1', 'エンドラを倒す') }).port.state()).toEqual({ connected: true, running: { id: 't1', goal: 'エンドラを倒す' } });
  });

  it('delivers a request while one is under way as a message to that task, once for a retried turn', async () => {
    const { port, calls } = fixture({ running: task('t1', 'エンドラを倒す') });
    expect(await port.intent(input())).toEqual({ delivered: true, as: 'message', taskId: 't1' });
    expect(calls).toEqual(['observe t1 dcv:r1 exp-1 Discordの通話での本人の言葉（いまのタスクへ）: まず鉄の剣を作って']);
  });

  it('makes a new task only when he is alone, and refuses with a reason otherwise', async () => {
    const alone = fixture();
    expect(await alone.port.intent(input({ allowNew: true }))).toEqual({ delivered: true, as: 'task', taskId: 'new-task' });
    expect(alone.calls[0]).toBe('child root まず鉄の剣を作って dcv:r1 asking');
    expect(alone.calls).toContain('bind new-task minecraft:world');
    expect(await fixture().port.intent(input())).toEqual({ delivered: false, reason: 'others_present' });
  });

  it('goes on to a new task when the one under way ended meanwhile, if he is alone', async () => {
    const ended = fixture({ running: task('t1', 'x'), finished: true });
    expect(await ended.port.intent(input())).toEqual({ delivered: false, reason: 'others_present' });
    const aloneEnded = fixture({ running: task('t1', 'x'), finished: true });
    expect(await aloneEnded.port.intent(input({ allowNew: true }))).toMatchObject({ delivered: true, as: 'task' });
  });

  it('stops the body\'s tasks whoever is in the channel, and refuses what has no turn, no body or another scope', async () => {
    const stopping = fixture({ running: task('t1', 'x') });
    expect(await stopping.port.intent(input({ intent: { kind: 'stop', goal: '' } }))).toEqual({ delivered: true, as: 'stop' });
    expect(stopping.calls).toEqual(['stop t1 owner_voice_stop']);
    expect(await fixture().port.intent(input({ intent: { kind: 'none', goal: '' } }))).toEqual({ delivered: false });
    expect(await fixture().port.intent(input({ scopeKey: 'someone' }))).toEqual({ delivered: false, reason: 'not_owner_scope' });
    expect(await fixture({ bodies: [] }).port.intent(input())).toEqual({ delivered: false, reason: 'body_unavailable' });
    expect(await fixture().port.intent(input({ experienceId: null }))).toEqual({ delivered: false, reason: 'no_turn' });
    expect(await fixture({ visible: false }).port.intent(input())).toEqual({ delivered: false, reason: 'turn_not_visible' });
  });
});
