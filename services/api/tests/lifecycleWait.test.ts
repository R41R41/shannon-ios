import { describe, expect, it } from 'vitest';
import { createOperatorLifecycle } from '../src/wiring/operatorLifecycleWiring.js';
import { createLifecycleRunner, type LifecycleRunner } from '../src/wiring/minecraftLifecycleRunner.js';
import { createLifecycleRequests, type LifecycleRequestParts } from '../src/wiring/lifecycleRequest.js';
import { LIFECYCLE_BODY_WAIT_MS, LIFECYCLE_UNRESOLVED_WAIT_MS, waitWhileBlocked } from '../src/wiring/lifecycleWait.js';
import type { MinecraftLifecycle } from '../src/surfaces/minecraft/minecraftLifecycle.js';
import type { ActionThreads } from '../src/contracts/actionThreadContract.js';
import type { MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';

// Minecraft run 2026-11-23 17:39: the owner's "logout" was refused with `lease_conflict` right after her plan was stopped (the body was held
// for a moment more), and two seconds after it went through the operator's own logout was refused with `unresolved_operation` (the receipt of
// the one just finished was not written yet). Both clear within seconds, so the three doors and the body's claim look again for a short while.
// They only wait: what still blocks after the wait is refused as before, with the same words.
const ID = 'operator:0a1b2c3d-1111-4222-8333-444455556666';
const state: MinecraftLifecycleState = { serverId: 'shannon-home', observedAt: '2026-11-23T08:39:00.000Z', running: 'running', bot: 'joined', otherPlayers: 0 };
const WAITS = { unresolvedMs: 400, bodyMs: 400, stepMs: 5 };

describe('the waits are a few seconds, not a gate', () => {
  it("keeps both limits well inside the operator CLI's 30 s reply, with set_day's 12 s", () => {
    expect(LIFECYCLE_UNRESOLVED_WAIT_MS + LIFECYCLE_BODY_WAIT_MS + 12_000).toBeLessThan(30_000);
  });
  it('reports whether a block cleared in time', async () => {
    let left = 3;
    expect(await waitWhileBlocked(() => left-- > 0, 500, 2)).toBe(true);
    expect(await waitWhileBlocked(() => true, 20, 2)).toBe(false);
  });
});

describe("the operator's door (CLI) waits for an unresolved operation", () => {
  function operator(unresolved: () => boolean) {
    const admitted: unknown[] = [];
    const service = { available: () => true, status: () => [state], store: { unresolved } } as unknown as MinecraftLifecycle;
    const runner = { admit: async (draft: unknown) => { admitted.push(draft); return { execution: { lease: { id: 'own', generation: 1, holder: 'h' } }, finish: async () => {} }; },
      takeBody: async () => true, detach: () => Promise.resolve() } as unknown as LifecycleRunner;
    const door = createOperatorLifecycle({ service, runner, scopeKey: 'owner', serverIds: ['shannon-home'], ownerAlone: () => true, allowed: () => true, waits: WAITS });
    return { admitted, run: () => door.execute({ id: ID, serverId: 'shannon-home', action: 'logout' }, () => {}) };
  }

  it('goes through when the receipt of the earlier operation is written during the wait', async () => {
    const started = Date.now();
    const f = operator(() => Date.now() - started < 60);
    expect(await f.run()).toMatchObject({ ok: true, lifecycleId: ID });
    expect(f.admitted).toHaveLength(1);
  });

  it('answers as before, in the same words, when it stays unresolved past the limit', async () => {
    const f = operator(() => true);
    const started = Date.now();
    expect(await f.run()).toEqual({ ok: false, code: 'unresolved_operation', message: '前のマイクラ管理操作の結果がまだ確認できていません。' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAITS.unresolvedMs - 20);
    expect(f.admitted).toEqual([]);
  });

  it('does not wait at all when nothing is unresolved', async () => {
    const started = Date.now();
    expect(await operator(() => false).run()).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(WAITS.unresolvedMs);
  });
});

describe('the claim of the body and the slot waits for the hold of the work the logout stopped', () => {
  function runnerOf(options: { dispatchAfter: number; claimAfter?: number }) {
    let dispatches = 0, claims = 0;
    const finished: string[] = [], withdrawn: string[] = [];
    const view = { id: 'own', generation: 1, holder: 'h', kind: 'minecraft', state: 'queued', sourceId: ID };
    const actions = {
      enqueue: async () => ({ id: 'own' }),
      claim: async () => (claims++ >= (options.claimAfter ?? 0) ? view : null),
      list: async () => [{ ...view }], stop: async (_scope: string, id: string) => { withdrawn.push(id); },
      renew: async () => view, checkpoint: async () => true,
      dispatch: async () => dispatches++ >= options.dispatchAfter,
    } as unknown as ActionThreads;
    const runner = createLifecycleRunner({ actions, service: {} as MinecraftLifecycle, deviceId: 'device' })!;
    const own = { execution: { lease: { id: 'own', generation: 1, holder: 'h' } }, finish: async (_s: string, code: string) => { finished.push(code); } } as never;
    const draft = { scopeKey: 'owner', kind: 'minecraft' as const, origin: 'owner_request' as const, sourceId: ID, ownerInformed: true };
    return { runner, own, draft, finished, withdrawn, count: () => ({ dispatches, claims }) };
  }
  const wait = { ms: 400, stepMs: 5 };

  it("takes the body once the plan's hold is let go", async () => {
    const f = runnerOf({ dispatchAfter: 4 });
    expect(await f.runner.takeBody(f.own, undefined, wait)).toBe(true);
    expect(f.count().dispatches).toBe(5);
    expect(f.finished).toEqual([]);
  });

  it('closes the operation as never started, as before, when the body is still held after the limit', async () => {
    const f = runnerOf({ dispatchAfter: Infinity });
    expect(await f.runner.takeBody(f.own, undefined, { ms: 40, stepMs: 5 })).toBe(false);
    expect(f.finished).toEqual(['lifecycle_body_unavailable']);
    expect(f.count().dispatches).toBeGreaterThan(2);
  });

  it('asks once and refuses at once without a wait (the old behaviour)', async () => {
    const f = runnerOf({ dispatchAfter: Infinity });
    expect(await f.runner.takeBody(f.own)).toBe(false);
    expect(f.count().dispatches).toBe(1);
  });

  it('claims the slot after the operation that just ended lets it go, withdrawing each refused claim', async () => {
    const f = runnerOf({ dispatchAfter: 0, claimAfter: 3 });
    const own = await f.runner.admit(f.draft, true, wait);
    expect(own).not.toBeNull();
    expect(f.count().claims).toBe(4);
    expect(f.withdrawn).toHaveLength(3);
    own!.stop();
  });

  it('returns null, as before, when the slot stays taken after the limit', async () => {
    const f = runnerOf({ dispatchAfter: 0, claimAfter: Infinity });
    expect(await f.runner.admit(f.draft, true, { ms: 40, stepMs: 5 })).toBeNull();
    const once = runnerOf({ dispatchAfter: 0, claimAfter: Infinity });
    expect(await once.runner.admit(once.draft, true)).toBeNull();
    expect(once.count().claims).toBe(1);
  });
});

describe('a request from the mod, Discord or her voice waits for an unresolved operation', () => {
  function fixture(unresolved: () => boolean, current: () => MinecraftLifecycleState = () => ({ ...state, bot: 'joined' })) {
    const calls: unknown[] = [];
    const parts: LifecycleRequestParts = {
      scopeKey: 'owner', log: () => {}, stopWaitMs: 5, stopStepMs: 1, unresolvedWaitMs: 400, unresolvedStepMs: 5,
      operator: () => ({ async handle(value) { calls.push(value); await new Promise(resolve => setTimeout(resolve, 30)); return { status: 202, body: { outcome: 'accepted', lifecycleId: ID } }; },
        async actionLive() { return false; } }),
      stop: () => async () => ({ stopped: [], open: 0 }),
      server: requested => requested ?? 'shannon-home', available: () => true, status: current, unresolved,
    };
    return { requests: createLifecycleRequests(parts), calls };
  }

  it('goes through when the earlier receipt is written during the wait', async () => {
    const started = Date.now();
    const f = fixture(() => Date.now() - started < 60);
    expect(await f.requests.request({ action: 'logout', via: 'mod' })).toEqual({ ok: true, lifecycleId: ID, state: 'accepted' });
    expect(f.calls).toHaveLength(1);
  });

  it('answers the same word as before, at the limit, when it stays unresolved', async () => {
    const f = fixture(() => true);
    const started = Date.now();
    expect(await f.requests.request({ action: 'logout', via: 'mod' })).toMatchObject({ ok: false, code: 'unresolved_operation', message: '前のマイクラ管理操作の結果がまだ確認できていません。' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(f.calls).toEqual([]);
  });

  it('folds a second press of the same direction made while waiting into the first (pending), without a second operation', async () => {
    const started = Date.now();
    const f = fixture(() => Date.now() - started < 60);
    const [first, second] = await Promise.all([f.requests.request({ action: 'logout', via: 'mod' }), f.requests.request({ action: 'logout', via: 'discord_slash' })]);
    expect([first, second].map(result => (result.ok ? result.state : result.code)).sort()).toEqual(['accepted', 'pending']);
    expect(f.calls).toHaveLength(1);
  });

  it('answers the other direction made while waiting as in progress, not as unresolved', async () => {
    const started = Date.now();
    const f = fixture(() => Date.now() - started < 60, () => ({ ...state, bot: 'unknown' }));
    const [first, second] = await Promise.all([f.requests.request({ action: 'logout', via: 'mod' }), f.requests.request({ action: 'login', via: 'voice' })]);
    // Whichever look comes first after the receipt is written goes on; the other direction is then in progress.
    expect([first, second].filter(result => result.ok)).toHaveLength(1);
    expect([first, second].find(result => !result.ok)).toMatchObject({ code: 'in_progress' });
  });

  it('lets the voice go on to its waiting request instead of refusing an unresolved one at once', async () => {
    const f = fixture(() => true);
    expect(f.requests.voicePort().check('logout')).toBeNull();
    const started = Date.now();
    expect(await f.requests.voicePort().request('logout', {})).toMatchObject({ ok: false, code: 'unresolved_operation' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    // Everything else the voice's check answers at once is unchanged.
    expect(fixture(() => false, () => ({ ...state, bot: 'absent' })).requests.voicePort().check('logout')).toEqual({ ok: true, lifecycleId: null, state: 'already' });
  });

  it('says already when the body has left while waiting', async () => {
    const started = Date.now();
    const f = fixture(() => Date.now() - started < 60, () => ({ ...state, bot: Date.now() - started < 60 ? 'joined' : 'absent' }));
    expect(await f.requests.request({ action: 'logout', via: 'mod' })).toEqual({ ok: true, lifecycleId: null, state: 'already' });
    expect(f.calls).toEqual([]);
  });
});
