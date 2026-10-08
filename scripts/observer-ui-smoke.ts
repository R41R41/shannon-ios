/** Explicit local UI test fixture. No model, app, production database, or external service is contacted.
 * pnpm exec tsx scripts/observer-ui-smoke.ts
 * stdin: run | client-links | handoff | finish | hold | ready | close
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
import { observeAsync, observeSync, observerHandoff, withObserverRun } from '../services/api/src/infra/observer/observerContext.js';

const auth = new SQLiteDeviceAuthStore({ path: ':memory:', pepper: randomBytes(32).toString('hex') });
const publisher = startObserverPublisher(':memory:');
if (!publisher) throw new Error('LOCAL_FIXTURE_PUBLISHER_UNAVAILABLE');
let ownerAlone = true;
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
console.log('Commands: run / client-links / handoff / finish / hold / ready / close');

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
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  switch (line.trim()) {
    case 'run': runFixture(); break;
    case 'client-links': void clientLinksFixture().catch(() => console.error('LOCAL_FIXTURE_CLIENT_LINKS_FAILED')); break;
    case 'handoff': for (const emit of handoffs) emit(); console.log('Sent a fixture handoff receipt'); break;
    case 'finish': for (const finish of [...finishers]) finish(); break;
    case 'hold': ownerAlone = false; console.log('Owner visibility held'); break;
    case 'ready': ownerAlone = true; console.log('Owner alone'); break;
    case 'pair': console.log(`Temporary fixture pairing code: ${auth.issuePairingCode('ui-fixture-owner').code}`); break;
    case 'close': for (const finish of [...finishers]) finish(); input.close(); server.closeAllConnections(); server.close(); publisher.close(); break;
    default: console.log('Commands: run / client-links / handoff / finish / hold / ready / close');
  }
});
