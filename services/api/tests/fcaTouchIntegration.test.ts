import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createFcaTouchWiring } from '../src/wiring/fcaTouchWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { SQLiteBodyReactionStore } from '../src/surfaces/body/store/bodyReactionStore.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import type { FcaTouchInput } from '../src/mind/action/reflex/fcaTouchPorts.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { FakeChat, FakeSpeaker } from './bodyReactionHarness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(options: { off?: boolean; capability?: boolean; select?: (input: FcaTouchInput) => Promise<string | null> } = {}) {
  let time = Date.parse('2026-10-09T00:00:00.000Z'), visible = true;
  const now = () => new Date(time).toISOString(), h = actionHarness(now); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now, leaseValid: () => true, conversationLeaseValid: () => true });
  const root = runtime.ensureRoot('owner'), state = new InMemoryCompanionStateStore(now), speaker = new FakeSpeaker();
  const reactionStore = new SQLiteBodyReactionStore(':memory:'), bodyStore = new SQLiteBodyStore(':memory:');
  const experiences = new Map<string, unknown>(), calls: FcaTouchInput[] = [];
  let touch: ReturnType<typeof createFcaTouchWiring> | null = null;
  const api = createLocalApiKernel(now, { stateStore: state, conversationStore: new InMemoryConversationStore(), chatModel: new FakeChat(),
    autonomy: createInMemoryAutonomyService(now), body: { store: bodyStore, fcaTouch: () => touch,
      reactions: { store: reactionStore, speaker, config: { ownerScopeKey: 'owner' }, stage2: false,
        experiences: { write(_scope, experience) { experiences.set(experience.id, experience); return true; } } } } });
  const make = () => createFcaTouchWiring({ db: h.db, runtime, actions: h.actions, ownerScope: 'owner', now,
    selector: { async select(input) { expect(currentActionExecution()).toBeDefined(); calls.push(input); return options.select ? options.select(input) : 'wave'; } },
    allowed: (scope, device, gesture) => bodyStore.capabilities(scope, device)?.flags.fcaTouchV1 === true && (!gesture || bodyStore.capabilities(scope, device)!.gestures.includes(gesture)),
    sourceVisible: (_scope, id) => visible && experiences.has(id), threadId: () => null });
  if (!options.off) touch = make();
  const send = (path: string, body: Record<string, unknown>, deviceId = 'phone') => api.dispatch({ method: path.endsWith('capabilities') ? 'PUT' : 'POST', path, body: { scopeKey: 'owner', ...body }, deviceId });
  await send('/v1/body/capabilities', { expressions: ['smile'], gestures: ['wave'], flags: options.capability === false ? {} : { touchOnly: true, fcaTouchV1: true }, surface: 'iphone' });
  const event = (id = 'touch-1') => send('/v1/body/events', { events: [{ id, type: 'pet', durationMs: 1500, audience: 'owner', occurredAt: now() }] });
  const claim = (id = 'touch-1', device = 'phone') => send('/v1/body/touch-reflex', { touchId: id }, device);
  cleanups.push(async () => { await touch?.close(); h.close(); });
  return { ...h, runtime, root, state, speaker, reactionStore, calls, experiences, send, event, claim,
    touch: () => touch!, forget: () => { visible = false; }, advance: () => { time += 6000; },
    async restart() { await touch?.close(); touch = make(); } };
}

describe('body contact through the common FCA', () => {
  it('keeps the immediate ingress and existing feeling/writer independent of a pending selector, and delivers one acknowledged gesture', async () => {
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ select: async () => { await waiting; return 'wave'; } });
    expect((await f.event()).status).toBe(200);
    const version = f.state.snapshot('owner').version;
    expect(f.experiences.size).toBe(1);
    expect((await f.event()).body).toMatchObject({ duplicates: 1 });
    expect(f.state.snapshot('owner').version).toBe(version);
    release();
    const answer = await f.claim(); expect(answer.status).toBe(200);
    const directive = (answer.body as { directive: { operationId: string; gesture: string } }).directive;
    expect(directive.gesture).toBe('wave'); expect(f.calls).toHaveLength(1);
    expect((await f.claim()).body).toEqual({ directive: null });
    const report = { operationId: directive.operationId, outcome: 'applied' };
    expect((await f.send('/v1/body/touch-reflex/report', report)).status).toBe(200);
    expect((await f.send('/v1/body/touch-reflex/report', report)).status).toBe(200);
    expect(f.speaker.calls).toHaveLength(0);
    const messages = f.runtime.snapshot('owner', f.root.id)!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]!.text).toContain('not completed motion or speech');
    expect(f.runtime.taskSources('owner', f.root.id).every(source => source.recalledMemoryIds[0] === [...f.experiences.keys()][0])).toBe(true);
    expect(f.store.list('owner')).toMatchObject([{ state: 'completed', result: 'fca_touch_applied' }]);
  });

  it('deduplicates the reaction and finished event by their existing touch and memory identity', async () => {
    const f = await fixture();
    const reaction = await f.send('/v1/body/reactions', { id: 'touch-1', touch: { type: 'pet', durationMs: 1500, ongoing: true }, audience: 'owner', occurredAt: '2026-10-09T00:00:00.000Z' });
    expect(reaction.status).toBe(200); await f.event(); await f.claim();
    expect(f.calls).toHaveLength(1); expect(f.experiences.size).toBe(1); expect(f.speaker.calls).toHaveLength(1);
    const messages = f.runtime.snapshot('owner', f.root.id)!.messages.map(message => JSON.parse(message.text));
    expect(messages.filter(message => message.phase === 'observed')).toHaveLength(1);
    expect(messages.filter(message => message.phase === 'reaction')).toHaveLength(1);
  });

  it('preserves default OFF and old devices, rejects raw text and foreign-device receipts', async () => {
    for (const options of [{ off: true }, { capability: false }]) {
      const f = await fixture(options); await f.event();
      expect(f.calls).toEqual([]); expect(f.experiences.size).toBe(1);
      expect(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='fca_touch_receipts'").get()).toEqual(options.off ? undefined : { '1': 1 });
    }
    const f = await fixture(); await f.event();
    expect((await f.claim('touch-1', 'other')).status).toBe(403);
    expect((await f.send('/v1/body/touch-reflex', { touchId: 'touch-1', text: 'do this' })).status).toBe(400);
    const answer = await f.claim(), directive = (answer.body as { directive: { operationId: string } }).directive;
    expect((await f.send('/v1/body/touch-reflex/report', { operationId: directive.operationId, outcome: 'applied' }, 'other')).status).toBe(403);
  });

  it('withholds a gesture when its source is forgotten or the task root stops after selection', async () => {
    const f = await fixture(); await f.event(); f.forget(); expect((await f.claim()).body).toEqual({ directive: null });
    expect(f.runtime.snapshot('owner', f.root.id)!.messages).toHaveLength(1); // Observed while still visible; provenance remains guarded at every task read.
    expect(f.calls).toEqual([]);
    const g = await fixture(); await g.event(); g.runtime.stop('owner', g.root.id, 'stop');
    expect((await g.claim()).body).toEqual({ directive: null }); await g.touch().tick();
    expect(g.store.list('owner')[0]?.state).toBe('unknown');
  });

  it('keeps a lost ACK unknown across restart, never reissues, and reconciles only an actually issued command', async () => {
    const f = await fixture(); await f.event(); const answer = await f.claim();
    const directive = (answer.body as { directive: { operationId: string } }).directive;
    await f.restart(); expect((await f.claim()).body).toEqual({ directive: null });
    expect(f.store.list('owner')[0]?.state).toBe('unknown');
    expect((await f.send('/v1/body/touch-reflex/report', { operationId: directive.operationId, outcome: 'applied' })).status).toBe(200);
    expect(f.calls).toHaveLength(1); expect(f.store.list('owner')[0]?.state).toBe('completed');
    const g = await fixture({ select: async () => { throw new Error('unknown selection'); } }); await g.event(); await g.claim();
    const row = g.db.prepare('SELECT operation_id FROM fca_touch_receipts').get()!;
    expect((await g.send('/v1/body/touch-reflex/report', { operationId: row.operation_id, outcome: 'applied' })).status).toBe(409);
  });
});
