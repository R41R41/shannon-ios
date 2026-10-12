import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { recordWarmTurn, resetWarmTurns, warmTurnsView } from './cacheWarmTurns.js';

/**
 * Content-free receipts of Claude's prompt cache (Syzygy ADR-0009 stage 1, step 1). Each request leaves its route, model, the
 * provider's token counts and a fingerprint of its prefix: short hashes of the tools, the system, the output schema, the effort
 * and the first history messages. No message text, no tool input and no identifier is kept. The receipts live in this
 * process only: a ring of the latest requests and a per-day aggregate for `GET /v1/ops`.
 */
export type CacheRoute = 'text' | 'voice' | 'web_search' | 'background' | 'fca' | 'skill' | 'own_time';

export interface CachePrefixFingerprint {
  tools: string;
  system: string;
  schema: string;
  effort: string;
  history: string;
}

/** What a foreground turn adds to its receipts: its Talk (kept only as a short hash), its lane and its first-token time. */
export interface CacheTurn {
  thread: string;
  cachePlan: boolean;
  /** Under the plan: the common schema, or the exception turn's own. */
  planSchema?: 'common' | 'exception';
  /** History messages before the turn's words in the request. */
  historyMessages: number;
  firstTokenMs?: number;
}

export interface CacheReceipt {
  at: string;
  route: CacheRoute;
  round: number;
  model: string;
  input: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  output: number;
  prefix: CachePrefixFingerprint;
  /** Only on a foreground turn's requests: the Talk's short hash, the cache plan, and on round 0 the first-token time. */
  thread?: string;
  cachePlan?: boolean;
  planSchema?: 'common' | 'exception';
  historyMessages?: number;
  firstTokenMs?: number;
}

export interface CacheDayAggregate {
  requests: number;
  /** A turn is a request of round 0 (the first request of a conversation turn, or a one-shot call). */
  turns: number;
  turnsWithCacheRead: number;
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export const CACHE_RECEIPT_LIMITS = Object.freeze({ ring: 200, historyMessages: 2, hashCharacters: 8, days: 2 });

const ring: CacheReceipt[] = [];
const days = new Map<string, Map<CacheRoute, CacheDayAggregate>>();

function shortHash(value: unknown): string {
  if (value === undefined || value === null) return '-';
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, CACHE_RECEIPT_LIMITS.hashCharacters);
}

/** The prefix of a request as short hashes, in the provider's cache order (tools, system, messages) plus its settings. */
export function prefixFingerprint(body: Anthropic.MessageCreateParamsNonStreaming): CachePrefixFingerprint {
  const settings = body.output_config as { effort?: unknown; format?: unknown } | undefined;
  return {
    tools: shortHash(body.tools),
    system: shortHash(body.system),
    schema: shortHash(settings?.format),
    effort: shortHash({ effort: settings?.effort ?? null, thinking: body.thinking ?? null }),
    history: shortHash(body.messages.slice(0, CACHE_RECEIPT_LIMITS.historyMessages)),
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptyDay(): CacheDayAggregate {
  return { requests: 0, turns: 0, turnsWithCacheRead: 0, input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
}

function aggregate(receipt: CacheReceipt): void {
  const day = receipt.at.slice(0, 10);
  const routes = days.get(day) ?? new Map<CacheRoute, CacheDayAggregate>();
  days.set(day, routes);
  const total = routes.get(receipt.route) ?? emptyDay();
  routes.set(receipt.route, total);
  total.requests += 1;
  total.input += receipt.input;
  total.cacheRead += receipt.cacheRead;
  total.cacheCreation += receipt.cacheCreation5m + receipt.cacheCreation1h;
  total.output += receipt.output;
  if (receipt.round !== 0) return;
  total.turns += 1;
  if (receipt.cacheRead > 0) total.turnsWithCacheRead += 1;
}

function forgetOldDays(): void {
  const kept = [...days.keys()].sort().slice(-CACHE_RECEIPT_LIMITS.days);
  for (const day of [...days.keys()]) if (!kept.includes(day)) days.delete(day);
}

function turnFields(turn: CacheTurn | undefined): Pick<CacheReceipt, 'thread' | 'cachePlan' | 'planSchema' | 'historyMessages' | 'firstTokenMs'> {
  if (!turn) return {};
  const first = turn.firstTokenMs === undefined ? {} : { firstTokenMs: Math.max(0, Math.round(turn.firstTokenMs)) };
  const schema = turn.planSchema === undefined ? {} : { planSchema: turn.planSchema };
  return { thread: shortHash(turn.thread), cachePlan: turn.cachePlan, ...schema, historyMessages: turn.historyMessages, ...first };
}

/** A foreground text turn's first request also counts toward the warm-turn view (`cacheWarmTurns.ts`). */
function noteWarmTurn(receipt: CacheReceipt): void {
  if (receipt.route !== 'text' || receipt.round !== 0 || receipt.thread === undefined) return;
  const cacheCreation = receipt.cacheCreation5m + receipt.cacheCreation1h;
  const { tools, system, schema, effort } = receipt.prefix;
  recordWarmTurn({ at: receipt.at, thread: receipt.thread, model: receipt.model, cachePlan: receipt.cachePlan === true,
    exception: receipt.planSchema === 'exception',
    staticPrefix: [tools, system, schema, effort].join(':'), historyMessages: receipt.historyMessages ?? 0, input: receipt.input,
    cacheRead: receipt.cacheRead, cacheCreation, ...(receipt.firstTokenMs === undefined ? {} : { firstTokenMs: receipt.firstTokenMs }) });
}

/** Records one provider response's usage. Never throws: a receipt is an observation, not part of the request. */
export function recordCacheReceipt(route: CacheRoute, body: Anthropic.MessageCreateParamsNonStreaming,
  usage: Partial<Anthropic.Message['usage']> | null | undefined, round = 0, at = new Date().toISOString(), turn?: CacheTurn): void {
  try {
    const creation = usage?.cache_creation;
    const receipt: CacheReceipt = {
      at, route, round, model: body.model, input: count(usage?.input_tokens), cacheRead: count(usage?.cache_read_input_tokens),
      cacheCreation5m: count(creation?.ephemeral_5m_input_tokens), cacheCreation1h: count(creation?.ephemeral_1h_input_tokens),
      output: count(usage?.output_tokens), prefix: prefixFingerprint(body), ...turnFields(turn),
    };
    ring.push(receipt);
    if (ring.length > CACHE_RECEIPT_LIMITS.ring) ring.splice(0, ring.length - CACHE_RECEIPT_LIMITS.ring);
    aggregate(receipt);
    noteWarmTurn(receipt);
    forgetOldDays();
  } catch {
    // An unreadable request shape leaves no receipt; the request itself is unaffected.
  }
}

/**
 * What `GET /v1/ops` shows: the latest receipts, per day and route how many turns read the cache, and per day the foreground
 * text turns that followed their Talk's previous turn within the hour (`cacheWarmTurns.ts`).
 */
export function cacheReceiptsView(recent = 20) {
  const byDay = Object.fromEntries([...days].map(([day, routes]) => [day, Object.fromEntries(routes)]));
  return { recent: ring.slice(-Math.max(0, recent)), days: byDay, foregroundText: warmTurnsView() };
}

/** The day's foreground turns that read the cache, per route: the compact daily log line. */
export function cacheDayLine(day: string): string {
  const routes = days.get(day);
  if (!routes) return 'none';
  return [...routes].map(([route, total]) => `${route}=${total.turnsWithCacheRead}/${total.turns}`).join(',');
}

/** Tests only: forget every receipt. */
export function resetCacheReceipts(): void {
  ring.splice(0, ring.length);
  days.clear();
  resetWarmTurns();
}
