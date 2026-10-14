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

export function validFcaExpectation(value: unknown): value is FcaActionExpectation { return fcaExpectationProblem(value) === null; }

/**
 * Why an expectation is not valid, as a closed reason, or null when it is. The one definition of validity: the decoder answers the
 * model with the reason (Minecraft operator run 5, 2026-10-14, task 68395576: one invalid expectation beside a valid action left the
 * whole step unknown and the task paused), and the evidence store refuses anything else.
 */
export type FcaExpectationProblem = 'not_object' | 'call_id' | 'source' | 'observable' | 'text_contains_text' | 'text_contains_expected'
  | 'json_pointer_path' | 'transport_success' | 'expected' | 'probability' | 'expected_value' | 'within_ms';
export function fcaExpectationProblem(value: unknown): FcaExpectationProblem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not_object';
  const item = value as FcaActionExpectation;
  if (typeof item.callId !== 'string' || item.callId.length === 0 || item.callId.length > 200) return 'call_id';
  if (item.source !== 'tool_result') return 'source';
  return observableProblem(item) ?? numbersProblem(item);
}
function observableProblem(item: FcaActionExpectation): FcaExpectationProblem | null {
  const observable = item.observable as Record<string, unknown> | null | undefined;
  if (!observable || typeof observable !== 'object') return 'observable';
  const keys = Object.keys(observable).sort().join(',');
  if (observable.kind === 'text_contains' && keys === 'kind,text') {
    if (typeof observable.text !== 'string' || observable.text.length === 0 || observable.text.length > 240) return 'text_contains_text';
    return typeof item.expected === 'boolean' ? null : 'text_contains_expected';
  }
  if (observable.kind !== 'json_pointer' || keys !== 'kind,path') return 'observable';
  const path = observable.path;
  if (typeof path !== 'string' || path.length > 240 || !/^\/(?:[^~]|~[01])*$/u.test(path)) return 'json_pointer_path';
  return ['/ok', '/success'].includes(path) ? 'transport_success' : null;
}
function numbersProblem(item: FcaActionExpectation): FcaExpectationProblem | null {
  const expected = item.expected;
  if (!(expected === null || typeof expected === 'boolean' || typeof expected === 'string' && expected.length <= 240
    || typeof expected === 'number' && Number.isFinite(expected))) return 'expected';
  const probability = item.probability, value = item.expectedValue;
  if (!(probability === null || typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1)) return 'probability';
  if (!(value === null || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1)) return 'expected_value';
  return Number.isSafeInteger(item.withinMs) && item.withinMs >= 1 && item.withinMs <= 86_400_000 ? null : 'within_ms';
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
