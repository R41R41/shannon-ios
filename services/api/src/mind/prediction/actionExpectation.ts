/** Optional, public pre-action facts. Free text stays in FCA working history, never the closed prediction ledger. */
export interface FcaActionExpectation {
  callId: string;
  source: 'tool_result';
  observable: { kind: 'json_pointer'; path: string } | { kind: 'text_contains'; text: string };
  expected: string | number | boolean | null;
  probability: number | null;
  expectedValue: number | null;
  withinMs: number;
}
export type FcaExpectationComparison =
  | { status: 'pending' | 'unobserved'; actual: null; mismatch: null }
  | { status: 'observed' | 'mismatch'; actual: string | number | boolean | null; mismatch: boolean };

export function validFcaExpectation(value: unknown): value is FcaActionExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as FcaActionExpectation;
  const scalar = item.expected === null || typeof item.expected === 'boolean' || typeof item.expected === 'string' && item.expected.length <= 240
    || typeof item.expected === 'number' && Number.isFinite(item.expected);
  const observable = item.observable;
  return typeof item.callId === 'string' && item.callId.length > 0 && item.callId.length <= 200 && item.source === 'tool_result'
    && !!observable && (observable.kind === 'text_contains' && Object.keys(observable).sort().join(',') === 'kind,text'
      && typeof observable.text === 'string' && observable.text.length > 0
      && observable.text.length <= 240 && typeof item.expected === 'boolean'
      || observable.kind === 'json_pointer' && Object.keys(observable).sort().join(',') === 'kind,path'
      && typeof observable.path === 'string' && observable.path.length <= 240
      && /^\/(?:[^~]|~[01])*$/u.test(observable.path) && !['/ok', '/success'].includes(observable.path))
    && scalar && (item.probability === null || typeof item.probability === 'number' && Number.isFinite(item.probability) && item.probability >= 0 && item.probability <= 1)
    && (item.expectedValue === null || typeof item.expectedValue === 'number' && Number.isFinite(item.expectedValue) && Math.abs(item.expectedValue) <= 1)
    && Number.isSafeInteger(item.withinMs) && item.withinMs >= 1 && item.withinMs <= 86_400_000;
}

/** Transport success grants access to evidence; it is never itself the predicted fact or value. */
export function compareFcaOutcome(expectation: FcaActionExpectation, result: { ok: boolean; text: string } | null,
  expired: boolean): FcaExpectationComparison {
  let known = false, actual: unknown;
  if (result?.ok) {
    if (expectation.observable.kind === 'text_contains') {
      known = true; actual = result.text.includes(expectation.observable.text);
    } else {
      try {
        actual = JSON.parse(result.text) as unknown;
        known = true;
        for (const encoded of expectation.observable.path.slice(1).split('/')) {
          const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
          if (!actual || typeof actual !== 'object' || !Object.hasOwn(actual, key)) { known = false; break; }
          actual = (actual as Record<string, unknown>)[key];
        }
        if (!(actual === null || typeof actual === 'boolean' || typeof actual === 'string' || typeof actual === 'number' && Number.isFinite(actual))) known = false;
      } catch { known = false; }
    }
  }
  if (!known) return { status: expired ? 'unobserved' : 'pending', actual: null, mismatch: null };
  const mismatch = actual !== expectation.expected;
  return { status: mismatch ? 'mismatch' : 'observed', actual: actual as string | number | boolean | null, mismatch };
}
