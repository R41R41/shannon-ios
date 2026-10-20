import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { WorkingEventLog } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import { minecraftCommandId } from '../src/surfaces/minecraft/minecraftWorkingArbiter.js';
import { withMinecraftWorking } from '../src/surfaces/minecraft/minecraftWorkingBody.js';
import type { TaskRuntime, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

/** mb-arch stage 1: the working body's watch cuts a stalled command through the arbiter, ends the decision, and tells the task why. */
const at = new Date().toISOString();
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: 1, stateAt: at, receivedAt: at,
  connected: true, state: { world: { dimension: 'overworld', health: 20, food: 20, margin: { darkInSeconds: 300 }, inventory: [], nearbyThreats: [], ...world } },
  facts: { dimension: 'overworld', danger: false } } as unknown as BodyObservation);

function fixture(workingEvents: boolean, world: Record<string, unknown> = {}) {
  const log = new WorkingEventLog();
  const sent: Array<{ text: string; id: string }> = [], lines: string[] = [];
  const control = { store: { body: () => 'minecraft:home', bind: () => true, safe: () => true }, available: () => ['minecraft:home'],
    frame: () => ({ poll: { skills: [{ name: 'move-to', readOnly: false }] } }), observe: () => frame(world), working: () => log,
    imagesUnavailable: () => false, settling: () => false, cancelTask() {} } as unknown as MinecraftControl;
  const step = { id: 'step', scopeKey: 'owner', taskId: `task-${Math.random()}`, revision: 1, lease: { id: 'lease', holder: 'h', generation: 1 },
    snapshot: { task: { createdAt: at, summary: '' }, checkpoint: { consecutiveToolFailures: 0 }, history: [], sources: [] } } as unknown as TaskStep;
  const runtime = { get: () => ({ phase: 'executing' }), send: (_s: string, _t: string, _to: string, text: string, id: string) => { sent.push({ text, id }); } } as unknown as TaskRuntime;
  const made = withMinecraftWorking(createMinecraftTaskBody({ control, runtime, step, entry: null, selector: null, ownerAlone: () => true,
    sourcesVisible: () => true, pollMilliseconds: 5, log: line => lines.push(line) }),
  { on: workingEvents, control, runtime, step, pollMilliseconds: 5, log: line => lines.push(line) });
  return { log, made, sent, lines };
}
const lease = { id: 'lease', holder: 'h', generation: 1 };

describe('Minecraft body with the working events (mb-arch stage 1)', () => {
  it('cuts a command the body says got nowhere for 20 s: the tool is aborted, the decision goes stale, the task is told why', async () => {
    const f = fixture(true), abort = new AbortController();
    await inActionExecution({ lease, signal: abort.signal, permit: async () => true } as never, async () => {
      f.made.body.start(abort.signal);
      const version = f.made.body.revision();
      const signal = f.made.body.toolSignal!('mc.move-to', abort.signal);
      f.made.body.noteCall!({ id: 'a', name: 'mc.move-to', input: { x: 57, y: 58, z: -3 } }, 'step:operation:1');
      await delay(20);
      expect(signal.aborted).toBe(false);
      expect(await f.made.body.guard(version)).toBe(true);
      f.log.take('c1', [{ seq: 1, at, kind: 'action.stalled', subject: minecraftCommandId('step:operation:1'),
        data: { skill: 'move-to', measure: 'target', elapsedMs: 22_000, sinceProgressMs: 21_000, distance: 20.5 } }]);
      await delay(30);
      expect(signal.aborted).toBe(true);
      expect(f.made.body.revision()).toBeGreaterThan(version);
      expect(await f.made.body.guard(version)).toBe(false);
      expect(JSON.parse(f.sent[0]!.text)).toMatchObject({ kind: 'body.working_cut', rule: 'stalled', tool: 'mc.move-to' });
      expect(f.lines.some(line => line.startsWith('Shannon Minecraft working cut'))).toBe(true);
      abort.abort();
    });
    await f.made.body.close();
  });

  it('tells the decision the needs in reach and the events, and with the switch off, nothing of it', async () => {
    const needs = [{ id: 'iron:b:50,43,-1', need: 'iron', name: 'iron_ore', position: { x: 50, y: 43, z: -1 }, distance: 16, canReach: true }];
    for (const on of [true, false]) {
      const f = fixture(on, { nearbyNeeds: needs }), abort = new AbortController();
      await inActionExecution({ lease, signal: abort.signal, permit: async () => true } as never, async () => {
        f.made.body.start(abort.signal);
        f.log.take('c1', [{ seq: 1, at, kind: 'need.appeared', subject: 'iron:b:50,43,-1', data: { need: 'iron', name: 'iron_ore', distance: 16, canReach: true } }]);
        const context = f.made.body.context() as { working?: { needs?: string; events?: string[] } };
        if (on) {
          expect(context.working?.needs).toMatch(/^近くに要る物（届く）: 鉄鉱石16m。/u);
          expect(context.working?.events).toEqual(['見えた: iron_ore（iron）16m']);
        } else expect(context.working).toBeUndefined();
        abort.abort();
      });
      await f.made.body.close();
    }
  });
});
