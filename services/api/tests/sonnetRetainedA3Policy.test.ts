import { describe, expect, it, vi } from 'vitest';
import { A2_CLOSED_REPORT_SHA, A2_RECONCILIATION_SHA, A2_SAVED_WORLD_TREE_SHA,
    RETAINED_A3_SONNET_PROFILE, fullrunLaunchPolicy, retainedFullrunPolicy } from '../scripts/sonnetRetainedPolicy.js';
import { FULLRUN_MODEL, fullrunTransport } from '../scripts/sonnetFullrunPolicy.js';

const expected = { headCommit: 'a'.repeat(40), bodyCommit: 'b'.repeat(40), pinsSha256: 'c'.repeat(64) };
const approval = () => ({ rootApproved: true, attempt: 'a3', profile: RETAINED_A3_SONNET_PROFILE,
    priorBookedYen: 1919, additionalCapYen: 2962, globalCapYen: 4881, productionReserveYen: 9600,
    maxSeconds: 10800, sourceAttempt: 'a2', sourceClosedCumulativeBookedYen: 1919,
    sourceReportSha256: A2_CLOSED_REPORT_SHA, sourceReconciliationSha256: A2_RECONCILIATION_SHA,
    sourceWorldTreeSha256: A2_SAVED_WORLD_TREE_SHA, sourceWorldManifestSha256: 'd'.repeat(64),
    sourcePlayerUuid: '289e7388-a54c-3c67-9d68-61a45cf660ba', expectedDimension: 'overworld',
    otherPaidLanesStopped: true, noAutomaticRetry: true, ...expected });
const parts = () => ({ deadline: 20000, now: () => 1, save() {}, stop() {} });

describe('root-bound a3 uses only the closed a2 remainder', () => {
    it('binds the exact a3 tuple and a2 source, while the future target version is bound separately', () => {
        expect(retainedFullrunPolicy(approval(), expected)).toEqual({ profile: RETAINED_A3_SONNET_PROFILE,
            initialDimension: 'overworld', budget: { capYen: 4881, priorYen: 1919 } });
        for (const changed of [{ attempt: 'a4' }, { sourceAttempt: 'a1' }, { priorBookedYen: 881 },
            { additionalCapYen: 4000 }, { globalCapYen: 4919 }, { productionReserveYen: 0 },
            { sourceReportSha256: '0'.repeat(64) }, { sourceReconciliationSha256: '0'.repeat(64) },
            { sourceWorldTreeSha256: '0'.repeat(64) }, { sourcePlayerUuid: 'other' },
            { bodyCommit: 'f'.repeat(40) }, { rootApproved: 1 }, { noAutomaticRetry: false }]) {
            expect(() => retainedFullrunPolicy({ ...approval(), ...changed }, expected)).toThrow('ROOT_APPROVAL');
        }
    });

    it('cannot use an a2 approval under an a3 profile, before any credential/client work', () => {
        const env = { FULLRUN_PROFILE: RETAINED_A3_SONNET_PROFILE, FULLRUN_ROOT_APPROVAL: '/private/a3.json',
            FULLRUN_APPROVAL_SHA256: 'e'.repeat(64), FULLRUN_HEAD_REV: expected.headCommit,
            FULLRUN_BODY_REV: expected.bodyCommit, FULLRUN_PINS_SHA256: expected.pinsSha256 };
        const read = vi.fn(() => approval());
        expect(fullrunLaunchPolicy(env, read).budget).toEqual({ capYen: 4881, priorYen: 1919 });
        expect(() => fullrunLaunchPolicy({ ...env, FULLRUN_PROFILE: 'retained-self-earned-sonnet-v1' }, read))
            .toThrow('ROOT_APPROVAL');
        expect(() => fullrunLaunchPolicy({ ...env, FULLRUN_PROFILE: 'model-selected' }, read)).toThrow('PROFILE_INVALID');
    });

    it('never admits a reservation beyond the remaining2962, and keeps count/dispatch on the same request', async () => {
        const create = vi.fn(async () => ({ model: FULLRUN_MODEL,
            usage: { input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
        const countTokens = vi.fn(async () => ({ input_tokens: 500 }));
        const t = fullrunTransport({ messages: { create, countTokens } } as never,
            { ...parts(), budget: retainedFullrunPolicy(approval(), expected).budget });
        const request = { model: FULLRUN_MODEL, max_tokens: 1000, messages: [] };
        let refused = false;
        for (let i = 0; i < 3000; i++) {
            try { await t.client.messages.create(request as never); }
            catch { refused = true; break; }
            const s = t.snapshot();
            expect(s.priorYen + s.admissionKnownYen + s.admissionReservedYen).toBeLessThanOrEqual(4881);
        }
        await t.drain();
        expect(refused).toBe(true);
        expect(t.snapshot()).toMatchObject({ capYen: 4881, priorYen: 1919, accepting: false, complete: true });
        expect(t.snapshot().calls).toBeGreaterThan(2800);
        expect(t.snapshot().calls).toBeLessThanOrEqual(2962);
        expect(countTokens.mock.calls.length).toBe(create.mock.calls.length + 1);
    });

    it('retains uncertain usage and refuses arbitrary prior values without a count/create', async () => {
        const create = vi.fn(async () => { throw new Error('synthetic transport unknown'); });
        const countTokens = vi.fn(async () => ({ input_tokens: 500 }));
        for (const priorYen of [1918, 1920, 0]) {
            expect(() => fullrunTransport({ messages: { create, countTokens } } as never,
                { ...parts(), budget: { capYen: 4881, priorYen } })).toThrow('INTERNAL_BUDGET_POLICY');
        }
        expect(countTokens).not.toHaveBeenCalled();
        const t = fullrunTransport({ messages: { create, countTokens } } as never,
            { ...parts(), budget: { capYen: 4881, priorYen: 1919 } });
        await expect(t.client.messages.create({ model: FULLRUN_MODEL, max_tokens: 1000, messages: [] } as never)).rejects.toThrow();
        await t.drain();
        expect(t.snapshot()).toMatchObject({ complete: false, accepting: false, calls: 1 });
        expect(t.snapshot().reservedUsd).toBeGreaterThan(0);
        expect(() => t.client.messages.create({ model: FULLRUN_MODEL, max_tokens: 1000, messages: [] } as never))
            .toThrow('CLOSED');
        expect(create).toHaveBeenCalledTimes(1);
    });
});
