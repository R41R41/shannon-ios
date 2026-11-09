import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
/** Native bodyVersion hashes catalog.definitions; the wire additionally offers reserved goal-evidence.
 * The reserved definition is checked separately against the literal extracted from the pinned native source. */
export function fullrunBodyHandshake(expectedRevision: string, version: unknown, skills: unknown, expectedGoalEvidence: unknown) {
    const actual = version as {
        revision?: unknown;
        catalogHash?: unknown;
    } | undefined;
    const rows = Array.isArray(skills) ? skills : [];
    const reserved = rows.filter(row => row?.name === 'goal-evidence');
    const native = rows.filter(row => row?.name !== 'goal-evidence');
    const expected = expectedGoalEvidence as {
        name?: unknown;
        readOnly?: unknown;
    } | undefined;
    const reservedMatches = expected?.name === 'goal-evidence' && expected?.readOnly === true
        && reserved.length === 1 && isDeepStrictEqual(reserved[0], expectedGoalEvidence);
    const catalogHash = Array.isArray(skills) ? createHash('sha256').update(JSON.stringify(native)).digest('hex').slice(0, 16) : null;
    return {
        ok: /^[a-f0-9]{40}$/u.test(expectedRevision) && actual?.revision === expectedRevision
            && catalogHash !== null && actual?.catalogHash === catalogHash && reservedMatches,
        expectedRevision, revision: actual?.revision ?? null, catalogHash: actual?.catalogHash ?? null, computedCatalogHash: catalogHash,
        reservedGoalEvidenceCount: reserved.length, reservedGoalEvidenceMatches: reservedMatches
    };
}
