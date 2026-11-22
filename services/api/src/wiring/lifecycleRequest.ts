import { setTimeout as delay } from 'node:timers/promises';
import type { MinecraftLifecycleAction, MinecraftLifecycleState } from '../contracts/minecraftLifecycleContract.js';
import type { LifecycleOutcomeTeller } from './lifecycleOutcomeTellingWiring.js';
import type { OperatorHandleHooks } from './operatorMinecraftCommandRequests.js';
import { settledOutcome } from './minecraftLifecycleWiring.js';
import type { LifecycleRequestAction, LifecycleRequestCode, LifecycleRequestResult, VoiceLifecyclePort } from '../surfaces/platform/voiceLifecyclePort.js';
export type { LifecycleRequestAction, LifecycleRequestCode, LifecycleRequestResult, VoiceLifecyclePort } from '../surfaces/platform/voiceLifecyclePort.js';

/**
 * The owner's own going in and out of the server (login, logout), asked from the game mod's button, a Discord command, or her own voice.
 * One door for all of them: the operator's (`OperatorMinecraft.handle`, the one `opsCli` uses), so the audit row (`lifecycle`/`invoked`/the
 * action), the authority, the rate and the activity record are exactly the ones the command line gets. This file adds only what a
 * person pressing a button needs on top: one operation at a time per server, the work left running stopped before she leaves, and a
 * word back when it ends.
 */
export type LifecycleRequestVia = 'mod' | 'discord_slash' | 'voice';


export interface LifecycleRequestInput {
  action: LifecycleRequestAction;
  serverId?: string | undefined;
  via: LifecycleRequestVia;
  /** Who asked, for the log only (never the audit: the operator's envelope has no place for it). */
  actor?: string | undefined;
  /** The caller's own id, for the log only. */
  requestId?: string | undefined;
  /** The Talk a spoken request was made in: where its end is told (voice only). */
  threadId?: string | null | undefined;
}

/** The operator's label of each way in (a label: `[A-Za-z0-9._@-]`, no colon). */
export const LIFECYCLE_OPERATOR_LABELS: Readonly<Record<LifecycleRequestVia, string>> = Object.freeze({
  mod: 'body-mod', discord_slash: 'body-discord', voice: 'voice-owner',
});

export interface LifecycleRequestParts {
  scopeKey: string;
  /** The operator's door; null while it is not there (no audit, switch off). Read at each request: it is made after this. */
  operator(): { handle(value: unknown, hooks?: OperatorHandleHooks): Promise<{ status: number; body: unknown }>; actionLive(): Promise<boolean> } | null;
  /** The owner's stop of her body's tasks (they stay stopped in the list); null while the common runtime is not there. */
  stop(): (() => Promise<unknown>) | null;
  /** The server an operation names, or the only registered one; null when there is none to choose. */
  server(requested: string | null): string | null;
  available(): boolean;
  status(serverId: string): MinecraftLifecycleState | undefined;
  unresolved(): boolean;
  told?: LifecycleOutcomeTeller | undefined;
  now?(): number;
  log?(line: string): void;
  /** Tests shorten these. */
  inflightMs?: number; stopWaitMs?: number; stopStepMs?: number;
}

/** A pending operation is forgotten after this, whatever happened to it (a settled report that never came). */
const INFLIGHT_MS = 120_000;
const STOP_WAIT_MS = 10_000;
const STOP_STEP_MS = 500;

const WORDS = Object.freeze({
  inProgressLogin: 'いま入っている途中です',
  inProgressLogout: 'いま出ている途中です',
  unavailable: 'マイクラ管理の準備ができていません。',
  notRunning: 'サーバーが動いていません。',
  unresolved: '前のマイクラ管理操作の結果がまだ確認できていません。',
  lease: 'いまはマイクラの作業枠が空いていません。',
  refused: '受け付けられませんでした。',
  invalid: '登録されたサーバーを選べませんでした。',
  flooded: '短い間に頼みが続いたので、受け付けませんでした。',
  rateLimited: 'この1時間に受け付けられる数に達しました。',
});

interface Pending { action: LifecycleRequestAction; lifecycleId: string | null; at: number; done: boolean }

const fail = (code: LifecycleRequestCode, message: string): LifecycleRequestResult => ({ ok: false, code, message });

/** The code an operator's refusal becomes for a caller: `disabled` is unavailable, a rate stays one, an unknown one is a plain refusal. */
function codeOfOperator(code: unknown): LifecycleRequestCode {
  if (code === 'disabled') return 'lifecycle_unavailable';
  if (code === 'flooded' || code === 'rate_limited' || code === 'lifecycle_unavailable' || code === 'unresolved_operation'
    || code === 'lease_conflict' || code === 'invalid_input') return code;
  return 'refused';
}

const messageOf = (code: LifecycleRequestCode): string => ({
  lifecycle_unavailable: WORDS.unavailable, unresolved_operation: WORDS.unresolved, lease_conflict: WORDS.lease, refused: WORDS.refused,
  invalid_input: WORDS.invalid, server_not_running: WORDS.notRunning, in_progress: WORDS.refused, flooded: WORDS.flooded,
  rate_limited: WORDS.rateLimited,
}[code]);

/** A label for the log: no spaces or control characters, bounded. */
const loggable = (value: string | undefined): string => (value ?? '-').replace(/[^\p{L}\p{N}._@-]/gu, '_').slice(0, 64) || '-';

export function createLifecycleRequests(parts: LifecycleRequestParts) {
  const now = parts.now ?? (() => Date.now());
  const log = (line: string) => { try { (parts.log ?? console.info)(line); } catch { /* a log never fails a request */ } };
  const inflight = new Map<string, Pending>();

  /** The operation under way on a server, with the ones past their time forgotten. */
  function pendingOf(serverId: string): Pending | null {
    const entry = inflight.get(serverId);
    if (!entry) return null;
    if (now() - entry.at > (parts.inflightMs ?? INFLIGHT_MS)) {
      inflight.delete(serverId);
      log(`Shannon Minecraft lifecycle request ${entry.action} on ${loggable(serverId)} forgotten: no settled report in time`);
      return null;
    }
    return entry;
  }

  /** The answer given without starting anything, in the order of the contract's table; null when the request would go on. */
  function check(input: Pick<LifecycleRequestInput, 'action' | 'serverId'>): LifecycleRequestResult | null {
    const serverId = parts.server(input.serverId ?? null);
    if (!serverId) return fail('invalid_input', WORDS.invalid);
    const pending = pendingOf(serverId);
    if (pending) {
      if (pending.action === input.action) return { ok: true, lifecycleId: pending.lifecycleId, state: 'pending' };
      return fail('in_progress', pending.action === 'login' ? WORDS.inProgressLogin : WORDS.inProgressLogout);
    }
    if (!parts.available()) return fail('lifecycle_unavailable', WORDS.unavailable);
    const state = parts.status(serverId);
    // Only a stopped server is refused here: an unknown one is the service's to decide (it is never woken from here).
    if (input.action === 'login' && state?.running === 'stopped') return fail('server_not_running', WORDS.notRunning);
    if (input.action === 'login' && state?.bot === 'joined') return { ok: true, lifecycleId: null, state: 'already' };
    if (input.action === 'logout' && state?.bot === 'absent') return { ok: true, lifecycleId: null, state: 'already' };
    if (parts.unresolved()) return fail('unresolved_operation', WORDS.unresolved);
    return null;
  }

  /** Her work stopped and kept, then the body's hold waited for: so that the leaving is not refused for a busy body. Never refuses it. */
  async function stopAndKeep(serverId: string, door: NonNullable<ReturnType<LifecycleRequestParts['operator']>>): Promise<void> {
    try {
      await parts.stop()?.();
    } catch (error) {
      log(`Shannon Minecraft lifecycle logout: stop failed (${error instanceof Error ? error.message : 'unknown'}); leaving goes on`);
    }
    const until = now() + (parts.stopWaitMs ?? STOP_WAIT_MS);
    try {
      while (await door.actionLive()) {
        if (now() >= until) {
          log(`Shannon Minecraft lifecycle logout: the body is still held after the wait; leaving goes on (${loggable(serverId)})`);
          return;
        }
        await delay(parts.stopStepMs ?? STOP_STEP_MS);
      }
    } catch { /* the leaving goes on */ }
  }

  async function request(input: LifecycleRequestInput): Promise<LifecycleRequestResult> {
    const serverId = parts.server(input.serverId ?? null);
    const tell = (result: string, id: string | null) => log(`Shannon Minecraft lifecycle request ${input.action} via=${input.via} actor=${loggable(input.actor)} server=${loggable(serverId ?? undefined)} result=${result} id=${id ?? '-'}`);
    const quick = check(input);
    if (quick) {
      tell(quick.ok ? quick.state : `refused:${quick.code}`, quick.ok ? quick.lifecycleId : null);
      return quick;
    }
    const door = parts.operator();
    if (!serverId || !door) {
      tell('refused:lifecycle_unavailable', null);
      return fail('lifecycle_unavailable', WORDS.unavailable);
    }
    // Registered at once, before anything waits: a second press during the stop or the admission is folded into this one.
    const entry: Pending = { action: input.action, lifecycleId: null, at: now(), done: false };
    inflight.set(serverId, entry);
    const release = () => { if (inflight.get(serverId) === entry) inflight.delete(serverId); };
    try {
      if (input.action === 'logout') await stopAndKeep(serverId, door);
      const hooks: OperatorHandleHooks = {
        // A spoken request is its own conversation: its Talk needs no notice of the operator's.
        quiet: input.via === 'voice',
        onSettled: (settlement, operationId) => {
          entry.done = true;
          release();
          if (input.via === 'voice' && input.threadId && parts.told) {
            void parts.told({ scopeKey: parts.scopeKey, threadId: input.threadId, operationId, action: input.action,
              outcome: settledOutcome(settlement) }).catch(() => {});
          }
        },
      };
      const envelope = { v: 1, operator: LIFECYCLE_OPERATOR_LABELS[input.via], domain: 'minecraft', op: input.action,
        ...(input.serverId ? { args: { serverId: input.serverId } } : {}) };
      const answered = await door.handle(envelope, hooks);
      const body = (answered.body ?? {}) as { outcome?: unknown; code?: unknown; lifecycleId?: unknown; message?: unknown };
      if (body.outcome === 'accepted') {
        const id = typeof body.lifecycleId === 'string' ? body.lifecycleId : null;
        // Settled before this answer came back: nothing is left pending.
        if (!entry.done) entry.lifecycleId = id;
        tell('accepted', id);
        return { ok: true, lifecycleId: id, state: 'accepted' };
      }
      release();
      const code = codeOfOperator(body.code);
      tell(`refused:${code}`, null);
      return fail(code, messageOf(code));
    } catch (error) {
      release();
      tell('refused:refused', null);
      log(`Shannon Minecraft lifecycle request ${input.action} failed (${error instanceof Error ? error.message : 'unknown'})`);
      return fail('refused', WORDS.refused);
    }
  }

  /** What a spoken turn reads and asks, for the one registered server (a choice among several is not made by voice). */
  function voicePort(): VoiceLifecyclePort {
    return {
      state() {
        const serverId = parts.server(null);
        if (!serverId || !parts.available()) return null;
        const state = parts.status(serverId);
        if (!state) return null;
        return { running: state.running, bot: state.bot, pending: pendingOf(serverId)?.action ?? null };
      },
      check: action => check({ action }),
      request: (action, options) => request({ action, via: 'voice', actor: options.actor, threadId: options.threadId ?? null }),
    };
  }

  return { request, check, voicePort };
}
export type LifecycleRequests = ReturnType<typeof createLifecycleRequests>;
