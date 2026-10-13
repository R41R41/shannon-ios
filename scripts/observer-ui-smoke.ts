/** Explicit local UI test fixture. No model, app, production database, or external service is contacted.
 * pnpm exec tsx scripts/observer-ui-smoke.ts
 * stdin: run | turn | fca-run | fca-next | fca-finish | client-links | handoff | finish | hold | ready | close
 * The browser uses the real assets, pairing route, authentication, observer publisher, and routes.
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AsyncResource } from 'node:async_hooks';
import { SQLiteDeviceAuthStore } from '../services/api/src/infra/auth/deviceAuth.js';
import { createPairingRoute } from '../services/api/src/infra/auth/serverPairingRoute.js';
import { serveObserverAsset, createObserverRoute } from '../services/api/src/infra/observer/observerRoutes.js';
import { startObserverPublisher } from '../services/api/src/infra/observer/store/observerStore.js';
import { observeAsync, observeSync, observedStep, observerHandoff, withObserverRun } from '../services/api/src/infra/observer/observerContext.js';
import { createObserverFcaFixture } from './observer-fca-fixture.js';

const auth = new SQLiteDeviceAuthStore({ path: ':memory:', pepper: randomBytes(32).toString('hex') });
const publisher = startObserverPublisher(':memory:');
if (!publisher) throw new Error('LOCAL_FIXTURE_PUBLISHER_UNAVAILABLE');
let ownerAlone = true;
const fcaFixture = createObserverFcaFixture('ui-fixture-owner', () => ownerAlone);
const pairing = createPairingRoute('paired', auth);
const observer = createObserverRoute({ store: publisher.store, ownerScope: 'ui-fixture-owner', ownerAlone: () => ownerAlone, isGame: () => false });
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (serveObserverAsset(request, response, url.pathname)) return;
  if (url.pathname === '/v1/pair') { await pairing(request, response); return; }
  if (url.pathname.startsWith('/v1/observer/')) { await observer(request, response, url.pathname, auth.authenticate(request.headers.authorization), url); return; }
  response.writeHead(404); response.end();
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('LOCAL_FIXTURE_ADDRESS');
console.log(`LOCAL UI TEST FIXTURE ONLY: http://127.0.0.1:${address.port}/observer`);
console.log(`Temporary fixture pairing code: ${auth.issuePairingCode('ui-fixture-owner').code}`);
console.log('Commands: run / turn / fca-run / fca-next / fca-finish / client-links / handoff / finish / hold / ready / close');

/** Uses the real native-client ingestion contract. All values are controlled test fixtures. */
async function clientLinksFixture() {
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const paired = await fetch(`${base}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.issuePairingCode('ui-fixture-owner').code, deviceName: 'Observer UI client fixture' }) });
  if (!paired.ok) throw new Error('LOCAL_FIXTURE_PAIR_FAILED');
  const { token } = await paired.json() as { token: string };
  const captureRunId = randomUUID(), utteranceRunId = randomUUID(), accepted = randomUUID(), unrelated = randomUUID(), pcm = randomUUID(), join = randomUUID();
  const at = new Date().toISOString();
  const events = [
    { runId: captureRunId, spanId: pcm, parentSpanId: null, node: 'pcm', kind: 'span.completed', at, output: { fixture: true, byteCount: 640, purpose: 'unrelated session PCM must not appear in the selected utterance' } },
    { runId: captureRunId, spanId: accepted, parentSpanId: null, node: 'stt', kind: 'span.started', at, input: { fixture: true, model: 'deterministic-client-fixture' } },
    { runId: captureRunId, spanId: accepted, parentSpanId: null, node: 'stt', kind: 'span.completed', at, output: { fixture: true, characterCount: 5, model: 'deterministic-client-fixture', purpose: 'explicitly accepted source' } },
    { runId: captureRunId, spanId: unrelated, parentSpanId: null, node: 'stt', kind: 'span.completed', at, output: { fixture: true, characterCount: 900, purpose: 'unrelated transcript must not appear in the selected utterance' } },
    { runId: utteranceRunId, spanId: join, parentSpanId: accepted, node: 'join', kind: 'span.completed', at, input: { fixture: true, captureRunId, segmentCount: 1 }, output: { fixture: true, utteranceId: utteranceRunId, characterCount: 5 } },
    { runId: utteranceRunId, spanId: randomUUID(), parentSpanId: join, node: 'join', kind: 'handoff', at, fromNode: 'stt', toNode: 'join', sourceSpanId: accepted, output: { fixture: true, captureRunId } },
  ];
  const sent = await fetch(`${base}/v1/observer/client-events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ events }) });
  if (sent.status !== 202) throw new Error('LOCAL_FIXTURE_CLIENT_EVENTS_REJECTED');
  await withObserverRun({ scopeKey: 'ui-fixture-owner', surface: 'isolated-cross-run-ui-fixture', runId: utteranceRunId }, async () => {
    observeSync('perception', { fixture: true, utteranceId: utteranceRunId }, () => ({ fixture: true, type: 'controlled client correlation check' }), value => value);
  });
  console.log(`CLIENT LINK FIXTURE: utterance=${utteranceRunId} capture=${captureRunId} acceptedSpan=${accepted}; ${events.length} events accepted by the real client route`);
}

let runNumber = 0;
const finishers = new Set<() => void>();
const handoffs = new Set<() => void>();
const gate = () => new Promise<void>(resolve => { const done = () => { finishers.delete(done); resolve(); }; finishers.add(done); });
function runFixture() {
  runNumber += 1;
  const runId = `UI-FIXTURE-conversation-${runNumber}`;
  void withObserverRun({ scopeKey: 'ui-fixture-owner', surface: 'isolated-ui-test', runId }, async () => {
    observeSync('perception', { fixture: true, input: 'ローカルUI検証。実際の会話ではありません。' }, () => ({ type: 'fixture' }), value => value);
    await observeAsync('jevv', { fixture: true }, async () => ({ shouldRespond: true, fixture: true }), value => value, { model: 'deterministic-ui-fixture' });
    await observeAsync('jevt', { offeredTools: ['study.search', 'study.read'], fixture: true }, async () => ({ selectedTools: ['study.search', 'study.read'], fixture: true }), value => value, { model: 'deterministic-ui-fixture' });
    observeSync('context', { fixture: true, count: 2 }, () => ({ projection: 'UI TEST ONLY' }), value => value);
    await observeAsync('native', { offeredTools: ['study.search', 'study.read'], fixture: true }, async () => {
      await observeAsync('llm', { fixture: true, operation: 'controlled test gate' }, async () => {
        const handoff = AsyncResource.bind(() => observerHandoff('llm', 'tools', { fixture: true }));
        handoffs.add(handoff);
        observerHandoff('native', 'llm', { fixture: true });
        await Promise.all(['study.search', 'study.read'].map(name => observeAsync('tools', { name, fixture: true, arguments: { query: 'UI test fixture only' } }, async () => {
          await gate(); return { name, fixture: true, result: '制御された検証処理が完了しました。' };
        }, value => value)));
        handoffs.delete(handoff);
        return { selectedTools: ['study.search', 'study.read'], fixture: true };
      }, value => value, { model: 'deterministic-ui-fixture' });
      return { fixture: true, completed: true };
    }, value => value);
    observeSync('decode', { fixture: true }, () => ({ reply: 'これはUI検証の出力です。<script>文字列は実行されません</script>', fixture: true }), value => value);
  }).then(() => console.log(`Closed ${runId}`));
  void withObserverRun({ scopeKey: 'ui-fixture-owner', surface: 'isolated-background-test', runId: `UI-FIXTURE-background-${runNumber}` }, async () => {
    await observeAsync('memory', { fixture: true, job: 'controlled parallel test gate' }, async () => { await gate(); return { fixture: true, written: 0 }; }, value => value);
  });
  console.log(`Started ${runId} and a separate background run`);
}
/** A current-architecture text turn (2026-10-13 shape) with turn steps, parallel preparation, a tool round and one failed tool.
 * Every value is a controlled fixture; nothing is a real conversation. Timings are local sleeps, not provider latency. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* a measured synchronous step */ } };
function turnFixture() {
  runNumber += 1;
  const runId = `UI-FIXTURE-turn-${runNumber}`;
  void withObserverRun({ scopeKey: 'ui-fixture-owner', surface: 'text', runId }, async () => {
    observeSync('recall', { fixture: true, message: '[fixture]', threadId: 'fixture-thread' }, () => {
      for (const [step, ms] of [['orchestration', 18], ['command', 2], ['snapshot', 30], ['people', 12], ['deterministic', 34]] as const) observedStep(step, () => spin(ms));
      return { fixture: true };
    }, () => ({ snapshotVersion: 7, peopleCount: 1, explicitCommand: false }));
    observeSync('perception', { fixture: true, audience: 'owner' }, () => ({ fixture: true }), () => ({ eventId: 'fixture-event' }));
    await Promise.all([
      observeAsync('jevt', { surface: 'text', offeredTools: ['memory.search', 'study.read', 'web.search'], difficulty: 'normal' }, async () => {
        await observeAsync('llm', { provider: 'jev', questionCount: 2 }, async () => { await sleep(380); return { fixture: true }; }, () => ({ status: 'ok' }));
        return { difficulty: 'normal' };
      }, () => ({ difficulty: 'normal', toolMenu: 3 })),
      observeAsync('recall', { fixture: true, message: '[fixture]', semantic: true }, async () => {
        await sleep(160);
        await observeAsync('llm', { provider: 'jev', questionCount: 1 }, async () => { await sleep(420); return { fixture: true }; }, () => ({ status: 'ok' }));
        return { recalledCount: 4 };
      }, value => value),
    ]);
    observerHandoff('recall', 'context', { recalledCount: 4 });
    for (const [step, ms] of [['identity', 6], ['threadSummary', 22], ['provenance', 4], ['toolOffer', 9], ['replay', 14], ['fcaContext', 20]] as const) observedStep(step, () => spin(ms));
    observeSync('context', { fixture: true, taskId: 'fixture-conversation-task', revision: 1 }, () => ({ fixture: true }), () => ({ tools: 3, messages: 12 }));
    observerHandoff('context', 'jevt', { phase: 'fca_selection', offeredCount: 3 });
    await observeAsync('jevt', { selector: 'fca', offeredCount: 3, offeredTools: ['memory.search', 'study.read', 'web.search'] }, async () => { await sleep(260); return ['memory.search', 'web.search']; }, names => ({ chosenTools: names }));
    observerHandoff('context', 'native', { surface: 'text' });
    const round = async (index: number, ms: number, stop: string) => {
      observeSync('native', { model: 'claude-haiku-5-5', historyMessageCount: 12, deliveredMessageCount: 8, offeredTools: ['memory.search', 'web.search'] }, () => ({ fixture: true }), () => ({ messageCount: 8, maximumOutputTokens: 1024 }));
      observerHandoff('native', 'llm', { model: 'claude-haiku-5-5', round: index });
      return observeAsync('llm', { model: 'claude-haiku-5-5', round: index, streaming: true, messageCount: 8 }, async () => { await sleep(ms); return stop; },
        value => ({ stop: value, cacheReadInputTokens: 5800 + index * 400, cacheCreationInputTokens: 0, ...(value === 'end_turn' ? { firstVisibleOutputAfterMs: 310 } : {}) }), { model: 'claude-haiku-5-5' });
    };
    await round(1, 700, 'tool_use');
    observerHandoff('llm', 'gate', { model: 'claude-haiku-5-5' });
    observeSync('gate', { phase: 'gate', tool: 'memory.search' }, () => ({ fixture: true }), () => ({ allowed: true }));
    await Promise.allSettled([
      observeAsync('tools', { name: 'memory.search', fixture: true }, async () => { await sleep(180); return { fixture: true, results: 3 }; }, value => value),
      observeAsync('tools', { name: 'web.search', fixture: true }, async () => { await sleep(120); throw new TypeError('fixture failure'); }, value => value),
    ]);
    observerHandoff('tools', 'llm', { resultCount: 2, model: 'claude-haiku-5-5' });
    await round(2, 620, 'end_turn');
    observerHandoff('llm', 'decode', { surface: 'text' });
    observeSync('decode', { fixture: true, round: 2 }, () => ({ fixture: true }), () => ({ replyChars: 86, toolCalls: 2 }));
    observeSync('store', { fixture: true, turns: 2 }, () => ({ fixture: true }), () => ({ saved: true }));
  }).then(() => console.log(`Closed ${runId}`));
  console.log(`Started ${runId}`);
}
let burst: ReturnType<typeof setInterval> | undefined;
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  switch (line.trim()) {
    case 'run': runFixture(); break;
    case 'turn': turnFixture(); break;
    case 'fca-run': void fcaFixture.start().then(ids => console.log('REAL LOCAL FCA FIXTURE:', ids)).catch(error => console.error('LOCAL_FCA_FIXTURE_START_FAILED', error instanceof Error ? error.message : 'unknown')); break;
    case 'fca-next': void fcaFixture.next().then(() => console.log('REAL LOCAL FCA FIXTURE:', fcaFixture.summary())).catch(() => console.error('LOCAL_FCA_FIXTURE_NEXT_FAILED')); break;
    case 'fca-finish': void fcaFixture.finish().then(() => console.log('REAL LOCAL FCA FIXTURE:', fcaFixture.summary())).catch(() => console.error('LOCAL_FCA_FIXTURE_FINISH_FAILED')); break;
    case 'client-links': void clientLinksFixture().catch(() => console.error('LOCAL_FIXTURE_CLIENT_LINKS_FAILED')); break;
    case 'handoff': for (const emit of handoffs) emit(); console.log('Sent a fixture handoff receipt'); break;
    case 'handoff-burst': {
      if (burst) clearInterval(burst);
      let remaining = 30;
      burst = setInterval(() => {
        for (const emit of handoffs) emit();
        if (--remaining === 0) { clearInterval(burst); burst = undefined; console.log('Finite fixture handoff burst ended'); }
      }, 250);
      console.log('Started 30 real fixture handoff receipts, 250ms apart'); break;
    }
    case 'finish': for (const finish of [...finishers]) finish(); break;
    case 'hold': ownerAlone = false; console.log('Owner visibility held'); break;
    case 'ready': ownerAlone = true; console.log('Owner alone'); break;
    case 'pair': console.log(`Temporary fixture pairing code: ${auth.issuePairingCode('ui-fixture-owner').code}`); break;
    case 'close': if (burst) clearInterval(burst); for (const finish of [...finishers]) finish(); input.close(); void fcaFixture.close().finally(() => { server.closeAllConnections(); server.close(); publisher.close(); }); break;
    default: console.log('Commands: run / turn / fca-run / fca-next / fca-finish / client-links / handoff / finish / hold / ready / close');
  }
});
