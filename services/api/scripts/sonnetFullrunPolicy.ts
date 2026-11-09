import type Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { AnthropicRequestNotSentError } from '../src/infra/models/anthropic/anthropicFcaFailure.js';
import { closedUsage, conversationCounts, estimatedAnthropicCostUsd, unknownCostUpperBound } from '../src/infra/models/claude/claudeUsage.js';
export const FULLRUN_MODEL = 'claude-sonnet-5-5';
export const FULLRUN_GOAL = 'エンドラを討伐してください';
export const FULLRUN_CAP_YEN = 1000;
export const FULLRUN_PRIOR_YEN = 144;
export const FULLRUN_MAX_SECONDS = 10800;
export const FULLRUN_YEN_PER_USD = 160;
export { fullrunBodyHandshake } from './minecraftFullrunCatalog.js';
function requestShapeProblem(body: Record<string, any>): string | null {
    if (body.stream === true || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 64000)
        return 'FULLRUN_REQUEST_SHAPE';
    const pricing = [
        body.speed && body.speed !== 'standard', body.inference_geo && body.inference_geo !== 'global',
        body.service_tier && ![
            'auto', 'standard_only'
        ].includes(body.service_tier)
    ];
    if (pricing.some(Boolean))
        return 'FULLRUN_PRICING_MODE';
    if ((body.tools ?? []).some((tool: any) => tool.type !== undefined && tool.type !== 'custom'))
        return 'FULLRUN_SERVER_TOOL';
    const addedServerTool = (block: any) => block?.type === 'tool_addition' && block.tool?.type === 'tool_definition'
        && block.tool.definition?.type !== undefined && block.tool.definition.type !== 'custom';
    if ((body.messages ?? []).some((message: any) => Array.isArray(message.content) && message.content.some(addedServerTool)))
        return 'FULLRUN_SERVER_TOOL';
    return null;
}
/** A separate paid full-run profile. The Haiku validation profile is deliberately not called or altered. */
export function fullrunModelValues(values: Readonly<Record<string, string | undefined>>) {
    return {
        ...values, SHANNON_MINECRAFT_LLMC_MODEL: FULLRUN_MODEL, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: FULLRUN_MODEL,
        SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none', SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on'
    };
}
type Snapshot = {
    schema: 1;
    capYen: number;
    priorYen: number;
    yenPerUsd: number;
    spentUsd: number;
    reservedUsd: number;
    admissionKnownYen: number;
    admissionReservedYen: number;
    calls: number;
    countCalls: number;
    pending: number;
    complete: boolean;
    accepting: boolean;
    stopped: string | null;
    lastAdmission: {
        requestSha256: string;
        method: string;
        inputEstimate: number | null;
        inputReservation: number;
        reserveUsd: number;
        state: string;
        countStatus: string;
        countErrorStatus: number | null;
    } | null;
};
/** The same transport is supplied to decision/redecision, plan/replan and summary. Reservations are atomic before inference.
 * Count the exact copied input with the same model/beta headers, then add max(4096,10%) and price all input at one-hour writes.
 * Provider token counting is documented as an estimate, not an exact bound. Unsupported/failed count falls back to the existing
 * full-context 1M reservation. This margin is explicit operational conservatism, not a mathematical spending guarantee.
 * A transport failure or incomplete receipt keeps that reservation booked and closes this one-shot run. No automatic retry. */
export function fullrunTransport(provider: Pick<Anthropic, 'messages'>, parts: {
    deadline: number;
    budget?: { capYen: number; priorYen: number };
    now?: () => number;
    save(snapshot: Snapshot): void;
    stop(reason: string): void;
}) {
    const capYen = parts.budget?.capYen ?? FULLRUN_CAP_YEN;
    const priorYen = parts.budget?.priorYen ?? FULLRUN_PRIOR_YEN;
    if (!((capYen === 1000 && priorYen === 144) || (capYen === 4881 && (priorYen === 881 || priorYen === 1919))))
        throw new Error('FULLRUN_INTERNAL_BUDGET_POLICY');
    const now = parts.now ?? Date.now;
    let spent = 0;
    let reserved = 0;
    let calls = 0;
    let countCalls = 0;
    let inFlight = 0;
    let complete = true;
    let accepting = true;
    let stopped: string | null = null;
    // Sum of each closed request's ceil(Yen), an upper bound on the DB's ceil(sum of requests per step).
    let admissionKnownYen = 0;
    // Sum of each closed request's ceil(Yen), an upper bound on the DB's ceil(sum of requests per step).
    let admissionReservedYen = 0;
    let lastAdmission: Snapshot['lastAdmission'] = null;
    const work = new Set<Promise<unknown>>();
    const waiters = new Set<() => void>();
    const notify = () => { for (const wake of [
        ...waiters
    ])
        wake(); };
    const snapshot = (): Snapshot => ({
        schema: 1, capYen, priorYen,
        yenPerUsd: FULLRUN_YEN_PER_USD, spentUsd: spent, reservedUsd: reserved, admissionKnownYen, admissionReservedYen,
        calls, countCalls, pending: work.size,
        complete: complete && work.size === 0, accepting, stopped, lastAdmission: lastAdmission ? {
            ...lastAdmission
        } : null
    });
    const stop = (reason: string) => { accepting = false; stopped ??= reason; notify(); parts.stop(reason); };
    const deny = (reason: string): never => { stop(reason); parts.save(snapshot()); throw new AnthropicRequestNotSentError(reason); };
    const check = (signal?: AbortSignal) => {
        if (!accepting || now() >= parts.deadline)
            deny('FULLRUN_CLOSED');
        if (signal?.aborted)
            deny('FULLRUN_ABORTED');
    };
    const room = (yen: number) => priorYen + yen <= capYen;
    const waitForSettlement = (signal?: AbortSignal) => new Promise<void>(resolve => {
        const finish = () => { waiters.delete(finish); clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, Math.max(1, parts.deadline - now()));
        waiters.add(finish);
        signal?.addEventListener('abort', finish, {
            once: true
        });
    });
    const countInput = async (copied: Record<string, any>, opts: Record<string, any>) => {
        let estimate: number | null = null;
        let countStatus = 'unsupported-shape-or-client';
        let countErrorStatus: number | null = null;
        const inputKeys = [
            'model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'output_config', 'cache_control', 'speed'
        ];
        const knownKeys = new Set([
            ...inputKeys, 'max_tokens', 'metadata', 'stop_sequences', 'temperature', 'top_k', 'top_p', 'stream', 'service_tier'
        ]);
        if (Object.keys(copied).every(key => knownKeys.has(key)) && typeof provider.messages.countTokens === 'function') {
            try {
                check(opts.signal);
                countCalls++;
                const input = Object.fromEntries(inputKeys.filter(key => copied[key] !== undefined).map(key => [
                    key, copied[key]
                ]));
                const counted = await provider.messages.countTokens(JSON.parse(JSON.stringify(input)) as never, {
                    ...opts, ...(opts.headers ? {
                        headers: {
                            ...opts.headers
                        }
                    } : {})
                } as never);
                countStatus = 'invalid-receipt';
                if (Number.isSafeInteger(counted.input_tokens) && counted.input_tokens >= 0 && counted.input_tokens <= 1000000) {
                    estimate = counted.input_tokens;
                    countStatus = 'provider-estimate';
                }
            }
            catch (error) {
                if (error instanceof AnthropicRequestNotSentError)
                    throw error;
                countStatus = 'count-failed';
                const status = (error as {
                    status?: unknown;
                } | null)?.status;
                countErrorStatus = typeof status === 'number' && Number.isInteger(status) ? status : null;
            }
        }
        return {
            estimate, countStatus, countErrorStatus
        };
    };
    const client = {
        messages: {
            create(body: Record<string, any>, options?: Record<string, any>) {
                if (body.model !== FULLRUN_MODEL)
                    return deny('FULLRUN_MODEL_MISMATCH');
                check(options?.signal);
                const problem = requestShapeProblem(body);
                if (problem)
                    return deny(problem);
                // Snapshot the fully assembled request: callers cannot mutate it while token counting/admission awaits.
                const copied = JSON.parse(JSON.stringify(body));
                const opts: Record<string, any> = {
                    ...options, ...(options?.headers ? {
                        headers: {
                            ...options.headers
                        }
                    } : {}), maxRetries: 0
                };
                const requestSha256 = createHash('sha256').update(JSON.stringify([
                    copied, opts.headers ?? null
                ])).digest('hex');
                const promise = Promise.resolve().then(async () => {
                    const { estimate, countStatus, countErrorStatus } = await countInput(copied, opts);
                    check(opts.signal);
                    const inputReservation = estimate === null ? 1000000 : Math.min(1000000, estimate + Math.max(4096, Math.ceil(estimate * .1)));
                    const bound = unknownCostUpperBound(FULLRUN_MODEL, copied.max_tokens, 0, {
                        input: 0, cacheWrite: inputReservation, cacheRead: 0
                    });
                    const boundYen = Math.ceil(bound * FULLRUN_YEN_PER_USD);
                    const attempt: NonNullable<Snapshot['lastAdmission']> = {
                        requestSha256,
                        method: estimate === null ? 'full-context-fallback' : 'provider-estimate-plus-margin',
                        inputEstimate: estimate, inputReservation, reserveUsd: bound, state: 'counted', countStatus, countErrorStatus
                    };
                    lastAdmission = attempt;
                    while (!room(admissionKnownYen + admissionReservedYen + boundYen)) {
                        if (inFlight === 0 || !room(admissionKnownYen + boundYen))
                            return deny('FULLRUN_RESERVATION_LIMIT');
                        attempt.state = 'waiting';
                        await waitForSettlement(opts.signal);
                        check(opts.signal);
                    }
                    check(opts.signal);
                    attempt.state = 'reserved';
                    lastAdmission = attempt;
                    reserved += bound;
                    admissionReservedYen += boundYen;
                    // A failed durable write prevents inference dispatch; the marker stays unreconciled.
                    try {
                        parts.save(snapshot());
                    }
                    catch (error) {
                        complete = false;
                        stop('FULLRUN_LEDGER_WRITE');
                        throw error;
                    }
                    check(opts.signal);
                    calls++;
                    inFlight++;
                    try {
                        const reply = await provider.messages.create(copied as never, opts as never) as Anthropic.Message;
                        if (!closedUsage(reply.usage) || Object.values(reply.usage.server_tool_use ?? {}).some(n => n !== 0)) {
                            complete = false;
                            stop('FULLRUN_USAGE_UNKNOWN');
                            throw new Error('FULLRUN_USAGE_UNKNOWN');
                        }
                        const counts = conversationCounts({
                            scopeKey: 'owner', model: FULLRUN_MODEL, usage: reply.usage,
                            maximumOutputTokens: copied.max_tokens, finalUsage: true, maximumSearches: 0, at: () => ''
                        });
                        const cost = estimatedAnthropicCostUsd(FULLRUN_MODEL, counts);
                        // The planner conservatively prices unspecified cache creation TTL as one hour. Bound both lane calculations.
                        const laneCost = Math.max(cost, estimatedAnthropicCostUsd(FULLRUN_MODEL, {
                            ...counts, cacheWrite5m: undefined, cacheWrite1h: undefined
                        }));
                        reserved -= bound;
                        spent += cost;
                        admissionReservedYen -= boundYen;
                        admissionKnownYen += Math.ceil(laneCost * FULLRUN_YEN_PER_USD);
                        if (laneCost > bound || counts.input + counts.cacheWrite + counts.cacheRead > inputReservation
                            || !room(admissionKnownYen + admissionReservedYen)) {
                            complete = false;
                            stop('FULLRUN_BOUND_EXCEEDED');
                            throw new Error('FULLRUN_BOUND_EXCEEDED');
                        }
                        return reply;
                    }
                    catch (error) {
                        complete = false;
                        stop('FULLRUN_USAGE_UNKNOWN');
                        throw error;
                    }
                    finally {
                        inFlight--;
                        notify();
                        parts.save(snapshot());
                    }
                });
                work.add(promise);
                void promise.finally(() => { work.delete(promise); try {
                    parts.save(snapshot());
                }
                catch {
                    complete = false;
                    stop('FULLRUN_LEDGER_WRITE');
                } }).catch(() => undefined);
                return promise;
            }
        }
    } as unknown as Pick<Anthropic, 'messages'>;
    return {
        client, snapshot, stopAccepting() { accepting = false; notify(); parts.save(snapshot()); }, async drain() { await Promise.allSettled([
            ...work
        ]); }
    };
}
/** A native receipt is accepted only from the original admitted task's completed evidence read and its current connection.
 * witness.sessionId/generation name the attacking action, which may precede this read; body owns that causal verifier. */
export function fullrunNativeProof(value: unknown, expected: {
    scopeKey: string;
    taskId: string;
    bodyId: string;
    sessionId: string;
    connectionId: string;
    goal: string;
    completionCriteria: string;
}, deadline: number) {
    const e = value as any;
    const w = e?.boss?.witness;
    const contextKey = createHash('sha256').update(JSON.stringify([
        expected.scopeKey, expected.taskId, expected.bodyId,
        expected.goal, expected.completionCriteria
    ])).digest('hex');
    const contextMatches = [
        expected.goal === FULLRUN_GOAL, e?.contextKey === contextKey, e?.connected === true,
        e?.scopeKey === expected.scopeKey, e?.taskId === expected.taskId, e?.bodyId === expected.bodyId,
        e?.sessionId === expected.sessionId, e?.connectionId === expected.connectionId, e?.boss?.verified === true,
        e?.boss?.entity === 'ender_dragon', e?.boss?.dimension === 'the_end'
    ].every(Boolean);
    const witnessMatches = [
        w?.connectionId === expected.connectionId, w?.bodyId === expected.bodyId,
        Number.isSafeInteger(w?.generation), w?.generation >= 0, typeof w?.sessionId === 'string', w?.sessionId?.length > 0,
        Number.isSafeInteger(w?.entityId), w?.entityId >= 0, w?.damages > 0, Array.isArray(w?.via), w?.via?.length > 0,
        Number.isFinite(Date.parse(w?.lastDamageAt)), Number.isFinite(Date.parse(w?.observedAt)),
        Number.isFinite(deadline), Date.parse(w?.observedAt) <= deadline,
        Date.parse(w?.lastDamageAt) <= Date.parse(w?.observedAt)
    ].every(Boolean);
    return contextMatches && witnessMatches;
}
