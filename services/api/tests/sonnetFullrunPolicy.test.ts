import type Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FULLRUN_MODEL, FULLRUN_GOAL, fullrunModelValues, fullrunTransport, fullrunNativeProof, fullrunBodyHandshake } from '../scripts/sonnetFullrunPolicy.js';
import { rigModelValues } from '../scripts/minecraftRigModelPolicy.js';
import { configuredMinecraftLlmc, llmcModelNames } from '../src/wiring/minecraftLlmcConfiguration.js';
import { closedUsage } from '../src/infra/models/claude/claudeUsage.js';
const response = (usage: Record<string, unknown> = {}) => ({
    model: FULLRUN_MODEL, usage: {
        input_tokens: 100,
        output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage
    }
}) as Anthropic.Message;
const body = (extra: Record<string, unknown> = {}) => ({
    model: FULLRUN_MODEL, max_tokens: 1000, messages: [], ...extra
});
function fixture(create = vi.fn(async () => response())) {
    const saved: unknown[] = [];
    const stopped: string[] = [];
    const t = fullrunTransport({
        messages: {
            create
        }
    } as never, {
        deadline: 20000, now: () => 10000,
        save: value => saved.push(structuredClone(value)), stop: reason => stopped.push(reason)
    });
    return {
        ...t, create, saved, stopped, call: (extra = {}) => t.client.messages.create(body(extra) as never)
    };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('explicit Sonnet full mission policy', () => {
    it(("bounds the DB step-ceil sum with a per-request ceil admission counter without doubling reported" + " USD"), async () => {
        const create = vi.fn(async () => response({
            input_tokens: 500, output_tokens: 0
        })); // $0.001 -> ceil(.16)=1Y each
        const t = fullrunTransport({
            messages: {
                create, countTokens: vi.fn(async () => ({
                    input_tokens: 500
                }))
            }
        } as never, {
            deadline: 20000, now: () => 1, save() { }, stop() { }
        });
        await t.client.messages.create(body() as never);
        await t.client.messages.create(body() as never);
        await t.drain();
        expect(t.snapshot()).toMatchObject({
            admissionKnownYen: 2, admissionReservedYen: 0, spentUsd: .002
        });
        expect(Math.ceil(t.snapshot().spentUsd * 160)).toBe(1);
    });
    it('refuses the next request when DB-style rounded known spend plus its reservation cannot fit', async () => {
        const t = fullrunTransport({
            messages: {
                create: vi.fn(async () => response({
                    input_tokens: 500, output_tokens: 0
                })),
                countTokens: vi.fn(async () => ({
                    input_tokens: 500
                }))
            }
        } as never, {
            deadline: 20000, now: () => 1, save() { }, stop() { }
        });
        for (let i = 0; i < 852; i++)
            await t.client.messages.create(body() as never);
        await expect(t.client.messages.create(body() as never)).rejects.toThrow('RESERVATION_LIMIT');
        await t.drain();
        expect(t.snapshot()).toMatchObject({
            admissionKnownYen: 852, calls: 852, accepting: false
        });
        expect(t.snapshot().capYen).toBe(1000);
    });
    it('pins all configured roles while keeping strict Haiku validation closed', () => {
        const hostile = Object.freeze({
            SHANNON_MINECRAFT_LLMC_MODEL: 'claude-opus-5-5', SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next'
        });
        const values = fullrunModelValues(hostile);
        expect(llmcModelNames(values)).toEqual({
            main: FULLRUN_MODEL, plan: FULLRUN_MODEL, escalate: null
        });
        // thru-1110 (11/9): the rig takes Sonnet for the owner-approved thru run; any other model stays refused.
        expect(rigModelValues(values, 'sonnet').SHANNON_MINECRAFT_LLMC_MODEL).toBe('claude-sonnet-5-5');
        expect(() => rigModelValues(values, 'opus')).toThrow('RIG_VALIDATION_REQUIRES_HAIKU_OR_SONNET');
        expect(rigModelValues(values).SHANNON_MINECRAFT_LLMC_MODEL).toBe('claude-haiku-5-5');
        expect(hostile.SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL).toBe('next');
        expect(() => configuredMinecraftLlmc({
            ...values, SHANNON_HAIKU_API_KEY: 'synthetic-only'
        }, {
            recordUsage() { }
        })).toThrow('KEY_REQUIRED');
    });
    it.each([
        'claude-haiku-5-5', 'claude-opus-5-5', 'next'
    ])('refuses %s before any provider call', model => {
        const t = fixture();
        expect(() => t.call({
            model
        })).toThrow('MODEL_MISMATCH');
        expect(t.create).not.toHaveBeenCalled();
        expect(t.snapshot().spentUsd).toBe(0);
    });
    it(("saves a reservation before dispatch, settles exact closed usage and preserves cancellation/retr" + "y zero"), async () => {
        const events: string[] = [];
        const options = {
            signal: new AbortController().signal, maxRetries: 9
        };
        const create = vi.fn(async (_body, actual) => { events.push('sent'); expect(actual).toEqual({
            ...options, maxRetries: 0
        }); return response(); });
        const t = fullrunTransport({
            messages: {
                create
            }
        } as never, {
            deadline: 20, now: () => 1,
            save: value => { events.push('saved'); if (!events.includes('sent'))
                expect(value.reservedUsd).toBeGreaterThan(4); }, stop() { }
        });
        await t.client.messages.create(body() as never, options as never);
        await t.drain();
        expect(events.slice(0, 2)).toEqual([
            'saved', 'sent'
        ]);
        expect(t.snapshot()).toMatchObject({
            calls: 1, reservedUsd: 0, pending: 0, complete: true
        });
        expect(t.snapshot().spentUsd).toBeGreaterThan(0);
    });
    it('waits for a concurrent reservation to settle when known plus next still fits', async () => {
        let resolve!: (value: Anthropic.Message) => void;
        let n = 0;
        const t = fixture(vi.fn(() => ++n === 1 ? new Promise<Anthropic.Message>(yes => { resolve = yes; }) : Promise.resolve(response())));
        const first = t.call();
        const second = t.call();
        await vi.waitFor(() => expect(t.create).toHaveBeenCalledTimes(1));
        resolve(response());
        await first;
        await second;
        await t.drain();
        expect(t.create).toHaveBeenCalledTimes(2);
        expect(t.snapshot().priorYen).toBe(144);
    });
    it.each([
        'missing', 'throw'
    ])('unknown %s usage keeps the bound and permanently prevents another request', async (kind) => {
        const t = fixture(vi.fn(async () => { if (kind === 'throw')
            throw new Error('synthetic'); return response({
            output_tokens: undefined
        }); }));
        await expect(t.call()).rejects.toThrow();
        await t.drain();
        expect(t.snapshot()).toMatchObject({
            complete: false, calls: 1, accepting: false
        });
        expect(t.snapshot().reservedUsd).toBeGreaterThan(4);
        expect(() => t.call()).toThrow('CLOSED');
        expect(t.create).toHaveBeenCalledTimes(1);
    });
    it('cannot send on failed durable reservation or after stop/deadline', async () => {
        const create = vi.fn();
        const t = fullrunTransport({
            messages: {
                create
            }
        } as never, {
            deadline: 20, now: () => 1, save() { throw new Error('disk'); }, stop() { }
        });
        await expect(t.client.messages.create(body() as never)).rejects.toThrow('disk');
        expect(create).not.toHaveBeenCalled();
        const closed = fixture();
        closed.stopAccepting();
        expect(() => closed.call()).toThrow('CLOSED');
        expect(closed.create).not.toHaveBeenCalled();
    });
    it('rejects unbounded server fees/streaming and drains pending paid work', async () => {
        const t = fixture();
        expect(() => t.call({
            tools: [
                {
                    type: 'web_search_20260209'
                }
            ]
        })).toThrow('SERVER_TOOL');
        expect(t.create).not.toHaveBeenCalled();
        const s = fixture();
        expect(() => s.call({
            stream: true
        })).toThrow('REQUEST_SHAPE');
        let resolve!: (v: Anthropic.Message) => void;
        const pending = fixture(vi.fn(() => new Promise<Anthropic.Message>(yes => { resolve = yes; })));
        const work = pending.call();
        await vi.waitFor(() => expect(pending.create).toHaveBeenCalledTimes(1));
        pending.stopAccepting();
        let done = false;
        const drained = pending.drain().then(() => { done = true; });
        await Promise.resolve();
        expect(done).toBe(false);
        resolve(response());
        await work;
        await drained;
        expect(done).toBe(true);
        expect(closedUsage(response().usage)).toBe(true);
    });
    it('binds provider count and explicit margin to an immutable request/hash and same beta header', async () => {
        let resolve!: (value: {
            input_tokens: number;
        }) => void;
        const countTokens = vi.fn((_b, _o) => new Promise<{
            input_tokens: number;
        }>(yes => { resolve = yes; }));
        const create = vi.fn(async (b, _o) => { expect(b.messages[0].content).toBe('original'); return response(); });
        const t = fullrunTransport({
            messages: {
                create, countTokens
            }
        } as never, {
            deadline: 20000, now: () => 1, save() { }, stop() { }
        });
        const request: Record<string, any> = body({
            messages: [
                {
                    role: 'user', content: 'original'
                }
            ]
        });
        const started = t.client.messages.create(request as never, {
            headers: {
                'anthropic-beta': 'synthetic-beta'
            }
        } as never);
        await vi.waitFor(() => expect(countTokens).toHaveBeenCalledTimes(1));
        request.messages[0].content = 'mutated';
        resolve({
            input_tokens: 1000
        });
        await started;
        await t.drain();
        expect(countTokens.mock.calls[0][0]).not.toHaveProperty('max_tokens');
        expect(countTokens.mock.calls[0][1]).toMatchObject({
            headers: {
                'anthropic-beta': 'synthetic-beta'
            }, maxRetries: 0
        });
        expect(t.snapshot().lastAdmission).toMatchObject({
            method: 'provider-estimate-plus-margin', inputEstimate: 1000, inputReservation: 5096
        });
        expect(t.snapshot().lastAdmission!.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    });
    it(("falls back conservatively on free count failure and blocks inference when known spend plus next" + " cannot fit"), async () => {
        const create = vi.fn(async () => response({
            input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 900000
        }));
        const t = fullrunTransport({
            messages: {
                create, countTokens: vi.fn(async () => { throw new Error('count unavailable'); })
            }
        } as never, {
            deadline: 20000, now: () => 1, save() { }, stop() { }
        });
        await t.client.messages.create(body() as never);
        await t.drain();
        expect(t.snapshot().lastAdmission?.method).toBe('full-context-fallback');
        await expect(t.client.messages.create(body() as never)).rejects.toThrow('RESERVATION_LIMIT');
        expect(create).toHaveBeenCalledTimes(1);
    });
    it('rejects model mismatch before free counting and rechecks cancellation after counting', async () => {
        let resolve!: (v: {
            input_tokens: number;
        }) => void;
        const countTokens = vi.fn(() => new Promise<{
            input_tokens: number;
        }>(yes => { resolve = yes; }));
        const create = vi.fn();
        const t = fullrunTransport({
            messages: {
                create, countTokens
            }
        } as never, {
            deadline: 20000, now: () => 1, save() { }, stop() { }
        });
        expect(() => t.client.messages.create(body({
            model: 'claude-opus-5-5'
        }) as never)).toThrow('MODEL_MISMATCH');
        expect(countTokens).not.toHaveBeenCalled();
        const controller = new AbortController();
        const u = fullrunTransport({
            messages: {
                create, countTokens
            }
        } as never, {
            deadline: 20000, now: () => 1, save() { }, stop() { }
        });
        const promise = u.client.messages.create(body() as never, {
            signal: controller.signal
        } as never);
        await vi.waitFor(() => expect(countTokens).toHaveBeenCalledTimes(1));
        controller.abort();
        resolve({
            input_tokens: 1000
        });
        await expect(promise).rejects.toThrow('ABORTED');
        expect(create).not.toHaveBeenCalled();
    });
    it('stops on a closed usage receipt exceeding the explicit counted margin', async () => {
        const create = vi.fn(async () => response({
            input_tokens: 50000
        }));
        const t = fullrunTransport({
            messages: {
                create, countTokens: vi.fn(async () => ({
                    input_tokens: 1000
                }))
            }
        } as never, {
            deadline: 20000, now: () => 1, save() { }, stop() { }
        });
        await expect(t.client.messages.create(body() as never)).rejects.toThrow('BOUND_EXCEEDED');
        await t.drain();
        expect(t.snapshot()).toMatchObject({
            accepting: false, complete: false, reservedUsd: 0
        });
        expect(t.snapshot().spentUsd).toBeGreaterThan(0);
    });
});
const expected = {
    scopeKey: 'owner', taskId: 'original', bodyId: 'minecraft:rig', sessionId: 'current-read',
    connectionId: 'connection', goal: FULLRUN_GOAL, completionCriteria: 'native'
};
const proofDeadline = Date.parse('2026-11-05T00:00:10Z');
function proof() {
    const contextKey = createHash('sha256').update(JSON.stringify([
        expected.scopeKey, expected.taskId, expected.bodyId,
        expected.goal, expected.completionCriteria
    ])).digest('hex');
    return {
        ...expected, contextKey, connected: true, boss: {
            verified: true, entity: 'ender_dragon', dimension: 'the_end',
            witness: {
                bodyId: expected.bodyId, connectionId: expected.connectionId, sessionId: 'earlier-attacking-act', generation: 2,
                entityId: 42, damages: 1, via: [
                    'sword'
                ], lastDamageAt: '2026-11-05T00:00:00Z', observedAt: '2026-11-05T00:00:10Z'
            }
        }
    };
}
describe('original task native kill measurement', () => {
    it('requires the actual pinned revision and a native catalog hash matching the received catalog', () => {
        const native = [
            {
                name: 'act', readOnly: false
            }
        ];
        const revision = 'a'.repeat(40);
        const reserved = {
            name: 'goal-evidence', description: 'pinned native source', readOnly: true,
            inputSchema: {
                type: 'object', properties: {}, required: [], additionalProperties: false
            }
        };
        const skills = [
            ...native, reserved
        ];
        const catalogHash = createHash('sha256').update(JSON.stringify(native)).digest('hex').slice(0, 16);
        expect(fullrunBodyHandshake(revision, {
            revision, catalogHash
        }, skills, reserved).ok).toBe(true);
        expect(fullrunBodyHandshake(revision, {
            revision: 'unknown', catalogHash
        }, skills, reserved).ok).toBe(false);
        expect(fullrunBodyHandshake(revision, {
            revision, catalogHash
        }, native, reserved).ok).toBe(false);
        expect(fullrunBodyHandshake(revision, {
            revision, catalogHash
        }, [
            ...native, reserved, reserved
        ], reserved).ok).toBe(false);
        expect(fullrunBodyHandshake(revision, {
            revision, catalogHash
        }, [
            ...native, {
                ...reserved, description: 'changed'
            }
        ], reserved).ok).toBe(false);
    });
    it('accepts the body native causal proof, including an earlier attacking action in this same task', () => {
        expect(fullrunNativeProof(proof(), expected, proofDeadline)).toBe(true);
    });
    it.each([
        'taskId', 'bodyId', 'scopeKey', 'connectionId', 'sessionId', 'contextKey'
    ])('rejects stale/different %s', key => {
        expect(fullrunNativeProof({
            ...proof(), [key]: 'stale'
        }, expected, proofDeadline)).toBe(false);
    });
    it('rejects enter End, old advancement and a completed task without witnessed damage/death', () => {
        expect(fullrunNativeProof({
            ...proof(), boss: {
                verified: false, advancement: 'earned_before_connection'
            }
        }, expected, proofDeadline)).toBe(false);
        expect(fullrunNativeProof({
            status: 'completed', dimension: 'the_end'
        }, expected, proofDeadline)).toBe(false);
        expect(fullrunNativeProof(proof(), {
            ...expected, goal: 'enter the End'
        }, proofDeadline)).toBe(false);
        expect(fullrunNativeProof({
            ...proof(), boss: {
                ...proof().boss, witness: {
                    ...proof().boss.witness, connectionId: 'old'
                }
            }
        }, expected, proofDeadline)).toBe(false);
    });
    it(("accepts a predeadline witness collected later, while rejecting an actual witness one millisecon" + "d after the mission"), () => {
        expect(fullrunNativeProof(proof(), expected, proofDeadline)).toBe(true);
        const late = {
            ...proof(), boss: {
                ...proof().boss, witness: {
                    ...proof().boss.witness, observedAt: '2026-11-05T00:00:10.001Z'
                }
            }
        };
        expect(fullrunNativeProof(late, expected, proofDeadline)).toBe(false);
    });
});
