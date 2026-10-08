// This module has no network or DOM effects when imported by deterministic tests.
export const MAX_EVENTS = 1600;
const KINDS = new Set(['run.started', 'run.completed', 'span.started', 'span.completed', 'span.failed', 'span.cancelled', 'handoff']);
const CLOSED = new Map([['span.completed', 'completed'], ['span.failed', 'failed'], ['span.cancelled', 'cancelled']]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createObserverState() {
  return { instanceId: null, cursor: 0, events: [], runs: new Map(), selectedRunId: null, availability: 'disconnected', transport: 'disconnected', notice: '', generatedAt: null, dropped: 0 };
}

export function validEnvelope(value) {
  return record(value) && value.schemaVersion === 1 && typeof value.instanceId === 'string'
    && Number.isSafeInteger(value.cursor) && value.cursor >= 0
    && Number.isSafeInteger(value.oldestCursor) && value.oldestCursor >= 0
    && typeof value.gap === 'boolean' && ['ready', 'held'].includes(value.availability)
    && typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt))
    && Array.isArray(value.events) && value.events.length <= 200 && value.events.every(validEvent);
}

function validEvent(event) {
  return record(event) && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && typeof event.runId === 'string' && event.runId.length > 0 && typeof event.spanId === 'string'
    && typeof event.node === 'string' && KINDS.has(event.kind)
    && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))
    && (event.parentSpanId === null || typeof event.parentSpanId === 'string');
}

/** Sequence is delivery identity; timestamps are shown as measured, never used to invent progress. */
export function reduceObserverEnvelope(previous, envelope, followLatest = false) {
  if (!validEnvelope(envelope)) throw new Error('OBSERVER_PROTOCOL');
  if (envelope.availability === 'held') {
    return { ...createObserverState(), instanceId: envelope.instanceId, cursor: envelope.cursor,
      generatedAt: envelope.generatedAt, availability: 'held', transport: 'held', notice: '所有者だけの場で観測できるまで、入力と出力を非表示にしています。' };
  }
  const restarted = previous.instanceId !== null && previous.instanceId !== envelope.instanceId;
  const dropped = Number.isSafeInteger(envelope.dropped) ? envelope.dropped : 0;
  const lostEvents = !restarted && dropped > previous.dropped;
  const reset = restarted || envelope.gap || lostEvents || previous.availability === 'held';
  const combined = new Map((reset ? [] : previous.events).map(event => [event.sequence, event]));
  for (const event of envelope.events) if (!combined.has(event.sequence)) combined.set(event.sequence, event);
  const ordered = [...combined.values()].sort((a, b) => a.sequence - b.sequence);
  const trimmed = ordered.length > MAX_EVENTS;
  const events = ordered.slice(-MAX_EVENTS);
  const runs = new Map();
  for (const event of events) {
    let run = runs.get(event.runId);
    if (!run) {
      run = { id: event.runId, spans: new Map(), events: [], startedAt: null, endedAt: null, firstSequence: event.sequence, lastSequence: event.sequence, incomplete: true, state: 'unknown' };
      runs.set(event.runId, run);
    }
    run.events.push(event);
    run.lastSequence = event.sequence;
    const existing = run.spans.get(event.spanId);
    // A client report cannot close or overwrite a server span by reusing its ID.
    if (existing && (existing.node !== event.node || existing.origin && event.origin && existing.origin !== event.origin)) continue;
    if (event.origin === 'client' && event.kind.startsWith('run.')) continue;
    if (event.kind === 'run.started') { run.startedAt = event.at; run.incomplete = false; run.state = 'running'; run.rootSpanId = event.spanId; }
    if (event.kind === 'run.completed') { run.endedAt = event.at; run.state = 'completed'; }
    if (event.kind === 'span.failed' && event.node === 'turn' && (!run.rootSpanId || run.rootSpanId === event.spanId)) { run.endedAt = event.at; run.state = 'failed'; }
    if (event.kind === 'handoff') continue;
    let span = run.spans.get(event.spanId);
    if (!span) {
      span = { id: event.spanId, runId: event.runId, node: event.node, parentSpanId: event.parentSpanId,
        startedAt: null, endedAt: null, state: 'unknown', firstSequence: event.sequence, lastSequence: event.sequence };
      run.spans.set(event.spanId, span);
    }
    span.lastSequence = event.sequence;
    if (event.kind === 'span.started' || event.kind === 'run.started') { span.startedAt = event.at; if (!span.endedAt) span.state = 'running'; }
    if (event.kind === 'run.completed') { span.endedAt = event.at; span.state = 'completed'; }
    if (event.kind.startsWith('run.') || event.node === 'turn' && event.parentSpanId === null) span.isRunRoot = true;
    if (CLOSED.has(event.kind)) { span.endedAt = event.at; span.state = CLOSED.get(event.kind); }
    if (typeof event.elapsedMs === 'number' && Number.isFinite(event.elapsedMs)) span.elapsedMs = Math.max(0, event.elapsedMs);
    if (typeof event.model === 'string') span.model = event.model;
    else if (!span.model && record(event.input) && typeof event.input.model === 'string') span.model = event.input.model;
    else if (!span.model && record(event.output) && typeof event.output.model === 'string') span.model = event.output.model;
    if (event.origin === 'server' || event.origin === 'client') span.origin = event.origin;
    if (own(event, 'input')) span.input = event.input;
    // Only a closed span can publish an output. A start/handoff payload never becomes a completed result.
    if ((CLOSED.has(event.kind) || event.kind === 'run.completed') && own(event, 'output')) span.output = event.output;
  }
  // A correlated utterance can contain several request roots and later client playback.
  // Closing the voice response root does not close the subsequent speech request or player.
  for (const run of runs.values()) {
    const spans = [...run.spans.values()], roots = spans.filter(span => span.isRunRoot);
    const running = spans.some(span => spanState(span, run, 'live') === 'running');
    if (running) { run.state = 'running'; run.endedAt = null; }
    else if (roots.length && roots.every(span => span.endedAt)) {
      run.state = roots.some(span => span.state === 'failed') ? 'failed' : 'completed';
      run.endedAt = roots.slice().sort((a, b) => b.lastSequence - a.lastSequence)[0].endedAt;
    } else { run.state = 'unknown'; run.endedAt = null; }
    const started = roots.find(span => span.startedAt); if (started) run.startedAt = started.startedAt;
  }
  const newest = [...runs.values()].sort((a, b) => b.firstSequence - a.firstSequence)[0];
  const selectedRunId = followLatest || !runs.has(previous.selectedRunId) ? newest?.id ?? null : previous.selectedRunId;
  const notice = restarted ? '観測サーバーが再起動しました。前の実行表示を消去しました。'
    : envelope.gap ? 'イベントの保持期間を超えました。届いている範囲から表示を再開しました。'
    : lostEvents ? `観測イベントが欠落しました（累計 ${dropped} 件）。前の処理状態を消去しました。`
    : trimmed ? 'このページの表示上限に達しました。古いイベントを表示から外しています。'
    : reset ? '' : previous.notice;
  return { instanceId: envelope.instanceId, cursor: reset ? envelope.cursor : Math.max(previous.cursor, envelope.cursor),
    events, runs, selectedRunId, availability: 'ready', transport: 'live', notice, generatedAt: envelope.generatedAt, dropped };
}

export function spanState(span, run, transport = 'live') {
  if (!span) return 'unobserved';
  if (span.endedAt) return span.state;
  if (transport !== 'live' || !span.startedAt) return 'unknown';
  const visited = new Set([span.id]);
  let parent = run?.spans.get(span.parentSpanId);
  while (parent && !visited.has(parent.id)) {
    if (parent.endedAt) return 'unknown';
    visited.add(parent.id); parent = run.spans.get(parent.parentSpanId);
  }
  // A handoff does not establish that its source is blocked or waiting.
  return 'running';
}

export function nodeState(run, node, transport = 'live') {
  const spans = [...(run?.spans.values() ?? [])].filter(span => span.node === node).sort((a, b) => a.lastSequence - b.lastSequence);
  const active = spans.filter(span => !span.endedAt);
  const latest = spans.at(-1);
  return { spans, latest, activeCount: active.length,
    state: active.length ? spanState(active.at(-1), run, transport) : spanState(latest, run, transport) };
}

/** Include only exact retained source/parent references, never a whole capture session or a time-neighbour. */
export function linkedRunView(state, runId) {
  const run = state.runs.get(runId);
  if (!run) return undefined;
  const spans = new Map(run.spans), index = new Map();
  for (const source of state.runs.values()) for (const span of source.spans.values()) {
    if (!index.has(span.id)) index.set(span.id, []);
    index.get(span.id).push(span);
  }
  const pending = [];
  const sourceRunHint = event => {
    for (const value of [event.input, event.output]) if (record(value)) {
      if (typeof value.captureRunId === 'string') return value.captureRunId;
      if (typeof value.utteranceRunId === 'string') return value.utteranceRunId;
    }
    return undefined;
  };
  for (const event of run.events) {
    if (event.kind === 'handoff' && event.sourceSpanId) pending.push({ id: event.sourceSpanId, runId: sourceRunHint(event), node: event.fromNode, origin: event.origin });
    else if (event.parentSpanId && !spans.has(event.parentSpanId)) pending.push({ id: event.parentSpanId, runId: sourceRunHint(event), origin: event.origin });
  }
  for (let offset = 0; offset < pending.length; offset += 1) {
    const reference = pending[offset];
    if (spans.has(reference.id)) continue;
    const matches = (index.get(reference.id) ?? []).filter(span =>
      (!reference.runId || span.runId === reference.runId) && (!reference.node || span.node === reference.node)
      && (!reference.origin || span.origin === reference.origin));
    if (matches.length !== 1) continue; // Missing or ambiguous retained sources remain unobserved.
    const source = matches[0]; spans.set(source.id, { ...source, linked: true });
    if (source.parentSpanId && !spans.has(source.parentSpanId)) pending.push({ id: source.parentSpanId, runId: source.runId, origin: source.origin });
  }
  return { ...run, spans, linkedCount: spans.size - run.spans.size };
}

/** Names come only from observed, explicitly named fields, never from descriptions or substring matching. */
export function runToolEvidence(run) {
  const offered = new Set(), chosen = new Set(), called = new Set(), schemas = new Map();
  const collect = (values, target) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const name = typeof value === 'string' ? value : record(value) && typeof value.name === 'string' ? value.name : null;
      if (!name) continue;
      target.add(name);
      if (record(value)) schemas.set(name, value);
    }
  };
  for (const span of run?.spans.values() ?? []) {
    const input = record(span.input) ? span.input : {};
    const output = record(span.output) ? span.output : {};
    if (['jevt', 'native', 'llm', 'tools'].includes(span.node)) {
      collect(input.offeredTools, offered); collect(input.toolDefinitions, offered);
      collect(input.tools, offered); collect(output.offeredTools, offered);
      collect(output.chosenTools, chosen); collect(output.selectedTools, chosen); collect(output.menu?.chosen, chosen);
      collect(input.chosenTools, chosen);
    }
    if (span.node === 'tools') {
      const name = typeof input.name === 'string' ? input.name : typeof input.tool === 'string' ? input.tool : typeof input.toolName === 'string' ? input.toolName : null;
      if (name) called.add(name);
    }
  }
  return { offered, chosen, called, schemas };
}

export function observerBasePath(pathname) {
  if (!/\/observer\/?$/.test(pathname)) throw new Error('OBSERVER_PATH');
  return pathname.replace(/\/observer\/?$/, '');
}

function validCatalog(value) {
  return record(value) && value.schemaVersion === 1 && Array.isArray(value.tools) && Array.isArray(value.nodes) && Array.isArray(value.coverage)
    && value.tools.every(tool => record(tool) && typeof tool.name === 'string' && typeof tool.domain === 'string')
    && value.nodes.every(node => record(node) && typeof node.id === 'string' && typeof node.location === 'string')
    && value.coverage.every(item => record(item) && typeof item.node === 'string' && ['instrumented', 'external', 'unobserved'].includes(item.availability));
}

/** One abortable polling chain owns credentials in memory. An epoch fences every late response. */
export function createObserverClient(options) {
  const fetcher = options.fetch;
  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  const base = options.basePath ?? '';
  let token = '', epoch = 0, controller = null, timer = null, deadline = null, paused = false, catalog = null, delay = 400;
  const stopWork = () => {
    epoch += 1;
    if (timer !== null) clearTimer(timer);
    if (deadline !== null) clearTimer(deadline);
    timer = null; deadline = null;
    controller?.abort(); controller = null;
  };
  const state = value => options.onConnection?.(value);
  const disconnect = (reason = '') => {
    stopWork(); token = ''; catalog = null; options.onReset?.(reason); state('disconnected');
  };
  const json = async (path, init, activeEpoch) => {
    const response = await fetcher(`${base}${path}`, { cache: 'no-store', credentials: 'omit', redirect: 'error', ...init, signal: controller.signal });
    if (activeEpoch !== epoch) throw new Error('STALE_RESPONSE');
    if (!response.ok) { const error = new Error('OBSERVER_HTTP'); error.status = response.status; throw error; }
    const result = await response.json();
    if (activeEpoch !== epoch) throw new Error('STALE_RESPONSE');
    return result;
  };
  const beginRequest = () => {
    controller = new AbortController();
    deadline = setTimer(() => controller?.abort(), 10_000);
  };
  const endRequest = () => { if (deadline !== null) clearTimer(deadline); deadline = null; controller = null; };
  const poll = async () => {
    timer = null;
    if (!token || paused) return;
    const activeEpoch = epoch;
    beginRequest();
    try {
      const headers = { Authorization: `Bearer ${token}` };
      if (!catalog) {
        const candidate = await json('/v1/observer/catalog', { headers }, activeEpoch);
        if (validEnvelope(candidate) && candidate.availability === 'held') {
          options.onEnvelope(candidate); options.onCatalog?.(null); state('held'); delay = 800; return;
        }
        if (!validCatalog(candidate)) throw new Error('OBSERVER_PROTOCOL');
        catalog = candidate;
      }
      const cursor = options.getCursor?.() ?? 0;
      const envelope = await json(`/v1/observer/events?after=${cursor}&limit=200`, { headers }, activeEpoch);
      if (!validEnvelope(envelope)) throw new Error('OBSERVER_PROTOCOL');
      options.onEnvelope(envelope);
      if (envelope.availability === 'held') { catalog = null; options.onCatalog?.(null); state('held'); }
      else { options.onCatalog?.(catalog); state('live'); }
      delay = envelope.availability === 'held' ? 800 : 400;
    } catch (error) {
      if (activeEpoch !== epoch) return;
      if (error.status === 401 || error.status === 403) { disconnect('接続の認証を確認できませんでした。接続コードでつなぎ直してください。'); return; }
      state('lost'); delay = Math.min(Math.max(800, delay * 2), 8000);
    } finally {
      if (activeEpoch === epoch) {
        endRequest();
        if (token && !paused) timer = setTimer(poll, delay);
      }
    }
  };
  const connect = value => {
    stopWork(); token = String(value).trim(); catalog = null; delay = 400;
    options.onReset?.(''); state(paused ? 'paused' : 'connecting');
    if (!token) { disconnect('接続情報を入力してください。'); return; }
    if (!paused) void poll();
  };
  const pair = async code => {
    stopWork(); token = ''; catalog = null; options.onReset?.(''); state('connecting');
    const activeEpoch = epoch;
    beginRequest();
    try {
      const result = await json('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'Shannon Observer' }) }, activeEpoch);
      if (typeof result.token !== 'string' || !result.token) throw new Error('OBSERVER_PROTOCOL');
      if (activeEpoch === epoch) connect(result.token);
    } catch (error) {
      if (activeEpoch !== epoch) return;
      disconnect(error.status === 429 ? '接続コードの試行が多いため、少し待ってから再度接続してください。'
        : error.status === 401 || error.status === 400 ? '接続コードが無効か、期限切れです。コードを確認してください。' : '接続できませんでした。サーバーへの接続を確認してください。');
    }
  };
  const pause = () => { paused = true; stopWork(); catalog = null; if (token) state('paused'); else { options.onReset?.(''); state('disconnected'); } };
  const resume = () => { if (!paused) return; paused = false; if (token) { state('connecting'); void poll(); } };
  return { connect, pair, disconnect, pause, resume };
}

const NODE_SPECS = [
  ['pcm', 0, 0, 'CLIENT / CONVERTER', 'PCM CONVERTER', 'マイク → 音声チャンク'],
  ['stt', 1, 0, 'TRANSCRIPTION / MODEL', 'TRANSCRIPTION', '音声 → 文字起こし'],
  ['join', 2, 0, 'CLIENT / CONVERTER', 'UTTERANCE', '発話結合・語彙正規化'],
  ['perception', 3, 0, 'API / CONVERTER', 'PERCEPTION', '知覚 → MindEvent'],
  ['turn', 0, 1, 'API / RUN', 'TURN', '会話の実行単位'],
  ['jevv', 1, 1, 'JEV / VOICE ROUTER', 'JEV · VOICE', '返答・能力・読み方'],
  ['jevt', 2, 1, 'JEV / TOOL CHOOSER', 'JEV · TOOLS', '道具・難易度の選択'],
  ['recall', 3, 1, 'API / RETRIEVAL', 'RECALL', '関連する記憶を想起'],
  ['workspace', 0, 2, 'MIND WORKER / CONTROL', 'WORKSPACE', '共有の場・実行枠'],
  ['context', 1, 2, 'API / CONVERTER', 'CONTEXT', '知覚・想起・選択を統合'],
  ['native', 2, 2, 'API / CONVERTER', 'MODEL I/O', 'Messages・道具定義へ変換'],
  ['llm', 3, 2, 'RESPONSE / LLM', 'LLM', '返答・tool_useを生成'],
  ['store', 0, 3, 'API / STORE', 'CONVERSATION', '会話の保存'],
  ['gate', 1, 3, 'API / POLICY', 'TOOL GATE', '許可・入力・実行条件'],
  ['tools', 2, 3, 'EXECUTOR / EXPANDABLE', 'TOOL ▾', '道具一覧・実行結果を開く'],
  ['decode', 3, 3, 'API / CONVERTER', 'REPLY DECODER', '構造化回答・検証'],
  ['autonomy', 0, 4, 'WORKER / EXECUTOR', 'OWN-TIME', '自律活動の実行'],
  ['memory', 1, 4, 'WORKER / STORE', 'MEMORY WRITER', '返答後の記憶更新'],
  ['plan', 2, 4, 'API / CONVERTER', 'VOICE PLAN', '感情・読み方へ投影'],
  ['sentences', 3, 4, 'API / CONVERTER', 'SENTENCE SPLIT', '生成途中の文を取り出す'],
  ['sleep', 0, 5, 'WORKER / CONSOLIDATION', 'SLEEP / LEARN', '記憶・価値・スキルの整理'],
  ['embedding', 1, 5, 'WORKER / MODEL', 'EMBEDDING', '想起用のベクトル更新'],
  ['tts', 2, 5, 'VOICE / TTS MODEL', 'TTS', '文ごとの音声合成'],
  ['play', 3, 5, 'CLIENT / CONVERTER', 'PCM PLAYBACK', '再生順・端末出力'],
  ['minecraft', 0, 6, 'BODY / WORLD', 'MINECRAFT', '身体から届く出来事'],
  ['agentHost', 1, 6, 'HOST / EXECUTOR', 'AGENT HOST', '依頼された作業の実行'],
];
// Role colour stays stable across running/completed/failed states.
// Wires and live receipts use the sending processor's role, never a fabricated event type.
const CIRCUITS = {
  input: ['pcm', 'stt', 'join', 'perception'],
  judgment: ['turn', 'jevv', 'jevt', 'context', 'native', 'llm'],
  action: ['workspace', 'gate', 'tools', 'autonomy', 'minecraft', 'agentHost'],
  output: ['decode', 'plan', 'sentences', 'tts', 'play'],
  memory: ['recall', 'store', 'memory', 'sleep', 'embedding'],
};
const circuitFor = node => Object.entries(CIRCUITS).find(([, nodes]) => nodes.includes(node))?.[0] ?? 'neutral';
const LINKS = [
  ['pcm','stt'], ['stt','join'], ['join','perception'], ['perception','jevv'], ['perception','jevt'], ['perception','recall'],
  ['turn','context'], ['jevv','context'], ['jevt','context'], ['recall','context'], ['workspace','context'], ['context','native'],
  ['native','llm'], ['llm','gate'], ['gate','tools'], ['tools','native'], ['llm','decode'], ['decode','sentences'], ['sentences','plan'],
  ['plan','tts'], ['tts','play'], ['decode','store'], ['store','memory'], ['memory','embedding',true], ['embedding','recall',true],
  ['autonomy','workspace',true], ['sleep','memory',true], ['minecraft','workspace',true], ['agentHost','workspace',true],
];
const STATE_LABELS = { running: '● ACTIVE', completed: '✓ DONE', failed: '! FAILED', cancelled: '× CANCELLED', unknown: '? UNKNOWN', unobserved: '— 未観測' };
const textValue = value => value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const shortValue = value => (textValue(value) ?? '').replace(/\s+/g, ' ').slice(0, 140);
const timeValue = value => value ? new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, fractionalSecondDigits: 3 }) : '—';

function mountObserver() {
  const $ = id => document.getElementById(id);
  const root = $('observer');
  if (!root) return;
  const element = (name, className, text) => { const value = document.createElement(name); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const svgElement = (name, attrs) => { const value = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [key, content] of Object.entries(attrs)) value.setAttribute(key, String(content)); return value; };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = createObserverState(), catalog = null, selectedNode = 'llm', selectedSpan = null, selectedTool = null;
  let priorCatalog = null, runSignature = '', spanSignature = '', toolSignature = '', graphWidth = 0;
  const nodes = new Map(), paths = new Map(), boxes = new Map(), animations = new Set(), recent = new Map();
  let viewRuns = null, viewId = null, view = undefined;
  const currentRun = () => {
    if (viewRuns !== state.runs || viewId !== state.selectedRunId) {
      viewRuns = state.runs; viewId = state.selectedRunId; view = linkedRunView(state, state.selectedRunId);
    }
    return view;
  };
  const nodeLabel = id => NODE_SPECS.find(spec => spec[0] === id)?.[4] ?? id;
  const stopPackets = () => {
    for (const animation of animations) animation.cancel(); animations.clear(); $('packets').replaceChildren();
    for (const key of [...recent.keys()]) cancelTrail(key); $('trails').replaceChildren();
  };
  const clearPrivateView = () => {
    state = createObserverState(); catalog = null; priorCatalog = null; selectedSpan = null; selectedTool = null;
    runSignature = ''; spanSignature = ''; toolSignature = ''; stopPackets();
    $('pair-code').value = ''; $('pair-token').value = '';
    render();
  };

  for (const [id, , , type, label, role] of NODE_SPECS) {
    const button = element('button', 'node'); button.type = 'button'; button.dataset.node = id; button.dataset.circuit = circuitFor(id);
    button.setAttribute('aria-pressed', String(id === selectedNode));
    const halo = element('span', 'receipt-halo'); halo.setAttribute('aria-hidden', 'true'); button.append(halo);
    button.append(element('span', 'node-type', type), element('strong', '', label), element('span', 'node-role', role), element('span', 'node-value', 'イベント待ち'), element('span', 'node-state', STATE_LABELS.unobserved));
    button.addEventListener('click', () => selectNode(id)); $('nodes').append(button); nodes.set(id, button);
  }

  function selectNode(id, spanId = null) {
    if (!nodes.has(id)) return;
    selectedNode = id; selectedSpan = spanId; spanSignature = ''; toolSignature = '';
    for (const [node, button] of nodes) button.setAttribute('aria-pressed', String(node === id));
    renderDetail(); $('announcement').textContent = `${nodeLabel(id)}の入力と出力を表示しました。`;
  }

  function renderRuns() {
    const runs = [...state.runs.values()].sort((a, b) => b.firstSequence - a.firstSequence);
    const signature = runs.map(run => `${run.id}:${run.endedAt ?? ''}`).join('|') + state.selectedRunId + state.transport;
    if (signature !== runSignature) {
      const picker = $('run-picker'); picker.replaceChildren();
      if (!runs.length) picker.append(new Option('イベント待ち', ''));
      for (const run of runs) picker.append(new Option(`${run.state === 'failed' ? '!' : run.endedAt ? '✓' : state.transport === 'live' && !run.incomplete ? '●' : '?'} ${timeValue(run.startedAt ?? run.events[0]?.at)} / ${run.id}`, run.id));
      picker.value = state.selectedRunId ?? ''; picker.disabled = !runs.length; runSignature = signature;
    }
    const run = currentRun();
    const active = run ? [...run.spans.values()].filter(span => !span.endedAt).length : 0;
    const parallel = runs.filter(item => !item.endedAt && !item.incomplete).length;
    $('run-summary').textContent = run ? `${run.spans.size} spans${run.linkedCount ? `（${run.linkedCount} 参照）` : ''} · ${state.transport === 'live' && !run.endedAt ? `${active} active` : active ? `${active} unknown` : 'closed'} · ${parallel} open runs${run.incomplete ? ' · 開始未観測' : ''}` : '処理の箱を選ぶと、入力と出力を確認できます。';
  }

  function renderNodes() {
    const run = currentRun();
    for (const [id, button] of nodes) {
      const value = nodeState(run, id, state.transport);
      const coverage = catalog?.coverage?.find(item => item.node === id);
      button.dataset.state = value.state;
      const suffix = (value.activeCount > 1 ? ` / ×${value.activeCount}` : '') + (value.latest?.linked ? ' / ↗ 参照' : '');
      button.querySelector('.node-state').textContent = STATE_LABELS[value.state] + suffix;
      const output = value.latest?.output;
      button.querySelector('.node-value').textContent = output !== undefined ? shortValue(output) : value.activeCount ? '出力イベント待ち' : coverage?.availability === 'external' ? '外部 · 未計測' : coverage?.availability === 'unobserved' ? '未計測' : 'イベント待ち';
      button.title = `${nodeLabel(id)} / ${STATE_LABELS[value.state]}${suffix}`;
    }
  }

  function renderDetail() {
    const run = currentRun(), value = nodeState(run, selectedNode, state.transport);
    const definition = catalog?.nodes?.find(item => item.id === selectedNode);
    const coverage = catalog?.coverage?.find(item => item.node === selectedNode);
    document.querySelector('.inspector').dataset.circuit = circuitFor(selectedNode);
    $('detail-title').textContent = nodeLabel(selectedNode);
    $('detail-location').textContent = definition?.location ?? '接続後、カタログの実装場所を表示します。';
    $('coverage-note').textContent = coverage ? `${({ instrumented: '計測対象', external: '外部の処理', unobserved: '未計測' })[coverage.availability] ?? '未計測'}${coverage.reason ? ` · ${coverage.reason}` : ''}` : '計測範囲は接続後に表示します。';
    if (!value.spans.some(span => span.id === selectedSpan)) selectedSpan = value.spans.at(-1)?.id ?? null;
    const span = value.spans.find(item => item.id === selectedSpan);
    const signature = value.spans.map(item => `${item.id}:${item.state}`).join('|') + selectedSpan + state.transport;
    if (signature !== spanSignature) {
      const picker = $('span-picker'); picker.replaceChildren();
      if (!value.spans.length) picker.append(new Option('観測した処理なし', ''));
      for (const item of [...value.spans].reverse()) picker.append(new Option(`${STATE_LABELS[spanState(item, run, state.transport)]}${item.linked ? ' ↗ 参照' : ''} / ${item.id}`, item.id));
      picker.value = selectedSpan ?? ''; picker.disabled = !value.spans.length; spanSignature = signature;
    }
    $('detail-state').textContent = STATE_LABELS[spanState(span, run, state.transport)];
    $('detail-origin').textContent = (span?.origin === 'server' ? 'SERVER / サーバー観測' : span?.origin === 'client' ? 'CLIENT / 端末からの報告' : '出典の記録なし') + (span?.linked ? ' · 別runの参照' : '');
    $('detail-run').textContent = span?.runId ?? run?.id ?? '—'; $('detail-span').textContent = span?.id ?? '—';
    $('detail-parent').textContent = span?.parentSpanId ?? '—'; $('detail-model').textContent = span?.model ?? 'モデル指定のイベントなし';
    $('detail-start').textContent = timeValue(span?.startedAt); $('detail-end').textContent = timeValue(span?.endedAt);
    $('detail-elapsed').textContent = typeof span?.elapsedMs === 'number' ? `${span.elapsedMs.toFixed(1)} ms` : span?.endedAt && span?.startedAt ? `${Math.max(0, Date.parse(span.endedAt) - Date.parse(span.startedAt))} ms（時刻差）` : '完了時に表示';
    $('detail-input').textContent = textValue(span?.input) ?? '観測した入力はありません。';
    $('detail-output').textContent = textValue(span?.output) ?? (span && !span.endedAt ? spanState(span, run, state.transport) === 'running' ? '出力イベント待ち' : '状態不明 · 完了は未確認' : '観測した出力はありません。');
    $('tool-panel').hidden = !['tools', 'jevt', 'gate'].includes(selectedNode);
    if (!$('tool-panel').hidden) renderTools(run);
    else { $('tool-list').replaceChildren(); $('tool-detail').hidden = true; $('tool-schema').textContent = ''; toolSignature = ''; }
  }

  function renderTools(run) {
    const evidence = runToolEvidence(run), filter = $('tool-filter').value;
    const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
    const actual = new Map(tools.map(tool => [tool.name, tool]));
    // An observed tool that is not in today's catalog remains inspectable.
    for (const name of new Set([...evidence.offered, ...evidence.chosen, ...evidence.called])) if (!actual.has(name)) actual.set(name, { name, domain: 'observed', effect: 'イベント参照', input: evidence.schemas.get(name) });
    const visible = [...actual.values()].filter(tool => filter === 'all' || evidence[filter]?.has(tool.name));
    const signature = JSON.stringify([filter, run?.lastSequence, tools.map(tool => tool.name), visible.map(tool => tool.name)]);
    if (signature !== toolSignature) {
      $('tool-list').replaceChildren();
      const domains = new Map();
      for (const tool of visible) { const key = tool.domain ?? 'other'; if (!domains.has(key)) domains.set(key, []); domains.get(key).push(tool); }
      for (const [domain, items] of domains) {
        const group = element('details', 'tool-group'); group.open = filter !== 'all' || domains.size < 3;
        group.append(element('summary', '', `${domain} / ${items.length}`));
        for (const tool of items) {
          const button = element('button', 'tool-row'); button.type = 'button';
          const evidenceLabel = evidence.called.has(tool.name) ? '実行' : evidence.chosen.has(tool.name) ? '選択' : evidence.offered.has(tool.name) ? '提示' : '定義';
          button.dataset.observed = String(evidenceLabel !== '定義'); button.setAttribute('aria-pressed', String(selectedTool === tool.name));
          button.append(element('code', '', tool.name), element('span', '', `${evidenceLabel} / ${tool.effect ?? ''}`));
          button.addEventListener('click', () => { selectedTool = tool.name; toolSignature = ''; renderTools(currentRun()); }); group.append(button);
        }
        $('tool-list').append(group);
      }
      $('tool-count').textContent = visible.length ? `${visible.length} tools` : filter === 'all' ? 'カタログを待っています。' : 'このrunでは、該当する定義提示・選択・実行をまだ観測していません。';
      toolSignature = signature;
    }
    const tool = actual.get(selectedTool);
    $('tool-detail').hidden = !tool;
    $('tool-name').textContent = tool?.name ?? ''; $('tool-description').textContent = tool?.description ?? '';
    $('tool-schema').textContent = tool ? textValue(evidence.schemas.get(tool.name) ?? tool.input) ?? '定義は入力イベントを参照してください。' : '';
  }

  function renderEvents() {
    const run = currentRun(), events = run?.events ?? [];
    $('event-count').textContent = `${events.length} events${run ? ` / ${run.id}` : ''}`;
    $('events-empty').hidden = events.length > 0;
    $('event-list').replaceChildren();
    for (const event of events.slice(-12).reverse()) {
      const item = element('li'), button = element('button'); button.type = 'button'; button.dataset.circuit = circuitFor(event.node);
      const time = element('time', '', timeValue(event.at)); time.dateTime = event.at;
      button.append(time, element('span', '', nodeLabel(event.node)), element('span', 'event-summary', `${event.kind} · ${event.kind === 'handoff' ? `${event.fromNode ?? '?'} → ${event.toNode ?? '?'}` : shortValue(event.output ?? event.input) || event.spanId}`));
      button.addEventListener('click', () => selectNode(event.node, event.kind.startsWith('span.') ? event.spanId : null)); item.append(button); $('event-list').append(item);
    }
  }

  function render() {
    renderRuns(); renderNodes(); renderDetail(); renderEvents();
    $('notice').textContent = state.notice; $('notice').hidden = !state.notice;
  }

  function rounded(points) {
    let path = `M${points[0].join(' ')}`;
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index], before = points[index - 1], after = points[index + 1];
      const incoming = Math.hypot(point[0] - before[0], point[1] - before[1]), outgoing = Math.hypot(after[0] - point[0], after[1] - point[1]);
      if (incoming < 1 || outgoing < 1) continue;
      const radius = Math.min(7, incoming / 2, outgoing / 2);
      const a = point.map((value, axis) => value + (before[axis] - value) * radius / incoming);
      const b = point.map((value, axis) => value + (after[axis] - value) * radius / outgoing);
      path += ` L${a.join(' ')} Q${point.join(' ')} ${b.join(' ')}`;
    }
    return `${path} L${points.at(-1).join(' ')}`;
  }

  function route(from, to, index) {
    const a = boxes.get(from), b = boxes.get(to);
    if (!a || !b || from === to) return null;
    let points;
    if (a.row === b.row && Math.abs(a.col - b.col) === 1) {
      const right = b.col > a.col, p = [a.x + (right ? a.w : 0), a.y + 51], q = [b.x + (right ? 0 : b.w), b.y + 51];
      points = [p, [(p[0]+q[0])/2,p[1]], [(p[0]+q[0])/2,q[1]], q];
    } else if (a.col === b.col && Math.abs(a.row - b.row) === 1) {
      const down = b.row > a.row, p = [a.x+a.w/2,a.y+(down ? 104 : 0)], q = [b.x+b.w/2,b.y+(down ? 0 : 104)];
      points = [p,[p[0],(p[1]+q[1])/2],[q[0],(p[1]+q[1])/2],q];
    } else {
      const down = b.row > a.row, start = [a.x + a.w*.6, a.y + (down || a.row === b.row ? 104 : 0)], end = [b.x + b.w*.4, b.y + (down ? 0 : 104)];
      const startY = start[1] + (down || a.row === b.row ? 12 : -12), endY = end[1] + (down ? -12 : 12);
      const lane = a.col === b.col ? a.x - 9 : Math.min(a.x,b.x)+a.w+16+(index%3-1)*5;
      points = [start,[start[0],startY],[lane,startY],[lane,endY],[end[0],endY],end];
    }
    return rounded(points);
  }

  function addEdge(from, to, background = false) {
    const key = `${from}>${to}`;
    if (paths.has(key)) return paths.get(key);
    const path = route(from, to, paths.size);
    if (!path) return null;
    const value = svgElement('path', { d: path, class: `edge${background ? ' background' : ''}`, 'data-circuit': circuitFor(from), 'marker-end': `url(#arrow-${circuitFor(from)})` });
    $('edges').append(value); paths.set(key, value); return value;
  }

  function layout() {
    const width = $('canvas').clientWidth;
    if (!width || width === graphWidth) return;
    graphWidth = width; stopPackets(); boxes.clear(); paths.clear(); $('edges').replaceChildren(); $('zones').replaceChildren();
    const compact = width < 640, columns = compact ? 2 : 4, gap = compact ? 24 : 32, margin = compact ? 14 : 20;
    const nodeWidth = (width - 2*margin - gap*(columns-1))/columns, pitch = 148, rows = compact ? Math.ceil(nodes.size/2) : 7;
    NODE_SPECS.forEach(([id, column, row], index) => {
      const col = compact ? index%2 : column, r = compact ? Math.floor(index/2) : row;
      const box = { x: margin + col*(nodeWidth+gap), y: 38+r*pitch, w: nodeWidth, row: r, col };
      boxes.set(id,box); const button = nodes.get(id); button.style.left = `${box.x}px`; button.style.top = `${box.y}px`; button.style.width = `${nodeWidth}px`;
    });
    const height = rows*pitch + 44; $('canvas').style.height = `${height}px`; $('wires').setAttribute('viewBox',`0 0 ${width} ${height}`);
    const zones = compact ? [[0,rows,'SIGNAL PROCESSORS']] : [[0,1,'01 / INPUT'],[1,3,'02 / JEV · CONTEXT · LLM · TOOL'],[4,2,'03 / VOICE OUTPUT · BACKGROUND'],[6,1,'04 / BODIES · HOSTS']];
    for (const [row,count,label] of zones) {
      $('zones').append(svgElement('rect',{x:6,y:row*pitch+8,width:width-12,height:count*pitch-4,rx:5,class:'zone'}));
      const text = svgElement('text',{x:16,y:row*pitch+24,class:'zone-label'}); text.textContent = label; $('zones').append(text);
    }
    for (const [from,to,background] of LINKS) addEdge(from,to,background);
  }

  function cancelTrail(key) {
    const item = recent.get(key); if (!item) return;
    recent.delete(key); item.animation.cancel(); if (item.remove) item.target.remove();
  }

  function receiptTrail(key, target, remove = false) {
    // A renewed receipt starts a fresh three-second window; one animation per box/wire.
    cancelTrail(key);
    if (recent.size >= 96) cancelTrail(recent.keys().next().value);
    const animation = target.animate([{ opacity: .7 }, { opacity: 0 }], { duration: 3000, easing: 'linear' });
    const item = { animation, target, remove }; recent.set(key, item);
    const finish = () => { if (recent.get(key) === item) recent.delete(key); if (remove) target.remove(); };
    animation.addEventListener('finish', finish, { once: true });
    animation.addEventListener('cancel', finish, { once: true });
  }

  function receiptGlow(event) {
    if (event.runId !== state.selectedRunId || document.hidden) return;
    const touched = event.kind === 'handoff' ? [event.fromNode, event.toNode] : [event.node];
    for (const node of new Set(touched)) {
      const halo = nodes.get(node)?.querySelector('.receipt-halo');
      if (halo) receiptTrail(`node:${node}`, halo);
    }
    if (event.kind !== 'handoff') return;
    const path = addEdge(event.fromNode, event.toNode);
    if (!path) return;
    const trail = svgElement('path', { d: path.getAttribute('d'), class: 'edge-receipt', 'data-circuit': circuitFor(event.fromNode) });
    $('trails').append(trail); receiptTrail(`edge:${event.fromNode}>${event.toNode}`, trail, true);
  }

  function handoffPacket(event) {
    if (event.runId !== state.selectedRunId || reduceMotion.matches || document.hidden || animations.size >= 24) return;
    const path = addEdge(event.fromNode,event.toNode);
    if (!path || typeof path.getTotalLength !== 'function') return;
    const packet = svgElement('circle',{r:4,class:'packet','data-circuit':circuitFor(event.fromNode)}); $('packets').append(packet);
    const length = path.getTotalLength(), frames = [];
    for (let index=0;index<=20;index+=1) { const point=path.getPointAtLength(length*index/20); frames.push({transform:`translate(${point.x}px, ${point.y}px)`}); }
    // A bounded 240 ms receipt visualization; never a measurement or a looping simulated packet.
    const animation = packet.animate(frames,{duration:240,easing:'linear'}); animations.add(animation);
    const finish = () => { animations.delete(animation); packet.remove(); };
    animation.addEventListener('finish',finish,{once:true}); animation.addEventListener('cancel',finish,{once:true});
  }

  const client = createObserverClient({
    basePath: observerBasePath(window.location.pathname), fetch: window.fetch.bind(window),
    getCursor: () => state.cursor,
    onReset: reason => { clearPrivateView(); $('connect-error').textContent = reason; $('connect-error').hidden = !reason; },
    onCatalog: value => { if (priorCatalog === value) return; catalog = value; priorCatalog = value; toolSignature = ''; renderNodes(); renderDetail(); },
    onEnvelope: envelope => {
      const previous = state, seen = new Set(previous.events.map(event => event.sequence));
      state = reduceObserverEnvelope(previous,envelope,$('follow-runs').checked);
      if (previous.transport === 'lost' && state.transport === 'live' && !envelope.gap && previous.instanceId === state.instanceId) state.notice = '接続が回復しました。受信したイベントから表示を更新しました。';
      if (envelope.availability === 'held') { selectedSpan = null; selectedTool = null; catalog = null; priorCatalog = null; toolSignature = ''; stopPackets(); }
      if (state.selectedRunId !== previous.selectedRunId || state.instanceId !== previous.instanceId || envelope.gap || state.dropped > previous.dropped) { selectedSpan = null; spanSignature = ''; stopPackets(); }
      const changed = envelope.events.some(event => !seen.has(event.sequence)) || previous.transport !== state.transport || previous.availability !== state.availability || previous.notice !== state.notice || state.instanceId !== previous.instanceId || envelope.gap;
      if (changed) render();
      // Initial history, a gap and a server restart remain still. Only a new live receipt moves.
      if (previous.instanceId === state.instanceId && previous.transport === 'live' && !envelope.gap && state.dropped === previous.dropped) for (const event of envelope.events) if (!seen.has(event.sequence)) {
        receiptGlow(event);
        if (event.kind === 'handoff') handoffPacket(event);
      }
    },
    onConnection: connection => {
      const previous = state.transport; state = {...state,transport:connection}; root.dataset.connection=connection;
      const labels = {disconnected:'未接続',connecting:'接続中',live:'LIVE / 観測中',held:'HELD / 非表示',paused:'PAUSED / 観測休止',lost:'接続を再確認中'};
      $('connection-state').textContent=labels[connection]; $('connect-panel').hidden=!['disconnected','connecting'].includes(connection);
      $('disconnect').hidden=connection==='disconnected';
      for (const button of document.querySelectorAll('#connect-panel button')) button.disabled=connection==='connecting';
      if (connection==='paused') { const cursor=state.cursor,instanceId=state.instanceId; clearPrivateView(); state={...state,cursor,instanceId,transport:'paused'}; }
      if (connection==='lost') { stopPackets(); state.notice='接続が途切れています。処理中だった箇所の結果は未確認です。自動で接続を再確認します。'; }
      if (connection==='live' && previous==='lost') state.notice='接続が回復しました。受信したイベントから表示を更新しました。';
      if (previous!==connection) { runSignature=''; render(); }
    },
  });

  $('pair-form').addEventListener('submit',event=>{event.preventDefault(); const code=$('pair-code').value; $('pair-code').value=''; void client.pair(code);});
  $('token-form').addEventListener('submit',event=>{event.preventDefault(); const token=$('pair-token').value; $('pair-token').value=''; client.connect(token);});
  $('disconnect').addEventListener('click',()=>client.disconnect());
  $('run-picker').addEventListener('change',()=>{state={...state,selectedRunId:$('run-picker').value}; $('follow-runs').checked=false; selectedSpan=null; spanSignature=''; toolSignature=''; stopPackets(); render();});
  $('follow-runs').addEventListener('change',()=>{if($('follow-runs').checked){const latest=[...state.runs.values()].sort((a,b)=>b.firstSequence-a.firstSequence)[0]; state={...state,selectedRunId:latest?.id??null};selectedSpan=null;spanSignature='';stopPackets();render();}});
  $('span-picker').addEventListener('change',()=>{selectedSpan=$('span-picker').value;renderDetail();});
  $('tool-filter').addEventListener('change',()=>{toolSignature='';renderTools(currentRun());});
  document.addEventListener('visibilitychange',()=>document.hidden?client.pause():client.resume());
  window.addEventListener('pagehide',()=>client.disconnect());
  reduceMotion.addEventListener('change',stopPackets);
  if (typeof ResizeObserver==='function') new ResizeObserver(layout).observe($('canvas')); else window.addEventListener('resize',layout);
  render(); layout();
  if(document.hidden)client.pause();
}

if (typeof document !== 'undefined') mountObserver();
