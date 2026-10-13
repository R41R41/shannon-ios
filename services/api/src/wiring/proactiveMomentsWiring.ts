import { switchOn, type SwitchValues } from '@shannon/switches';
import { JevChoiceClient, jevAnswers, jevNoul } from '../infra/models/jev/jevChoice.js';
import { jevUsdPerCall } from '../infra/models/jev/jevUsage.js';
import { localDateParts } from '../infra/time/localDate.js';
import type { EmitMindEvent } from '../contracts/mindInboxContract.js';
import { ProactiveMoments } from '../mind/attention/proactiveMomentDesk.js';
import { PROACTIVE_MOMENTS_V1, PROACTIVE_MOMENT_QUESTION, type ProactiveMomentFacts, type ProactiveMomentState } from '../mind/attention/proactiveMoments.js';
import { SQLiteProactiveMoments } from '../mind/attention/store/proactiveMomentStore.js';

/**
 * Her moments in her own time's worker (owner decision 2026-10-14, `mind/attention/proactiveMoments.ts`). On while
 * `SHANNON_PROACTIVE_MOMENTS` is on, her own time is on and the proactive gate is there (no message of hers without it); off, no
 * table is created, nothing is perceived and her loop is handed nothing.
 *
 * The decision asks Jev (`TYPESAFE_API_KEY`, the endpoint, model and price settings the other Jev callers read; 3 s in the
 * background unless `SHANNON_PROACTIVE_MOMENTS_JEV_TIMEOUT_MS`), one call per moment at most. Without a key her message's writer
 * decides and may stay silent. The day's caps: `SHANNON_PROACTIVE_MOMENTS_MAX_DECISIONS` (24) and
 * `SHANNON_PROACTIVE_MOMENTS_MAX_MESSAGES` (8); every message is also inside her daily budget, as any step of hers.
 */
export interface ProactiveMomentParts {
  databasePath: string;
  timeZone: string;
  gate: boolean;
  /** Her body, as far as moments read it. */
  body: {
    windowVisible: (scopeKey: string, at: string) => boolean;
    latestReturn: (scopeKey: string, since: string, until: string) => { id: string; occurredAt: string; minutesAway: number } | null;
    latestOfTypes: (scopeKey: string, types: readonly string[], since: string, until: string) => { type: string; occurredAt: string } | null;
    others: (scopeKey: string, at: string) => boolean;
  };
  /** Whether the owner wrote or spoke since an instant (the conversation's table, a timestamp). */
  ownerActiveSince: (scopeKey: string, since: string) => boolean;
  /** The newest story of hers the owner can read and has not reacted to. */
  awaiting: (scopeKey: string) => { pieceId: string; version: number } | null;
  /** The free checks before a decision (`ProactiveMomentPorts.blocked`). */
  blocked: (scopeKey: string, at: string) => string | null;
  /** Her own messages: how many today, and when the last one was written. */
  ownMessages: (scopeKey: string, at: string) => { today: number; lastAt: string | null };
  emit?: EmitMindEvent | null;
  log?: (line: string) => void;
  fetcher?: typeof fetch;
}

type MomentAsk = (state: ProactiveMomentState, signal?: AbortSignal) => Promise<number>;
const MINUTE = 60_000;
/** What one Jev call is counted at when no price is set: deliberately not optimistic. */
const JEV_FAIL_SAFE_USD = 0.002;

export function proactiveMomentsEnabled(environment: SwitchValues): boolean {
  return switchOn(environment, 'SHANNON_PROACTIVE_MOMENTS') && environment.SHANNON_AUTONOMY_ENABLED?.trim() === 'true';
}

export function configuredProactiveMoments(
  environment: Readonly<Record<string, string | undefined>>, parts: ProactiveMomentParts,
): { moments: ProactiveMoments; close(): void } | null {
  if (!proactiveMomentsEnabled(environment) || !parts.gate) return null;
  const store = new SQLiteProactiveMoments(parts.databasePath);
  const ask = momentAsk(environment, parts.fetcher);
  const moments = new ProactiveMoments({
    store, facts: (scopeKey, at) => momentFacts(parts, scopeKey, at), others: parts.body.others, blocked: parts.blocked,
    context: (scopeKey, at) => momentContext(parts, scopeKey, at),
    ...(ask ? { ask } : {}), ...(parts.emit ? { emit: parts.emit } : {}), ...(parts.log ? { log: parts.log } : {}),
    usdPerDecision: ask ? jevUsdPerCall(environment) ?? JEV_FAIL_SAFE_USD : 0,
    maximumDecisionsPerDay: bounded(environment.SHANNON_PROACTIVE_MOMENTS_MAX_DECISIONS, 0, 200, 24),
    maximumMessagesPerDay: bounded(environment.SHANNON_PROACTIVE_MOMENTS_MAX_MESSAGES, 0, 50, 8),
  });
  return { moments, close: () => store.close() };
}

/** Jev's probability that she wants to speak now, or null without `TYPESAFE_API_KEY`. */
function momentAsk(environment: Readonly<Record<string, string | undefined>>, fetcher?: typeof fetch): MomentAsk | null {
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return null;
  const client = new JevChoiceClient({
    apiKey, model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
    ...(environment.SHANNON_JEV_ENDPOINT?.trim() ? { endpoint: environment.SHANNON_JEV_ENDPOINT.trim() } : {}),
    timeoutMilliseconds: bounded(environment.SHANNON_PROACTIVE_MOMENTS_JEV_TIMEOUT_MS, 200, 10_000, 3_000),
    ...(fetcher ? { fetcher } : {}),
  });
  // The fixed question set `JEV_QUESTION_SETS.proactiveMoment` (ADR-0008 §14): a change of its wording is a new version.
  const questions = { would_speak: PROACTIVE_MOMENT_QUESTION };
  return async (state, signal) => jevNoul(jevAnswers(await client.ask(state, questions, signal)), 'would_speak');
}

/** The facts of the instant (`ProactiveMomentFacts`), read from her body's reports, the conversation's timestamps and her study. */
export function momentFacts(
  parts: Pick<ProactiveMomentParts, 'timeZone' | 'body' | 'ownerActiveSince' | 'awaiting'>, scopeKey: string, at: string,
): ProactiveMomentFacts {
  const time = Date.parse(at);
  const local = localDateParts(new Date(time), parts.timeZone);
  const evening = localDateParts(new Date(time - 4 * 60 * MINUTE), parts.timeZone);
  const hourAgo = new Date(time - 60 * MINUTE).toISOString();
  const quietSince = new Date(time - PROACTIVE_MOMENTS_V1.longQuietMinutes * MINUTE).toISOString();
  const newest = parts.body.latestOfTypes(scopeKey, ['ownerAway', 'ownerReturned'], hourAgo, at);
  return {
    at, localHour: local.hour, localDate: dateOf(local), eveningDate: dateOf(evening),
    windowVisible: parts.body.windowVisible(scopeKey, at),
    owner: newest?.type === 'ownerAway' ? 'away' : newest?.type === 'ownerReturned' ? 'returned' : 'unknown',
    returned: parts.body.latestReturn(scopeKey, hourAgo, at),
    quietLong: !parts.ownerActiveSince(scopeKey, quietSince),
    presenceSteady: parts.body.latestOfTypes(scopeKey, ['ownerAway', 'ownerReturned'], quietSince, at) === null,
    awaiting: parts.awaiting(scopeKey),
  };
}

const SPOKE_WITHIN = [10, 30, 60, 120, 360] as const;

function momentContext(parts: ProactiveMomentParts, scopeKey: string, at: string): Pick<ProactiveMomentState,
  'owner_spoke_within_minutes' | 'own_messages_today' | 'last_own_message_minutes_ago' | 'stories_awaiting_reaction'> {
  const time = Date.parse(at);
  const spoke = SPOKE_WITHIN.find(minutes => parts.ownerActiveSince(scopeKey, new Date(time - minutes * MINUTE).toISOString())) ?? null;
  const own = parts.ownMessages(scopeKey, at);
  const last = own.lastAt ? Math.max(0, Math.round((time - Date.parse(own.lastAt)) / MINUTE)) : null;
  return {
    owner_spoke_within_minutes: spoke, own_messages_today: own.today, last_own_message_minutes_ago: Number.isFinite(last) ? last : null,
    stories_awaiting_reaction: parts.awaiting(scopeKey) !== null,
  };
}

function dateOf(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function bounded(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return value?.trim() && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
