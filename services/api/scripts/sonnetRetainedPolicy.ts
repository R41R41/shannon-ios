import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const RETAINED_SONNET_PROFILE = 'retained-self-earned-sonnet-v1';
export const RETAINED_A3_SONNET_PROFILE = 'retained-self-earned-sonnet-a3-v1';
export const A2_CLOSED_REPORT_SHA = 'ee3dd6430fea26c26f4c5089c95d7d4827b7faf99592de937e5355d1f8340572';
export const A2_RECONCILIATION_SHA = '6b2774a84c0a79c80694cfe94f7b1137097e6170488890376baa77c2885a95e3';
export const A2_SAVED_WORLD_TREE_SHA = '37aaa6118d3058ad37e3e79cb6d899a151aa30e06150c5c41d466b9a93e541c4';
export type FullrunLaunchPolicy = {
    profile: 'natural-sonnet-v1' | typeof RETAINED_SONNET_PROFILE | typeof RETAINED_A3_SONNET_PROFILE;
    initialDimension: string;
    budget?: { capYen: number; priorYen: number };
};
type Expected = { headCommit: string; bodyCommit: string; pinsSha256: string };
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** An internal root approval, never a model/tool input. Only this explicitly approved continuation has a larger cap. */
export function retainedFullrunPolicy(value: unknown, expected: Expected): FullrunLaunchPolicy {
    const v = value as Record<string, unknown> | null;
    const a3 = v?.profile === RETAINED_A3_SONNET_PROFILE;
    const profile = a3 ? RETAINED_A3_SONNET_PROFILE : RETAINED_SONNET_PROFILE;
    const priorYen = a3 ? 1919 : 881;
    const exact = {
        rootApproved: true, attempt: a3 ? 'a3' : 'a2', profile,
        priorBookedYen: priorYen, additionalCapYen: a3 ? 2962 : 4000, globalCapYen: 4881,
        productionReserveYen: 9600, maxSeconds: 10800, sourceAttempt: a3 ? 'a2' : 'a1', sourceClosedCumulativeBookedYen: priorYen,
        otherPaidLanesStopped: true, noAutomaticRetry: true,
        ...(a3 ? { sourceReportSha256: A2_CLOSED_REPORT_SHA, sourceReconciliationSha256: A2_RECONCILIATION_SHA,
            sourceWorldTreeSha256: A2_SAVED_WORLD_TREE_SHA, sourcePlayerUuid: '289e7388-a54c-3c67-9d68-61a45cf660ba' } : {}),
        ...expected
    };
    if (!v || Object.entries(exact).some(([key, wanted]) => v[key] !== wanted)
        || !/^[a-f0-9]{40}$/u.test(expected.headCommit) || !/^[a-f0-9]{40}$/u.test(expected.bodyCommit)
        || !hash(expected.pinsSha256) || !hash(v.sourceWorldManifestSha256) || !hash(v.sourceWorldTreeSha256)
        || !['overworld', 'the_nether', 'the_end'].includes(String(v.expectedDimension)))
        throw new Error('FULLRUN_RETAINED_ROOT_APPROVAL_INVALID');
    return { profile, initialDimension: String(v.expectedDimension), budget: { capYen: 4881, priorYen } };
}

function readApproval(file: string, expectedSha: string): unknown {
    if (!hash(expectedSha)) throw new Error('FULLRUN_RETAINED_APPROVAL_SHA');
    const real = fs.realpathSync(file);
    const stat = fs.lstatSync(file);
    if (!real.startsWith('/home/azureuser/.cache/minebot-lab/') || !stat.isFile()
        || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error('FULLRUN_RETAINED_APPROVAL_PRIVATE_FILE');
    const bytes = fs.readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha)
        throw new Error('FULLRUN_RETAINED_APPROVAL_SHA');
    return JSON.parse(bytes.toString('utf8'));
}

/** Checked before any credential is opened. The existing fresh profile ignores no budget override. */
export function fullrunLaunchPolicy(env: Readonly<Record<string, string | undefined>>,
    approved: (file: string, sha: string) => unknown = readApproval): FullrunLaunchPolicy {
    if (env.FULLRUN_PROFILE === 'natural-sonnet-v1') {
        if (env.FULLRUN_ROOT_APPROVAL || env.FULLRUN_APPROVAL_SHA256)
            throw new Error('FULLRUN_FRESH_APPROVAL_OVERRIDE_REFUSED');
        return { profile: 'natural-sonnet-v1', initialDimension: 'overworld' };
    }
    if (env.FULLRUN_PROFILE !== RETAINED_SONNET_PROFILE && env.FULLRUN_PROFILE !== RETAINED_A3_SONNET_PROFILE)
        throw new Error('FULLRUN_PROFILE_INVALID');
    const value = approved(env.FULLRUN_ROOT_APPROVAL ?? '', env.FULLRUN_APPROVAL_SHA256 ?? '') as Record<string, unknown> | null;
    if (!value || value.profile !== env.FULLRUN_PROFILE) throw new Error('FULLRUN_RETAINED_ROOT_APPROVAL_INVALID');
    return retainedFullrunPolicy(value, {
        headCommit: env.FULLRUN_HEAD_REV ?? '', bodyCommit: env.FULLRUN_BODY_REV ?? '',
        pinsSha256: env.FULLRUN_PINS_SHA256 ?? ''
    });
}
