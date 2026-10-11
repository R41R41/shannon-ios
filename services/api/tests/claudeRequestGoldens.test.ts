import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_SCENARIOS } from './support/claudeBackgroundScenarios.js';
import { EDGE_SCENARIOS } from './support/claudeEdgeScenarios.js';
import { FOREGROUND_SCENARIOS, SCENARIO_TIME, type ClaudeScenario } from './support/claudeForegroundScenarios.js';
import { cacheReceiptsTaken, forgetCacheReceipts, recordingFetch, usageLedger, type RecordedRequest } from './support/claudeRequestRecorder.js';

/**
 * The provider request goldens (Syzygy ADR-0009 stage 1, M2): for each synthetic scenario, every request the official SDK
 * hands to `fetch` (method, URL, headers, body bytes), the usage it booked, the cache receipts it left and what the caller
 * returned, all from recorded provider responses. They are the parity contract of the model layer's later steps: the
 * transport extraction (M3) changes none of them. Regenerate only for a deliberate change of what is sent or booked:
 * `SHANNON_WRITE_GOLDEN=1 vitest run claudeRequestGoldens`. Without that setting nothing is written: a missing golden fails.
 *
 * The recorded headers include the SDK's own (`user-agent`, `x-stainless-package-version`, the beta header): an upgrade of
 * `@anthropic-ai/sdk` changes them in every golden. Regenerate in the upgrade's own commit, after checking that the bodies,
 * the usage and the receipts did not move (`git diff --word-diff` on the fixtures shows only the header lines).
 */
const folder = new URL('./fixtures/claude-requests/', import.meta.url);
const SCENARIOS: readonly ClaudeScenario[] = [...FOREGROUND_SCENARIOS, ...EDGE_SCENARIOS, ...BACKGROUND_SCENARIOS];
const writing = process.env.SHANNON_WRITE_GOLDEN === '1';

interface Golden {
  scenario: string;
  requests: Omit<RecordedRequest, 'raw'>[];
  usage: unknown[];
  cacheReceipts: unknown[];
  outcome: { result: unknown } | { error: Record<string, unknown> };
}

function failure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const extra = error as Error & { code?: unknown; usage?: unknown };
  return { name: error.name, message: error.message, ...(extra.code !== undefined ? { code: extra.code } : {}),
    ...(extra.usage !== undefined ? { usage: extra.usage } : {}) };
}

async function played(scenario: ClaudeScenario): Promise<{ golden: Golden; raw: string[] }> {
  forgetCacheReceipts();
  for (const [name, value] of Object.entries(scenario.env ?? {})) vi.stubEnv(name, value);
  try {
    return await playedUnderEnvironment(scenario);
  } finally {
    vi.unstubAllEnvs();
  }
}

async function playedUnderEnvironment(scenario: ClaudeScenario): Promise<{ golden: Golden; raw: string[] }> {
  const recorder = recordingFetch(scenario.script);
  const ledger = usageLedger();
  let outcome: Golden['outcome'];
  try {
    const result = await scenario.run({ fetcher: recorder.fetcher, store: ledger.store, now: () => SCENARIO_TIME });
    outcome = { result: JSON.parse(JSON.stringify(result ?? null)) as unknown };
  } catch (error) {
    outcome = { error: failure(error) };
  }
  const requests = recorder.requests.map(({ raw: _raw, ...rest }) => rest);
  const golden = { scenario: scenario.name, requests, usage: JSON.parse(JSON.stringify(ledger.rows)) as unknown[], cacheReceipts: cacheReceiptsTaken(), outcome };
  return { golden, raw: recorder.requests.map(request => request.raw) };
}

function goldenFile(name: string): URL {
  return new URL(`${name}.json`, folder);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(SCENARIO_TIME) });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mkdirSync(folder, { recursive: true });
});
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  forgetCacheReceipts();
});

describe('Claude provider request goldens', () => {
  it('has one golden per scenario and no stale golden', () => {
    expect(new Set(SCENARIOS.map(scenario => scenario.name)).size).toBe(SCENARIOS.length);
    if (writing) return;
    const files = readdirSync(folder).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort();
    expect(files).toEqual(SCENARIOS.map(scenario => scenario.name).sort());
  });

  it.each(SCENARIOS.map(scenario => [scenario.name, scenario] as const))('%s sends, books and returns what was recorded', async (_name, scenario) => {
    const current = await played(scenario);
    const file = goldenFile(scenario.name);
    if (writing) writeFileSync(file, `${JSON.stringify(current.golden, null, 1)}\n`);
    expect(existsSync(file), `golden ${scenario.name} (write it with SHANNON_WRITE_GOLDEN=1)`).toBe(true);
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as Golden;
    expect(current.golden.requests.length, 'request count').toBe(recorded.requests.length);
    recorded.requests.forEach((request, index) => {
      expect(current.golden.requests[index]!.url, `url ${index}`).toBe(request.url);
      expect(current.golden.requests[index]!.method, `method ${index}`).toBe(request.method);
      expect(current.golden.requests[index]!.headers, `headers ${index}`).toEqual(request.headers);
      // Byte for byte: the body as sent equals the recorded body, key order included.
      expect(current.raw[index], `body ${index}`).toBe(JSON.stringify(request.body));
    });
    expect(current.golden.usage, 'usage booked').toEqual(recorded.usage);
    expect(current.golden.cacheReceipts, 'cache receipts').toEqual(recorded.cacheReceipts);
    expect(current.golden.outcome, 'outcome').toEqual(recorded.outcome);
  });
});
