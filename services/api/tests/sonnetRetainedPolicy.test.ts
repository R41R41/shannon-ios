import { describe, expect, it, vi } from 'vitest';
import { fullrunLaunchPolicy, retainedFullrunPolicy, RETAINED_SONNET_PROFILE } from '../scripts/sonnetRetainedPolicy.js';
import { fullrunTransport, FULLRUN_MODEL } from '../scripts/sonnetFullrunPolicy.js';

const expected = { headCommit: 'a'.repeat(40), bodyCommit: 'b'.repeat(40), pinsSha256: 'c'.repeat(64) };
const approval = () => ({
    rootApproved: true, attempt: 'a2', profile: RETAINED_SONNET_PROFILE,
    priorBookedYen: 881, additionalCapYen: 4000, globalCapYen: 4881, productionReserveYen: 9600,
    maxSeconds: 10800, sourceAttempt: 'a1', sourceClosedCumulativeBookedYen: 881,
    otherPaidLanesStopped: true, noAutomaticRetry: true, expectedDimension: 'overworld',
    sourceWorldManifestSha256: 'd'.repeat(64), sourceWorldTreeSha256: 'e'.repeat(64), ...expected
});
const parts = () => ({ deadline: 20000, now: () => 1, save() {}, stop() {} });

describe('root-only retained self-earned Sonnet profile', () => {
    it('keeps fresh a1 defaults and does not open an approval/key file', () => {
        const read = vi.fn(() => { throw new Error('must not read'); });
        expect(fullrunLaunchPolicy({ FULLRUN_PROFILE: 'natural-sonnet-v1' }, read)).toEqual({
            profile: 'natural-sonnet-v1', initialDimension: 'overworld'
        });
        expect(read).not.toHaveBeenCalled();
        const t = fullrunTransport({ messages: {} } as never, parts());
        expect(t.snapshot()).toMatchObject({ capYen: 1000, priorYen: 144, calls: 0, countCalls: 0 });
    });

    it('only uses the explicit approved 4000Y continuation, bound to source and actual pins', () => {
        const value = approval();
        expect(retainedFullrunPolicy(value, expected)).toEqual({
            profile: RETAINED_SONNET_PROFILE, initialDimension: 'overworld',
            budget: { capYen: 4881, priorYen: 881 }
        });
        expect(value).toEqual(approval());
        for (const changed of [
            { rootApproved: false }, { rootApproved: 1 }, { additionalCapYen: 5000, globalCapYen: 5881 },
            { priorBookedYen: 144 }, { productionReserveYen: 0 }, { noAutomaticRetry: false },
            { headCommit: 'f'.repeat(40) }, { sourceWorldTreeSha256: '' }, { expectedDimension: 'unknown' }
        ]) expect(() => retainedFullrunPolicy({ ...value, ...changed }, expected)).toThrow('ROOT_APPROVAL');
    });

    it('requires the private approval before selecting a retained policy and rejects a1 override paths', () => {
        const read = vi.fn(() => approval());
        const env = { FULLRUN_PROFILE: RETAINED_SONNET_PROFILE, FULLRUN_ROOT_APPROVAL: '/private/approval.json',
            FULLRUN_APPROVAL_SHA256: 'f'.repeat(64), FULLRUN_HEAD_REV: expected.headCommit,
            FULLRUN_BODY_REV: expected.bodyCommit, FULLRUN_PINS_SHA256: expected.pinsSha256 };
        expect(fullrunLaunchPolicy(env, read).budget).toEqual({ capYen: 4881, priorYen: 881 });
        expect(read).toHaveBeenCalledWith('/private/approval.json', 'f'.repeat(64));
        expect(() => fullrunLaunchPolicy({ ...env, FULLRUN_PROFILE: 'natural-sonnet-v1' }, read))
            .toThrow('FRESH_APPROVAL_OVERRIDE');
        expect(() => fullrunLaunchPolicy({ ...env, FULLRUN_PROFILE: 'model-selected' }, read)).toThrow('PROFILE_INVALID');
    });

    it('refuses arbitrary internal budget increases before a count or inference', () => {
        const create = vi.fn();
        const countTokens = vi.fn();
        for (const budget of [{ capYen: 5881, priorYen: 881 }, { capYen: 4882, priorYen: 881 },
            { capYen: 4881, priorYen: 0 }, { capYen: Infinity, priorYen: 881 }]) {
            expect(() => fullrunTransport({ messages: { create, countTokens } } as never, { ...parts(), budget }))
                .toThrow('INTERNAL_BUDGET_POLICY');
        }
        expect(create).not.toHaveBeenCalled();
        expect(countTokens).not.toHaveBeenCalled();
    });

    it('keeps exact-count reservations and DB-style per-request ceilings inside the 4000Y room', async () => {
        const create = vi.fn(async () => ({ model: FULLRUN_MODEL,
            usage: { input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
        const countTokens = vi.fn(async () => ({ input_tokens: 500 }));
        const policy = retainedFullrunPolicy(approval(), expected);
        const t = fullrunTransport({ messages: { create, countTokens } } as never,
            { ...parts(), budget: policy.budget });
        const request = { model: FULLRUN_MODEL, max_tokens: 1000, messages: [] };
        let refused = false;
        for (let i = 0; i < 4100; i++) {
            try { await t.client.messages.create(request as never); }
            catch { refused = true; break; }
            const s = t.snapshot();
            expect(s.priorYen + s.admissionKnownYen + s.admissionReservedYen).toBeLessThanOrEqual(4881);
        }
        await t.drain();
        expect(refused).toBe(true);
        expect(t.snapshot()).toMatchObject({ capYen: 4881, priorYen: 881, accepting: false, complete: true });
        expect(t.snapshot().calls).toBeGreaterThan(3900);
        expect(t.snapshot().calls).toBeLessThanOrEqual(4000);
        expect(countTokens.mock.calls.length).toBe(create.mock.calls.length + 1);
    });

    it('keeps unknown usage booked and never retries on the retained lane', async () => {
        const create = vi.fn(async () => { throw new Error('synthetic transport unknown'); });
        const t = fullrunTransport({ messages: { create } } as never,
            { ...parts(), budget: retainedFullrunPolicy(approval(), expected).budget });
        const request = { model: FULLRUN_MODEL, max_tokens: 1000, messages: [] };
        await expect(t.client.messages.create(request as never)).rejects.toThrow();
        await t.drain();
        expect(t.snapshot()).toMatchObject({ priorYen: 881, capYen: 4881, complete: false, accepting: false, calls: 1 });
        expect(t.snapshot().reservedUsd).toBeGreaterThan(0);
        expect(() => t.client.messages.create(request as never)).toThrow('CLOSED');
        expect(create).toHaveBeenCalledTimes(1);
    });
});
