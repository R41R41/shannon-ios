import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createLifecycleRequests, LIFECYCLE_OPERATOR_LABELS, type LifecycleRequestParts } from '../src/wiring/lifecycleRequest.js';
import { lifecycleRefusalLine } from '../src/surfaces/platform/voiceLifecyclePort.js';
import { parsedLifecycleRequest } from '../src/wiring/serverMinecraftBodyWiring.js';
import { createOperatorMinecraft, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import { OperatorAuditStore, operatorLifecycleAllowed } from '../src/infra/ops/store/operatorAuditStore.js';
import type { LifecycleSettlement } from '../src/wiring/minecraftLifecycleRunner.js';
import type { MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';
import type { LifecycleOutcomeReport } from '../src/wiring/lifecycleOutcomeTellingWiring.js';

// The owner's going in and out of the server (login, logout) from the mod, a Discord command and her voice: one door, the operator's.
const SERVER = 'shannon-home';
const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState =>
  ({ serverId: SERVER, observedAt: '2026-11-23T00:00:00.000Z', running: 'running', bot: 'absent', otherPlayers: 0, ...patch });

interface Door {
  calls: Array<{ value: any; hooks: any }>;
  reply: { status: number; body: unknown };
  live: boolean[];
  waitFor: Promise<void> | null;
}

function fixture(options: { state?: MinecraftLifecycleState | undefined; available?: boolean; unresolved?: boolean; operator?: boolean;
  stop?: 'ok' | 'throws' | 'none'; liveFor?: number } = {}) {
  let clock = 1_000_000, current = 'state' in options ? options.state : state();
  const lines: string[] = [], told: LifecycleOutcomeReport[] = [], stops: number[] = [];
  const door: Door = { calls: [], reply: { status: 202, body: { outcome: 'accepted', code: 'accepted', lifecycleId: 'operator:1' } }, live: [], waitFor: null };
  let liveLeft = options.liveFor ?? 0;
  const parts: LifecycleRequestParts = {
    scopeKey: 'owner', now: () => clock, log: line => lines.push(line), stopWaitMs: 50, stopStepMs: 1,
    unresolvedWaitMs: 5, unresolvedStepMs: 1,
    operator: () => (options.operator === false ? null : {
      async handle(value, hooks) {
        door.calls.push({ value, hooks });
        await door.waitFor;
        return door.reply;
      },
      async actionLive() { const live = liveLeft > 0; door.live.push(live); liveLeft -= 1; return live; },
    }),
    stop: () => (options.stop === 'none' ? null : async () => { stops.push(clock); if (options.stop === 'throws') throw new Error('stop failed'); return { stopped: [], open: 0 }; }),
    server: requested => requested ?? SERVER,
    available: () => options.available ?? true,
    status: () => current,
    unresolved: () => options.unresolved ?? false,
    told: async report => { told.push(report); },
  };
  const requests = createLifecycleRequests(parts);
  return { requests, door, lines, told, stops, advance: (ms: number) => { clock += ms; }, setState: (next: MinecraftLifecycleState | undefined) => { current = next; } };
}

const settle = (f: ReturnType<typeof fixture>, index = 0, receipt: Partial<NonNullable<LifecycleSettlement['receipt']>> | null = { outcome: 'completed' }) =>
  f.door.calls[index]!.hooks.onSettled({ receipt, issued: true } as LifecycleSettlement, 'operator:1');

describe('a request to go in or out of the server', () => {
  it('goes through the operator door as the operator does, with a label that has no colon', async () => {
    const f = fixture();
    const result = await f.requests.request({ action: 'login', via: 'mod', actor: 'RaiRai', requestId: 'abc' });
    expect(result).toEqual({ ok: true, lifecycleId: 'operator:1', state: 'accepted' });
    expect(f.door.calls[0]!.value).toEqual({ v: 1, operator: 'body-mod', domain: 'minecraft', op: 'login' });
    for (const label of Object.values(LIFECYCLE_OPERATOR_LABELS)) expect(label).toMatch(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u);
    expect(LIFECYCLE_OPERATOR_LABELS).toEqual({ mod: 'body-mod', discord_slash: 'body-discord', voice: 'voice' });
    expect(f.lines.some(line => line.includes('login via=mod actor=RaiRai server=shannon-home result=accepted id=operator:1'))).toBe(true);
  });

  it('names the server it was asked for in the envelope', async () => {
    const f = fixture({ state: state({ bot: 'joined' }) });
    await f.requests.request({ action: 'logout', via: 'discord_slash', serverId: 'other' });
    expect(f.door.calls[0]!.value).toMatchObject({ op: 'logout', operator: 'body-discord', args: { serverId: 'other' } });
  });

  describe('the table of overlapping requests', () => {
    it('folds a second login into the one under way and runs nothing twice', async () => {
      const f = fixture();
      f.door.waitFor = new Promise(() => {});
      const first = f.requests.request({ action: 'login', via: 'mod' });
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: true, state: 'pending' });
      expect(f.door.calls).toHaveLength(1);
      void first;
    });

    it('folds a second login into the one under way after it was accepted', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'mod' });
      expect(await f.requests.request({ action: 'login', via: 'voice' })).toEqual({ ok: true, lifecycleId: 'operator:1', state: 'pending' });
      expect(f.door.calls).toHaveLength(1);
    });

    it('refuses a logout while a login is under way, and a login while a logout is', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'mod' });
      expect(await f.requests.request({ action: 'logout', via: 'mod' })).toMatchObject({ ok: false, code: 'in_progress', message: 'いま入っている途中です' });
      settle(f);
      f.setState(state({ bot: 'joined' }));
      await f.requests.request({ action: 'logout', via: 'mod' });
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'in_progress', message: 'いま出ている途中です' });
      expect(f.door.calls).toHaveLength(2);
    });

    it('lets a logout through four minutes after a login that settled: no key from the earlier one answers it', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'mod' });
      settle(f);
      f.advance(240_000);
      f.setState(state({ bot: 'joined' }));
      f.door.reply = { status: 202, body: { outcome: 'accepted', code: 'accepted', lifecycleId: 'operator:2' } };
      expect(await f.requests.request({ action: 'logout', via: 'mod' })).toEqual({ ok: true, lifecycleId: 'operator:2', state: 'accepted' });
      expect(f.door.calls).toHaveLength(2);
    });

    it('forgets an operation whose settled report never came, after 120 seconds', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'mod' });
      f.advance(121_000);
      f.setState(state({ bot: 'joined' }));
      expect(await f.requests.request({ action: 'logout', via: 'mod' })).toMatchObject({ ok: true, state: 'accepted' });
      expect(f.lines.some(line => line.includes('forgotten'))).toBe(true);
    });

    it('keeps nothing pending when it settled before the door answered', async () => {
      const f = fixture();
      f.door.waitFor = Promise.resolve();
      const pendingResult = f.requests.request({ action: 'login', via: 'mod' });
      await Promise.resolve();
      settle(f);
      await pendingResult;
      f.setState(state({ bot: 'joined' }));
      expect(await f.requests.request({ action: 'logout', via: 'mod' })).toMatchObject({ ok: true, state: 'accepted' });
    });

    it('answers already without running anything', async () => {
      const f = fixture({ state: state({ bot: 'joined' }) });
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toEqual({ ok: true, lifecycleId: null, state: 'already' });
      f.setState(state({ bot: 'absent' }));
      expect(await f.requests.request({ action: 'logout', via: 'mod' })).toEqual({ ok: true, lifecycleId: null, state: 'already' });
      expect(f.door.calls).toEqual([]);
    });

    it('does not wake a stopped server, and goes on when the bot is not known', async () => {
      const f = fixture({ state: state({ running: 'stopped' }) });
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'server_not_running' });
      expect(f.door.calls).toEqual([]);
      f.setState(state({ bot: 'unknown' }));
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: true });
      expect(f.door.calls).toHaveLength(1);
    });

    it('refuses when the state is not fresh, there is no operator door, or an earlier operation is unresolved', async () => {
      expect(await fixture({ available: false }).requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'lifecycle_unavailable' });
      expect(await fixture({ operator: false }).requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'lifecycle_unavailable' });
      expect(await fixture({ unresolved: true }).requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'unresolved_operation' });
    });

    it('lets a refused request be asked again at once', async () => {
      const f = fixture();
      f.door.reply = { status: 409, body: { outcome: 'refused', code: 'lease_conflict' } };
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'lease_conflict' });
      f.door.reply = { status: 202, body: { outcome: 'accepted', lifecycleId: 'operator:3' } };
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: true, lifecycleId: 'operator:3' });
    });
  });

  describe('what the operator answers', () => {
    it.each([['disabled', 'lifecycle_unavailable'], ['flooded', 'flooded'], ['rate_limited', 'rate_limited'], ['lease_conflict', 'lease_conflict'],
      ['unresolved_operation', 'unresolved_operation'], ['something_new', 'refused']])('turns %s into %s', async (given, expected) => {
      const f = fixture();
      f.door.reply = { status: 409, body: { outcome: 'refused', code: given } };
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: expected });
    });

    it('is a refusal, not a throw, when the door fails', async () => {
      const f = fixture();
      f.door.reply = null as never;
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'refused' });
    });
  });

  describe('a logout stops the work and keeps it first', () => {
    it('stops, waits for the body to be let go, then asks the door', async () => {
      const f = fixture({ state: state({ bot: 'joined' }), liveFor: 3 });
      expect(await f.requests.request({ action: 'logout', via: 'mod' })).toMatchObject({ ok: true, state: 'accepted' });
      expect(f.stops).toHaveLength(1);
      expect(f.door.live).toEqual([true, true, true, false]);
      expect(f.door.calls).toHaveLength(1);
    });

    it('goes on to leave when the stop fails or the body stays held past the wait', async () => {
      const failed = fixture({ state: state({ bot: 'joined' }), stop: 'throws' });
      expect(await failed.requests.request({ action: 'logout', via: 'mod' })).toMatchObject({ ok: true });
      const held = fixture({ state: state({ bot: 'joined' }), liveFor: 10_000 });
      const result = held.requests.request({ action: 'logout', via: 'mod' });
      const wait = new Promise<void>(resolve => { const tick = setInterval(() => { held.advance(20); }, 1); void result.then(() => { clearInterval(tick); resolve(); }); });
      await wait;
      expect(held.door.calls).toHaveLength(1);
      expect(held.lines.some(line => line.includes('still held'))).toBe(true);
    });

    it('does not stop anything for a login', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'mod' });
      expect(f.stops).toEqual([]);
    });

    it('folds a second logout into the stop that is still being waited for', async () => {
      const f = fixture({ state: state({ bot: 'joined' }), liveFor: 3 });
      const first = f.requests.request({ action: 'logout', via: 'mod' });
      expect(await f.requests.request({ action: 'logout', via: 'mod' })).toMatchObject({ ok: true, state: 'pending' });
      expect(await f.requests.request({ action: 'login', via: 'mod' })).toMatchObject({ ok: false, code: 'in_progress', message: 'いま出ている途中です' });
      await first;
      expect(f.stops).toHaveLength(1);
      expect(f.door.calls).toHaveLength(1);
    });
  });

  describe('how a spoken request ends', () => {
    it('keeps the owner\'s Talk free of the operator\'s notice and tells the end in her words', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'voice', threadId: 'thread-1' });
      expect(f.door.calls[0]!.hooks.quiet).toBe(true);
      expect(f.door.calls[0]!.value.operator).toBe('voice');
      settle(f, 0, { outcome: 'completed' });
      await Promise.resolve();
      expect(f.told).toEqual([{ scopeKey: 'owner', threadId: 'thread-1', operationId: 'operator:1', action: 'login', outcome: 'completed' }]);
    });

    it('tells a refusal and a start that never happened as such', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'voice', threadId: 'thread-1' });
      settle(f, 0, { outcome: 'refused' });
      await Promise.resolve();
      expect(f.told[0]!.outcome).toBe('refused');
    });

    it('does not tell the end of a button press or a command, and does not quiet their notice', async () => {
      const f = fixture();
      await f.requests.request({ action: 'login', via: 'mod', threadId: 'thread-1' });
      expect(f.door.calls[0]!.hooks.quiet).toBe(false);
      settle(f);
      await Promise.resolve();
      expect(f.told).toEqual([]);
    });
  });

  describe('the voice port', () => {
    it('reads the state without waiting, with the operation under way', async () => {
      const f = fixture();
      const port = f.requests.voicePort();
      expect(port.state()).toEqual({ running: 'running', bot: 'absent', pending: null });
      await f.requests.request({ action: 'login', via: 'mod' });
      expect(port.state()).toEqual({ running: 'running', bot: 'absent', pending: 'login' });
      f.setState(undefined);
      expect(port.state()).toBeNull();
    });

    it('is not known without a fresh frame', () => {
      expect(fixture({ available: false }).requests.voicePort().state()).toBeNull();
    });

    it('checks what would be refused at once, without starting anything', () => {
      const f = fixture({ state: state({ running: 'stopped' }) });
      const port = f.requests.voicePort();
      expect(port.check('login')).toMatchObject({ ok: false, code: 'server_not_running' });
      f.setState(state());
      expect(port.check('login')).toBeNull();
      expect(f.door.calls).toEqual([]);
    });

    it('asks as a spoken request', async () => {
      const f = fixture();
      await f.requests.voicePort().request('login', { threadId: 'thread-9', actor: 'owner' });
      expect(f.door.calls[0]!.value.operator).toBe('voice');
      expect(f.lines.some(line => line.includes('via=voice actor=owner'))).toBe(true);
    });
  });
});

describe('the fixed sentence for a request refused at once', () => {
  it.each([
    [{ ok: false as const, code: 'server_not_running' as const, message: '' }, 'login', 'サーバーが動いてないから、入れないみたい。'],
    [{ ok: false as const, code: 'in_progress' as const, message: '' }, 'logout', 'まだ入ってる途中だから、ちょっと待ってね。'],
    [{ ok: false as const, code: 'in_progress' as const, message: '' }, 'login', 'まだ出てる途中だから、ちょっと待ってね。'],
    [{ ok: false as const, code: 'unresolved_operation' as const, message: '' }, 'login', '前の操作がまだ終わってないみたい。少し待ってね。'],
    [{ ok: false as const, code: 'lease_conflict' as const, message: '' }, 'logout', '前の操作がまだ終わってないみたい。少し待ってね。'],
    [{ ok: false as const, code: 'lifecycle_unavailable' as const, message: '' }, 'login', 'いまは入れないみたい。'],
    [{ ok: false as const, code: 'refused' as const, message: '' }, 'logout', 'いまは出られないみたい。'],
  ])('says the right thing for %j', (refused, action, text) => {
    expect(lifecycleRefusalLine(refused, action as 'login' | 'logout')).toBe(text);
  });
});

describe('the request the body\'s process sends', () => {
  it('takes exactly the contract\'s shape', () => {
    expect(parsedLifecycleRequest({ action: 'login', via: 'mod' })).toEqual({ action: 'login', via: 'mod' });
    expect(parsedLifecycleRequest({ action: 'logout', via: 'discord_slash', serverId: 'shannon-home', actor: 'RaiRai', requestId: 'r-1' }))
      .toEqual({ action: 'logout', via: 'discord_slash', serverId: 'shannon-home', actor: 'RaiRai', requestId: 'r-1' });
  });
  it.each([
    [null], [[]], [{ action: 'start', via: 'mod' }], [{ action: 'login', via: 'voice' }], [{ action: 'login' }],
    [{ action: 'login', via: 'mod', extra: 1 }], [{ action: 'login', via: 'mod', serverId: 'bad id' }],
    [{ action: 'login', via: 'mod', actor: 'a\u0007b' }], [{ action: 'login', via: 'mod', actor: 'x'.repeat(65) }],
    [{ action: 'login', via: 'mod', requestId: '' }], [{ action: 'login', via: 'mod', actor: 7 }],
  ])('refuses %j', value => {
    expect(parsedLifecycleRequest(value)).toBeNull();
  });
});

// The operator door itself: the audit's shape, the label, and the two hooks (`handle(value, hooks)`).
describe('the operator door for a login or a logout', () => {
  function door() {
    const db = new DatabaseSync(':memory:'), audit = new OperatorAuditStore(db);
    const notes: string[] = [];
    const calls: Array<{ id: string; action: string; serverId: string }> = [];
    let settle: ((value: LifecycleSettlement) => void) | null = null;
    const parts: OperatorMinecraftParts = {
      scopeKey: 'owner', enabled: () => true, ownerAlone: () => false, now: () => '2026-11-23T00:00:00.000Z', audit,
      gameOnlyAvailable: () => false,
      lifecycle: { servers: [SERVER], server: (requested: string | null) => requested ?? SERVER,
        execute: async (request: { id: string; action: string; serverId: string }, settled: (value: LifecycleSettlement) => void) => {
          calls.push(request); settle = settled;
          return { ok: true as const, lifecycleId: request.id, actionId: 'action-1' };
        } } as unknown as OperatorMinecraftParts['lifecycle'],
      requests: null, actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'],
      lifecycleUnresolved: () => false, activity: () => {}, note: (_id, text) => notes.push(text),
    };
    return { operator: createOperatorMinecraft(parts), db, audit, notes, calls, settle: (value: LifecycleSettlement) => settle?.(value) };
  }
  const envelope = (operator: string, op: string) => ({ v: 1, operator, domain: 'minecraft', op, args: {} });

  it('writes the audit the operator\'s authority reads: lifecycle, invoked, the action, for a mod\'s login', async () => {
    const d = door();
    const answer = await d.operator.handle(envelope('body-mod', 'login'));
    const id = (answer.body as { operationId: string }).operationId;
    expect(answer.body).toMatchObject({ outcome: 'accepted', lifecycleId: id });
    const rows = d.audit.operation(id);
    expect(rows.map(row => row.event)).toEqual(['invoked', 'accepted']);
    expect(rows[0]).toMatchObject({ command: 'lifecycle', action: 'login', operator: 'body-mod' });
    expect(operatorLifecycleAllowed(d.db, 'owner', id, { serverId: SERVER, action: 'login' })).toBe(true);
    expect(operatorLifecycleAllowed(d.db, 'owner', id, { serverId: SERVER, action: 'logout' })).toBe(false);
  });

  it('refuses a label with a colon: it is not one (the audit would say unknown)', async () => {
    const d = door();
    const answer = await d.operator.handle(envelope('body:mod', 'login'));
    expect(answer.body).toMatchObject({ outcome: 'refused', code: 'invalid_input' });
    expect(d.calls).toEqual([]);
  });

  it('calls onSettled after the settled row is written, with the operation id, and notes in Talk unless quiet', async () => {
    const quiet = door(), loud = door();
    const seen: Array<{ id: string; events: string[] }> = [];
    for (const [d, hooks] of [[quiet, { quiet: true, onSettled: (_s: LifecycleSettlement, id: string) => seen.push({ id, events: quiet.audit.operation(id).map(row => row.event) }) }],
      [loud, undefined]] as const) {
      await d.operator.handle(envelope('voice-owner', 'login'), hooks);
      d.settle({ receipt: { outcome: 'completed', code: 'changed' } as never, issued: true });
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.events).toEqual(['invoked', 'accepted', 'settled']);
    expect(quiet.notes).toEqual([]);
    expect(loud.notes).toHaveLength(1);
  });

  it('is not stopped by a hook that throws', async () => {
    const d = door();
    await d.operator.handle(envelope('body-mod', 'logout'), { onSettled: () => { throw new Error('boom'); } });
    expect(() => d.settle({ receipt: null, issued: false })).not.toThrow();
  });
});
