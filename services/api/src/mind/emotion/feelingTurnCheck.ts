/**
 * The reply check's side of a feeling turn (Syzygy ADR-0013 stage 2, `SHANNON_REPLY_CHECK`): the context a turn's reply is checked
 * with, the register her composure holds, and the check recorded on her reply. Moved unchanged out of `feelingPorts.ts` (2026-10-20,
 * the 500-line ceiling), with her character space's region added to the context. Core: emotion.
 */
import {
  checkReply, continuedAfterRefusal, foldFeelingDynamics, registerOfLevel, type FeelingRegister, type ReplyCheckContext,
} from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';
import { regionOf } from './characterSpaceHooks.js';
import type { FeelingTurnHandle } from './feelingPorts.js';

const safely = <T>(work: () => T, fallback: T): T => {
  try { return work(); } catch { return fallback; }
};

/** The reply check's context of a turn, or null without the check or a decision. */
export function checkContext(handle: FeelingTurnHandle): ReplyCheckContext | null {
  if (!handle.port.check || !handle.decision) return null;
  const violation = continuedAfterRefusal(handle.lines?.ledger, handle.at);
  const level = handle.port.coreAffect ? composureLevel(handle) : undefined;
  const form = handle.textRegister ? { form: { maxCharacters: handle.textRegister.maxCharacters, emoji: handle.textRegister.emoji,
    lineBreaks: handle.textRegister.lineBreaks } } : {};
  const ledger = handle.lines?.ledger;
  const counted = Boolean(ledger && (ledger.touches > 0 || ledger.apologies > 0 || ledger.orders > 0));
  const phrases = handle.lines?.phrases ? { phrases: handle.lines.phrases } : {}; // Owner 2026-10-19: what she already said 3 times today.
  const region = regionOf(handle);
  return { stance: handle.decision.stance, intensity: handle.decision.intensity, audience: handle.key.audience, order: handle.order, violation,
    turn: handle.turn, counted, ...(level !== undefined ? { level } : {}), ...form, ...(handle.port.audience ? { audienceChecks: true } : {}), ...phrases,
    ...(region ? { region } : {}) };
}

/** The register her composure holds now: the fast layer's step when it is known, else the turn's (item 10). */
export function registerNow(handle: FeelingTurnHandle): FeelingRegister {
  const level = handle.port.coreAffect ? composureLevel(handle) : undefined;
  return level !== undefined ? registerOfLevel(level) : handle.register;
}

/** The shadow's composure step for this key now (for the check's register flags only). */
function composureLevel(handle: FeelingTurnHandle): number | undefined {
  const events = () => handle.port.events.today(handle.scopeKey, handle.at, handle.snapshot);
  // Re-review S4-4: with others in a place (a group, a call), her composure is the place's, each person a source within it.
  const { key } = handle;
  const place = handle.port.audience && key.sceneId && key.audience !== 'owner_alone' && !key.personKey.startsWith('scene:')
    ? { personKey: `scene:${key.sceneId}`, audience: key.audience, sceneId: key.sceneId } : key;
  return safely(() => foldFeelingDynamics(events(), place, {}, { sourceCap: handle.port.audience === true }).composure.level, undefined);
}

/** A reply's check: the one made before sending when there was one, else checked now (voice, and text turns not checked before). */
export function checkFacts(handle: FeelingTurnHandle, reply: string): { checkFlags?: readonly string[]; rewritten?: true } {
  const context = checkContext(handle);
  if (!context) return {};
  const before = handle.channel === 'text' ? handle.port.events.takeCheck(handle.scopeKey, handle.turn) : null;
  const flags = before ? before.flags : checkReply(reply, context);
  observeSync('emotion', { phase: 'feeling.reply_check', audience: handle.key.audience, before: Boolean(before) }, () => null,
    () => ({ flags: [...flags], rewritten: before?.rewritten === true }));
  return { ...(flags.length ? { checkFlags: flags } : {}), ...(before?.rewritten ? { rewritten: true as const } : {}) };
}
