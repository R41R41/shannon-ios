import { afterEach, describe, expect, it } from 'vitest';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import type { BodyObservation, BodyPlanView } from '../src/contracts/bodyControlContract.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModelContract.js';
import { actionPermit, currentActionExecution, inActionExecution } from '../src/infra/context/actionExecution.js';
import type { FcaBodyLifecycle } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { withMinecraftLive } from '../src/surfaces/minecraft/minecraftLiveBody.js';
import { configuredMinecraftLive } from '../src/wiring/minecraftLiveWiring.js';
import { acquireAction } from '../src/wiring/actionExecutionWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * Her live word is written by a model call that is no part of any task step. These build the production pieces together (the lease and
 * permit of `acquireAction`, the live view and commentary of `configuredMinecraftLive`, the body wrapper `withMinecraftLive` a task step
 * runs in) and replace only the model's network: the fake model asks `actionPermit()` first, as the Anthropic and OpenAI adapters do.
 */
const ON = { SHANNON_MINECRAFT_LIVE: 'on', SHANNON_MINECRAFT_LIVE_SPEECH: 'on' };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const node = (id: string, title: string, state: 'done' | 'continue' = 'continue') => ({ id, parentId: null, title, state });
const view = (revision: number, current: string | null, nodes: BodyPlanView['nodes']): BodyPlanView => ({ revision, current, nodes });
const frame = (sequence: number): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence, stateAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(), connected: true, state: { world: { dimension: 'overworld', health: 20, food: 20, time: '3000', inventory: [] } },
  facts: { alive: true, dimension: 'overworld' } });

class Writer implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'fake';
  readonly stopped: string[] = [];
  readonly written: string[] = [];
  /** Whether each call ran inside some task step's action execution. */
  readonly inside: boolean[] = [];
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.inside.push(currentActionExecution() !== undefined);
    try { await actionPermit(); } catch (error) { this.stopped.push(error instanceof Error ? error.message : 'error'); throw error; }
    const reply = `言葉${this.written.length}、${request.systemPrompt.length}`;
    this.written.push(reply);
    return { mode: this.mode, model: this.model, reply };
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()));

async function scene(options: { human?: boolean; phase?: () => string | null } = {}) {
  const h = actionHarness(() => new Date().toISOString()); cleanups.push(h.close);
  const wiring = configuredMinecraftLive(ON)!, model = new Writer();
  const store = { snapshot: () => ({}) as CompanionStateSnapshot, appendNoteOnce: () => ({}) as never };
  const commentary = wiring.startCommentary({ scopeKey: 'owner', model, store, log: () => {} })!;
  cleanups.push(() => wiring.stop());
  // The body told its room just now (she is in a voice channel); refreshed as each poll would.
  let human = options.human === true;
  const room = () => wiring.outbox.receive([], { voice: true, humanSpeaking: human, sinceHumanMs: human ? 500 : null });
  room();
  const keepRoom = setInterval(room, 2_000); cleanups.push(() => clearInterval(keepRoom));
  const control = { store: { body: () => 'minecraft:world' }, available: () => ['minecraft:world'] } as never;
  const inner = { start() {}, revision: () => 1, context: () => ({ revision: 1, observation: null }), close: async () => {} } as unknown as FcaBodyLifecycle;
  const step = { id: 's', scopeKey: 'owner', taskId: 'task', lease: { id: 'x', holder: 'x', generation: 0 }, revision: 1, messageIds: [],
    snapshot: { task: { goal: 'ケーキを作る', origin: 'owner_request', createdAt: new Date().toISOString() }, checkpoint: null } } as unknown as TaskStep;
  let plan: BodyPlanView | undefined;
  const body = withMinecraftLive({ body: inner }, { live: wiring.live, control, step, plan: () => plan, ...(options.phase ? { phase: options.phase } : {}) }).body;
  /** A task step as the runtime runs it: its action is acquired, its work runs in that action's execution, then it is finished. */
  async function runStep(work: () => Promise<void>) {
    const active = (await acquireAction(h.actions, { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: `task-${Math.random()}` }))!;
    cleanups.push(active.stop);
    await inActionExecution(active.execution, work);
    await active.finish('completed', 'done');
  }
  const setPlan = (next: BodyPlanView) => { plan = next; };
  return { wiring, commentary, model, body, runStep, setPlan, speak: (on: boolean) => { human = on; room(); } };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** A decision of the step: the plan moves on, and her body wrapper reads it after `plan.update`. */
const decide = (f: Scene, revision: number, current: string, done: string[]) => {
  f.body.context();
  f.setPlan(view(revision, current, ['a', 'b', 'c'].map(id => node(id, `手順${id}`, done.includes(id) ? 'done' : 'continue'))));
  f.body.noteResult?.({ name: 'plan.update', input: {} } as never, { ok: true, text: '' } as never, 1);
};

describe('her live word is written outside the task step that gave rise to it', () => {
  it('writes for a moment that arrives while the step runs and stays open', async () => {
    const f = await scene();
    await f.runStep(async () => { decide(f, 1, 'a', []); await delay(400); });
    await delay(200);
    expect(f.model.inside).toEqual([false]);
    expect(f.model.stopped).toEqual([]);
    expect(f.model.inside).not.toContain(true);
    expect(f.commentary.stats().queued).toBe(1);
  });

  it('writes for a moment that arrives just before the step ends', async () => {
    const f = await scene();
    await f.runStep(async () => { decide(f, 1, 'a', []); });
    await delay(600);
    expect(f.model.stopped).toEqual([]);
    expect(f.model.inside).not.toContain(true);
    expect(f.commentary.stats().queued).toBe(1);
  });

  it('writes for a moment that arrives after the step ended, when nothing of a step is around it (a poll)', async () => {
    const f = await scene();
    await f.runStep(async () => { f.body.context(); });
    f.wiring.live.thought('task', 'ケーキには小麦がいるから先に畑かな');
    await delay(600);
    expect(f.model.stopped).toEqual([]);
    expect(f.model.inside).not.toContain(true);
    expect(f.commentary.stats().queued).toBe(1);
  });

  it('writes for a moment of a step that ended while someone was talking, once they stop', async () => {
    const f = await scene({ human: true });
    await f.runStep(async () => { decide(f, 1, 'a', []); });
    await delay(300);
    expect(f.model.written).toEqual([]);
    f.speak(false);
    await delay(7_000);
    expect(f.model.stopped).toEqual([]);
    expect(f.model.inside).not.toContain(true);
    expect(f.commentary.stats().queued).toBe(1);
  }, 20_000);

  it('writes the end of the request, told from a frame of a poll, while a wait begun in a step is still pending', async () => {
    let phase: string | null = null;
    const f = await scene({ human: true, phase: () => phase });
    f.wiring.live.frame('minecraft:world', frame(0), { newConnection: true });
    await f.runStep(async () => { decide(f, 1, 'a', []); });
    await delay(300);
    // The step is over; the moment it gave is held (someone is talking), and the commentary's retry timer is running.
    await f.runStep(async () => { f.body.context(); await f.body.close(); });
    phase = 'completed';
    f.wiring.live.frame('minecraft:world', frame(1), { newConnection: false });
    await delay(300);
    f.speak(false);
    await delay(7_000);
    expect(f.model.stopped).toEqual([]);
    expect(f.model.inside).not.toContain(true);
    expect(f.commentary.stats().queued).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
