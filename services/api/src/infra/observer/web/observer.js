import { NODE_SPECS, LINKS, ROUTES, circuitFor, routeIncludes, mapLayout, createMapRouter } from './observerMap.js';
import { observedTasks, taskRunView, timingSummary, streamTimingSummary, timingGroups, timelineRows, createElapsedClock, spanKey } from './observerAnalysis.js';
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
    for (const key of ['taskId', 'parentTaskId', 'stepId', 'actionId']) if (typeof event[key] === 'string' && event[key]) span[key] ??= event[key];
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
  const parentOf = child => [...(run?.spans.values() ?? [])].find(item => item.id === child.parentSpanId && item.runId === child.runId);
  let parent = parentOf(span);
  while (parent && !visited.has(parent.id)) {
    if (parent.endedAt) return 'unknown';
    visited.add(parent.id); parent = parentOf(parent);
  }
  // A handoff does not establish that its source is blocked or waiting.
  return 'running';
}

/** Resolve each span against its real run even when a selected task projects several runs. */
export function effectiveObservedSpans(state, spans) {
  return [...spans].map(span => ({ ...span, state: spanState(span, state.runs.get(span.runId), state.transport) }));
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

/** Tab-scoped credentials only: never persist codes, events, inputs or outputs. */
export function createObserverSession(getStorage, key, now = Date.now) {
  const clear = () => { try { getStorage().removeItem(key); } catch { /* Private/blocked storage keeps the memory-only path. */ } };
  const read = () => {
    try {
      const saved = JSON.parse(getStorage().getItem(key) ?? 'null');
      if (!record(saved) || typeof saved.token !== 'string' || !saved.token.trim() || saved.token.length > 2048
          || (saved.expiresAt !== null && (typeof saved.expiresAt !== 'string' || !Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= now()))) {
        clear(); return null;
      }
      return { token: saved.token, expiresAt: saved.expiresAt };
    } catch { clear(); return null; }
  };
  const write = credential => {
    if (!credential) { clear(); return true; }
    try { getStorage().setItem(key, JSON.stringify({ token: credential.token, expiresAt: credential.expiresAt ?? null })); return true; }
    catch { return false; }
  };
  return { read, write, clear };
}

/** Drain every history page before admitting live receipt effects, including after recovery. */
export function createReceiptGate() {
  let ready = false, instance = null, dropped = 0;
  const reset = () => { ready = false; instance = null; dropped = 0; };
  const accept = envelope => {
    const losses = envelope.dropped ?? 0;
    const live = ready && instance === envelope.instanceId && envelope.availability === 'ready'
      && !envelope.gap && dropped === losses;
    ready = envelope.availability === 'ready' && (live || envelope.events.length < 200);
    instance = envelope.instanceId; dropped = losses;
    return live;
  };
  return { accept, reset };
}

function validCatalog(value) {
  return record(value) && value.schemaVersion === 1 && Array.isArray(value.tools) && Array.isArray(value.nodes) && Array.isArray(value.coverage)
    && value.tools.every(tool => record(tool) && typeof tool.name === 'string' && typeof tool.domain === 'string')
    && value.nodes.every(node => record(node) && typeof node.id === 'string' && typeof node.location === 'string')
    && value.coverage.every(item => record(item) && typeof item.node === 'string' && ['instrumented', 'external', 'unobserved'].includes(item.availability));
}

/** One abortable polling chain owns credentials in memory. An epoch fences every late response. */
export function createObserverClient(options) {
  const fetcher = options.fetch, bridge = options.desktopBridge;
  let existingConnection = false;
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
  const receipts = createReceiptGate();
  const state = value => { if (value !== 'live') receipts.reset(); options.onConnection?.(value); };
  const disconnect = (reason = '') => {
    stopWork(); token = ''; existingConnection = false; catalog = null; options.onCredential?.(null); options.onReset?.(reason); state('disconnected');
  };
  const json = async (path, init, activeEpoch) => {
    if (bridge) {
      const url = new URL(path, 'https://observer.invalid');
      const request = url.pathname === '/v1/observer/catalog' ? { kind: 'catalog' }
        : url.pathname === '/v1/observer/events' ? { kind: 'events', after: Number(url.searchParams.get('after')), limit: 200 } : null;
      if (!request || init.method) throw new Error('OBSERVER_DESKTOP_READ_ONLY');
      const response = await bridge.request(request);
      if (activeEpoch !== epoch || controller?.signal.aborted) throw new Error('STALE_RESPONSE');
      if (!response.ok) { const error = new Error('OBSERVER_HTTP'); error.status = response.status; throw error; }
      return response.body;
    }
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
    if ((!token && !existingConnection) || paused) return;
    const activeEpoch = epoch;
    beginRequest();
    try {
      const headers = { Authorization: `Bearer ${token}` };
      if (!catalog) {
        const candidate = await json('/v1/observer/catalog', { headers }, activeEpoch);
        if (validEnvelope(candidate) && candidate.availability === 'held') {
          options.onEnvelope(candidate, { liveReceipts: receipts.accept(candidate) }); options.onCatalog?.(null); state('held'); delay = 800; return;
        }
        if (!validCatalog(candidate)) throw new Error('OBSERVER_PROTOCOL');
        catalog = candidate;
      }
      const cursor = options.getCursor?.() ?? 0;
      const envelope = await json(`/v1/observer/events?after=${cursor}&limit=200`, { headers }, activeEpoch);
      if (!validEnvelope(envelope)) throw new Error('OBSERVER_PROTOCOL');
      options.onEnvelope(envelope, { liveReceipts: receipts.accept(envelope) });
      if (envelope.availability === 'held') { catalog = null; options.onCatalog?.(null); state('held'); }
      else { options.onCatalog?.(catalog); state('live'); }
      delay = envelope.availability === 'held' ? 800 : 400;
    } catch (error) {
      if (activeEpoch !== epoch) return;
      if (!bridge && (error.status === 401 || error.status === 403)) { disconnect('接続の認証を確認できませんでした。接続コードでつなぎ直してください。'); return; }
      if (bridge && (error.status === 401 || error.status === 403)) options.onReset?.('アプリの接続と、所有者だけがいる状態を確認してください。');
      state('lost'); delay = Math.min(Math.max(800, delay * 2), 8000);
    } finally {
      if (activeEpoch === epoch) {
        endRequest();
        if ((token || existingConnection) && !paused) timer = setTimer(poll, delay);
      }
    }
  };
  const connectExisting = () => {
    if (!bridge) throw new Error('OBSERVER_DESKTOP_UNAVAILABLE');
    stopWork(); token = ''; existingConnection = true; catalog = null; delay = 400;
    options.onReset?.(''); state(paused ? 'paused' : 'connecting');
    if (!paused) void poll();
  };
  const connect = (value, expiresAt = null) => {
    if (bridge) throw new Error('OBSERVER_DESKTOP_READ_ONLY');
    stopWork(); token = String(value).trim(); catalog = null; delay = 400;
    options.onReset?.(''); state(paused ? 'paused' : 'connecting');
    if (!token) { disconnect('接続情報を入力してください。'); return; }
    options.onCredential?.({ token, expiresAt });
    if (!paused) void poll();
  };
  const pair = async code => {
    if (bridge) throw new Error('OBSERVER_DESKTOP_READ_ONLY');
    stopWork(); token = ''; catalog = null; options.onReset?.(''); state('connecting');
    const activeEpoch = epoch;
    beginRequest();
    try {
      const result = await json('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'Shannon Observer' }) }, activeEpoch);
      if (typeof result.token !== 'string' || !result.token) throw new Error('OBSERVER_PROTOCOL');
      if (activeEpoch === epoch) connect(result.token, typeof result.expiresAt === 'string' ? result.expiresAt : null);
    } catch (error) {
      if (activeEpoch !== epoch) return;
      disconnect(error.status === 429 ? '接続コードの試行が多いため、少し待ってから再度接続してください。'
        : error.status === 401 || error.status === 400 ? '接続コードが無効か、期限切れです。コードを確認してください。' : '接続できませんでした。サーバーへの接続を確認してください。');
    }
  };
  const pause = () => { paused = true; stopWork(); catalog = null; if (token || existingConnection) state('paused'); else { options.onReset?.(''); state('disconnected'); } };
  const resume = () => { if (!paused) return; paused = false; if (token || existingConnection) { state('connecting'); void poll(); } };
  return { connect, connectExisting, pair, disconnect, pause, resume };
}

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
  const desktopBridge = window.shannonObserver;
  const session = createObserverSession(() => window.sessionStorage, `shannon.observer.connection.v1:${observerBasePath(window.location.pathname)}`);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = createObserverState(), catalog = null, selectedNode = 'llm', selectedSpan = null, selectedTool = null;
  let selectedTask = null, selectedStep = null, selectedRoute = 'all', analysisSignature = '', taskSignature = '';
  const elapsedClock = createElapsedClock(); let clockTimer = null;
  let priorCatalog = null, runSignature = '', spanSignature = '', toolSignature = '', graphWidth = 0;
  const nodes = new Map(), paths = new Map(), animations = new Set(), recent = new Map();
  let mapRouter = null, routedWidth = 0;
  let viewRuns = null, viewId = null, view = undefined;
  const currentRun = () => {
    if (selectedTask) return taskRunView(state, selectedTask, selectedStep);
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
    runSignature = ''; spanSignature = ''; toolSignature = ''; taskSignature = ''; analysisSignature = ''; selectedTask = null; selectedStep = null;
    elapsedClock.clear(); if (clockTimer !== null) clearTimeout(clockTimer); clockTimer = null;
    viewRuns = null; view = undefined; stopPackets(); mapRouter?.reset(); paths.clear(); $('edges').replaceChildren(); graphWidth=0; layout();
    $('pair-code').value = ''; $('pair-token').value = '';
    render();
  };

  for (const [id, , , type, label, role] of NODE_SPECS) {
    const button = element('button', 'node'); button.type = 'button'; button.dataset.node = id; button.dataset.circuit = circuitFor(id);
    button.setAttribute('aria-pressed', String(id === selectedNode));
    const halo = element('span', 'receipt-halo'); halo.setAttribute('aria-hidden', 'true'); button.append(halo);
    button.append(element('span', 'node-type', type), element('strong', '', label), element('span', 'node-role', role), element('span', 'node-value', 'イベント待ち'), element('span', 'node-time', '— 未計測'), element('span', 'node-state', STATE_LABELS.unobserved));
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

  function timingText(span) {
    if (typeof span?.elapsedMs === 'number' && span.endedAt) return `${span.elapsedMs.toFixed(1)} ms · 実測`;
    const elapsed = span && spanState(span,state.runs.get(span.runId),state.transport)==='running' ? elapsedClock.elapsed(span, performance.now()) : null;
    return elapsed === null ? '— 未計測' : `≥ ${Math.floor(elapsed)} ms · 受信後`;
  }

  function renderTasks() {
    const tasks=observedTasks(state);
    if (selectedTask && !tasks.some(task=>task.id===selectedTask)) { selectedTask=null; selectedStep=null; }
    const selected=tasks.find(task=>task.id===selectedTask);
    const signature=JSON.stringify([tasks.map(task=>[task.id,task.parentId,task.lastSequence]),selectedTask,selectedStep,state.transport]);
    $('task-count').textContent=`${tasks.length} tasks / ${tasks.filter(task=>task.spans.some(span=>spanState(span,state.runs.get(span.runId),state.transport)==='running')).length} tasksに処理中span（保持範囲）`;
    $('task-empty').hidden=tasks.length>0; $('clear-task').disabled=!selectedTask;
    if (signature===taskSignature) return;
    const focusedTask=$('task-tree').contains(document.activeElement)?document.activeElement.dataset.task:null;
    $('task-tree').replaceChildren();
    for (const task of tasks) {
      const item=element('li','task-item'), button=element('button','task-button'); button.type='button';button.dataset.task=task.id;
      item.style.setProperty('--depth',Math.min(task.depth,8)); button.setAttribute('aria-pressed',String(task.id===selectedTask));
      const active=task.spans.filter(span=>spanState(span,state.runs.get(span.runId),state.transport)==='running').length;
      const phase = task.phase ? `記録phase: ${task.phase}${task.phaseRevision!==null?' / rev '+task.phaseRevision:''} · #${task.phaseSequence}` : 'task phase 未観測';
      button.append(element('span','task-id',`${task.depth?'↳ ':''}${task.id}`),element('span','task-phase',phase),element('span','hint',`${active?'● '+active+' active spans':'保持された観測'} · ${task.stepIds.size} steps · ${task.runIds.size} runs${task.orphan?' · 親は保持範囲外':''}${task.cycle||task.parentConflict?' · 親相関不明':''}`));
      button.addEventListener('click',()=>{selectedTask=task.id;selectedStep=null;selectedSpan=null;$('follow-runs').checked=false;spanSignature='';analysisSignature='';stopPackets();render();});
      item.append(button); $('task-tree').append(item);
    }
    if(focusedTask) [...$('task-tree').querySelectorAll('button')].find(button=>button.dataset.task===focusedTask)?.focus({preventScroll:true});
    const picker=$('step-picker'); picker.replaceChildren(new Option('task内の全step','')); picker.disabled=!selected;
    for (const id of selected?.stepIds??[]) picker.append(new Option(id,id)); picker.value=selectedStep??'';
    taskSignature=signature;
  }

  function analysisSpans() {
    const spans=$('metric-scope').value==='window' ? [...state.runs.values()].flatMap(run=>[...run.spans.values()]) : [...(currentRun()?.spans.values()??[])].filter(span=>!span.linked);
    return effectiveObservedSpans(state,spans);
  }

  function renderAnalysis() {
    const spans=analysisSpans(), selected=[...(currentRun()?.spans.values()??[])];
    const signature=JSON.stringify([state.cursor,state.transport,state.selectedRunId,selectedTask,selectedStep,$('metric-scope').value,spans.length]);
    if (signature===analysisSignature) return;
    const summary=timingSummary(spans), times=spans.flatMap(span=>[span.startedAt,span.endedAt]).filter(Boolean).sort();
    const scope=$('metric-scope').value==='window'?'現在保持window':selectedTask?`選択task ${selectedTask}${selectedStep?' / step '+selectedStep:''}`:`選択run ${state.selectedRunId??'—'}（参照spanは集計除外）`;
    $('metric-summary').textContent=`${scope} · ${times.length?timeValue(times[0])+'–'+timeValue(times.at(-1)):'時刻なし'} · 完了実測 n=${summary.n} / ${summary.total} spans · ${state.events.length}/${MAX_EVENTS} events保持`;
    $('metric-rows').replaceChildren(); $('stream-metric-rows').replaceChildren();
    const ms=value=>value===null?'—':`${value.toFixed(1)} ms`;
    for (const group of timingGroups(spans)) {
      const row=element('tr'), title=element('td'); title.append(element('strong','',nodeLabel(group.node)),element('span','metric-source',`${group.model??'モデル指定なし'} / ${group.origin}`)); row.append(title);
      const cache=group.cache;
      for (const value of [`${group.n} / ${group.total}`,ms(group.median),ms(group.p95),`${group.unmeasured} / ${group.failed} / ${group.running} / ${group.unknown}`,cache.providerN?`${cache.readN?cache.readTokens:'—'} / ${cache.writeN?cache.writeTokens:'—'} tokens (n=${cache.readN}/${cache.writeN}, requests=${cache.providerN})`:'—']) row.append(element('td','',value));
      $('metric-rows').append(row);
      if (group.node==='llm') {
        const stream=streamTimingSummary(group.spans),line=element('tr');
        line.append(element('td','',`${group.model??'モデル指定なし'} / ${group.origin}`),element('td','',String(stream.completedRequests)));
        for(const part of [stream.firstVisible,stream.finalUsage]) for(const value of [String(part.n),ms(part.median),ms(part.p95)]) line.append(element('td','',value));
        $('stream-metric-rows').append(line);
      }
    }
    $('timeline').replaceChildren(); $('timeline-count').textContent=`${Math.min(120,selected.length)} / ${selected.length} spans · 最新120件まで`;
    const rows=timelineRows(selected).slice(-120), scales=new Map();
    for (const row of rows) { const origin=row.span.origin??'unknown'; scales.set(origin,Math.max(scales.get(origin)??1,(row.offsetMs??0)+(row.durationMs??0))); }
    for (const origin of ['server','client','unknown']) {
      const subset=rows.filter(row=>(row.span.origin??'unknown')===origin); if (!subset.length) continue;
      const heading=element('li','timeline-domain',`${origin.toUpperCase()} / この出典内の開始時刻を基準`); $('timeline').append(heading);
      for (const row of subset) {
        const span=row.span, item=element('li'), button=element('button','timeline-row'); button.type='button'; button.dataset.circuit=circuitFor(span.node);
        const title=element('span','timeline-label',nodeLabel(span.node)); title.append(element('small','',`${span.stepId??span.id}${span.linked?' / 別run参照':''}`));
        const track=element('span','timeline-track'), bar=element('i','timeline-bar'); bar.setAttribute('aria-hidden','true');
        if (row.offsetMs!==null) { bar.style.left=`${row.offsetMs/scales.get(origin)*100}%`; bar.style.width=`${Math.max(.25,(row.durationMs??0)/scales.get(origin)*100)}%`; }
        else bar.hidden=true;
        bar.dataset.measured=String(row.provenance==='observed'); track.append(bar);
        button.append(title,track,element('span','timeline-time',`${row.offsetMs===null?'開始未観測':'+'+row.offsetMs.toFixed(1)+' ms'} / ${row.durationMs===null?row.provenance==='open'?'処理中・未確定':'未計測':ms(row.durationMs)} · ${STATE_LABELS[spanState(span,currentRun(),state.transport)]}`));
        button.addEventListener('click',()=>selectNode(span.node,spanKey(span))); item.append(button); $('timeline').append(item);
      }
    }
    analysisSignature=signature;
  }

  function tick() {
    clockTimer=null;
    if (document.hidden || state.transport!=='live') return;
    renderNodes();
    const span=[...(currentRun()?.spans.values()??[])].find(item=>spanKey(item)===selectedSpan);
    $('detail-elapsed').textContent=timingText(span);
    if (effectiveObservedSpans(state,[...state.runs.values()].flatMap(run=>[...run.spans.values()])).some(span=>span.state==='running')) clockTimer=setTimeout(tick,250);
  }

  function renderNodes() {
    const run = currentRun();
    for (const [id, button] of nodes) {
      const value = nodeState(run, id, state.transport);
      const coverage = catalog?.coverage?.find(item => item.node === id);
      button.dataset.state = value.state;
      button.dataset.dimmed = String(!routeIncludes(selectedRoute, id));
      button.querySelector('.node-time').textContent = timingText([...value.spans].reverse().find(span=>spanState(span,run,state.transport)==='running')??value.latest);
      button.dataset.coverage = coverage?.availability ?? 'unobserved';
      const suffix = (value.activeCount > 1 ? ` / ×${value.activeCount}` : '') + (value.latest?.linked ? ' / ↗ 参照' : '');
      button.querySelector('.node-state').textContent = STATE_LABELS[value.state] + suffix;
      const output = value.latest?.output;
      button.querySelector('.node-value').textContent = output !== undefined ? shortValue(output) : value.activeCount ? '出力イベント待ち' : coverage?.availability === 'external' ? '外部 · 未計測' : coverage?.availability === 'unobserved' ? '未計測' : 'イベント待ち';
      button.title = `${nodeLabel(id)} / ${STATE_LABELS[value.state]}${suffix} / ${NODE_SPECS.find(spec=>spec[0]===id)?.[5]??''}`;
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
    if (!value.spans.some(span => spanKey(span) === selectedSpan)) selectedSpan = value.spans.length ? spanKey(value.spans.at(-1)) : null;
    const span = value.spans.find(item => spanKey(item) === selectedSpan);
    const signature = value.spans.map(item => `${item.id}:${item.state}`).join('|') + selectedSpan + state.transport;
    if (signature !== spanSignature) {
      const picker = $('span-picker'); picker.replaceChildren();
      if (!value.spans.length) picker.append(new Option('観測した処理なし', ''));
      for (const item of [...value.spans].reverse()) picker.append(new Option(`${STATE_LABELS[spanState(item, run, state.transport)]}${item.linked ? ' ↗ 参照' : ''} / ${item.id}`, spanKey(item)));
      picker.value = selectedSpan ?? ''; picker.disabled = !value.spans.length; spanSignature = signature;
    }
    $('detail-state').textContent = STATE_LABELS[spanState(span, run, state.transport)];
    $('detail-origin').textContent = (span?.origin === 'server' ? 'SERVER / サーバー観測' : span?.origin === 'client' ? 'CLIENT / 端末からの報告' : '出典の記録なし') + (span?.linked ? ' · 別runの参照' : '');
    $('detail-run').textContent = span?.runId ?? run?.id ?? '—'; $('detail-span').textContent = span?.id ?? '—';
    $('detail-parent').textContent = span?.parentSpanId ?? '—'; $('detail-model').textContent = span?.model ?? 'モデル指定のイベントなし';
    $('detail-start').textContent = timeValue(span?.startedAt); $('detail-end').textContent = timeValue(span?.endedAt);
    $('detail-elapsed').textContent = timingText(span);
    $('detail-task').textContent = span?.taskId ?? 'task相関なし（既存経路等）';
    $('detail-step').textContent = span?.stepId ?? '—';
    $('detail-action').textContent = span?.actionId ?? '—';
    const cache = timingSummary(span ? [span] : []).cache;
    const stream = streamTimingSummary(span ? [span] : []);
    $('detail-first-visible').textContent = stream.firstVisible.n ? `${stream.firstVisible.median.toFixed(1)} ms · サーバーcallback` : '未計測';
    $('detail-final-usage').textContent = stream.finalUsage.n ? `${stream.finalUsage.median.toFixed(1)} ms · 最終usage受信` : '未計測';
    $('detail-cache').textContent = cache.providerN ? `read ${cache.readN ? cache.readTokens : '未計測'} / write ${cache.writeN ? cache.writeTokens : '未計測'} tokens` : 'provider usageなし';
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
      button.addEventListener('click', () => selectNode(event.node, event.kind.startsWith('span.') ? `${event.runId}/${event.spanId}` : null)); item.append(button); $('event-list').append(item);
    }
  }

  function render() {
    renderTasks(); renderRuns(); renderNodes(); renderDetail(); renderAnalysis(); renderEvents(); updateRoute();
    $('notice').textContent = state.notice; $('notice').hidden = !state.notice;
  }

  function addEdge(from, to, background = false) {
    const key = `${from}>${to}`;
    if (paths.has(key)) return paths.get(key);
    const routed = mapRouter?.route(from,to);
    if (!routed) return null;
    const path = routed.path;
    const shield = svgElement('path', { d:path, class:'edge-shield' });
    const value = svgElement('path', { d:path, class:`edge${background?' background':''}`, 'data-from':from, 'data-to':to, 'data-points':JSON.stringify(routed.points), 'data-circuit':circuitFor(from), 'marker-end':`url(#arrow-${circuitFor(from)})` });
    value.dataset.dimmed = String(!routeIncludes(selectedRoute,from,to));
    $('edges').append(shield,value); paths.set(key,value); return value;
  }

  function updateRoute() {
    for (const [key, path] of paths) { const [from,to]=key.split('>'); path.dataset.dimmed=String(!routeIncludes(selectedRoute,from,to)); }
    for (const button of $('route-picker').children) button.setAttribute('aria-pressed',String(button.dataset.route===selectedRoute));
    $('route-note').textContent = selectedRoute==='all' ? '配線は実装上の経路。光と点は新しく届いた実handoffだけです。' : `${ROUTES[selectedRoute].label}の代表経路を強調中。稼働・移行済みを意味しません。薄い箱も選択できます。`;
  }

  function layout() {
    const width = $('graph-scroll').clientWidth;
    if (!width || width === graphWidth) return;
    graphWidth = width; stopPackets(); paths.clear(); $('edges').replaceChildren(); $('zones').replaceChildren();
    const layout = mapLayout(width);
    // A run/privacy reset drops observed routes but can reuse the public structural routing work.
    if (!mapRouter || routedWidth !== layout.width) { mapRouter=createMapRouter(layout);routedWidth=layout.width; }
    else mapRouter.reset();
    for (const [id,box] of layout.boxes) {
      const button=nodes.get(id); button.style.left=`${box.x}px`; button.style.top=`${box.y}px`; button.style.width=`${box.w}px`;button.style.height=`${box.h}px`;
    }
    $('canvas').style.width=`${layout.width}px`; $('canvas').style.height=`${layout.height}px`; $('wires').setAttribute('viewBox',`0 0 ${layout.width} ${layout.height}`);
    let labels=$('zone-labels');
    if(!labels) {labels=svgElement('g',{id:'zone-labels'});$('wires').insertBefore(labels,$('trails'));}
    labels.replaceChildren();
    for (const zone of layout.zones) {
      $('zones').append(svgElement('rect',{x:zone.x,y:zone.y,width:zone.w,height:zone.h,rx:6,class:'zone'}));
      const labelWidth=Math.min(zone.w-16,[...zone.label].reduce((sum,char)=>sum+(char.codePointAt(0)>255?10:6),0)+16);
      labels.append(svgElement('rect',{x:zone.x+8,y:zone.y+5,width:labelWidth,height:19,rx:2,class:'zone-label-mask'}));
      const text=svgElement('text',{x:zone.x+16,y:zone.y+19,class:'zone-label'});text.textContent=zone.label;labels.append(text);
    }
    for (const [from,to,background] of LINKS) addEdge(from,to,background);
    updateRoute();
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

  function eventInView(event) { return selectedTask ? event.taskId === selectedTask && (!selectedStep || event.stepId === selectedStep) : event.runId === state.selectedRunId; }

  function receiptGlow(event) {
    if (!eventInView(event) || document.hidden || !routeIncludes(selectedRoute,event.node)) return;
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
    if (!eventInView(event) || !routeIncludes(selectedRoute,event.fromNode,event.toNode) || reduceMotion.matches || document.hidden || animations.size >= 24) return;
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
    basePath: observerBasePath(window.location.pathname), fetch: window.fetch.bind(window), desktopBridge,
    getCursor: () => state.cursor,
    onReset: reason => { clearPrivateView(); $('connect-error').textContent = reason; $('connect-error').hidden = !reason; if (desktopBridge && reason) state.notice = reason; },
    onCatalog: value => { if (priorCatalog === value) return; catalog = value; priorCatalog = value; toolSignature = ''; renderNodes(); renderDetail(); },
    onCredential: credential => {
      if (desktopBridge) return;
      const saved = session.write(credential);
      $('pair-hint').textContent = saved ? '同じタブでは再読み込みしても接続を維持します。「接続を切る」で保存した接続情報を消します。' : 'このブラウザでは接続情報を保存できません。再読み込み後は再接続が必要です。';
    },
    onEnvelope: (envelope, delivery) => {
      const previous = state, seen = new Set(previous.events.map(event => event.sequence));
      if(previous.instanceId!==envelope.instanceId||envelope.gap||(envelope.dropped??0)>previous.dropped||envelope.availability==='held') elapsedClock.clear();
      state = reduceObserverEnvelope(previous,envelope,$('follow-runs').checked && !selectedTask);
      elapsedClock.observe(effectiveObservedSpans(state,[...state.runs.values()].flatMap(run=>[...run.spans.values()])), performance.now());
      if (!clockTimer && state.transport==='live') clockTimer=setTimeout(tick,250);
      if (previous.transport === 'lost' && state.transport === 'live' && !envelope.gap && previous.instanceId === state.instanceId) state.notice = '接続が回復しました。受信したイベントから表示を更新しました。';
      if (envelope.availability === 'held') { selectedTask=null; selectedStep=null; taskSignature=''; analysisSignature=''; elapsedClock.clear(); selectedSpan = null; selectedTool = null; catalog = null; priorCatalog = null; toolSignature = ''; stopPackets(); graphWidth=0; layout(); }
      if (state.selectedRunId !== previous.selectedRunId || state.instanceId !== previous.instanceId || envelope.gap || state.dropped > previous.dropped) { selectedSpan = null; spanSignature = ''; stopPackets(); graphWidth=0; layout(); }
      const changed = envelope.events.some(event => !seen.has(event.sequence)) || previous.transport !== state.transport || previous.availability !== state.availability || previous.notice !== state.notice || state.instanceId !== previous.instanceId || envelope.gap;
      if (changed) render();
      // Initial history, a gap and a server restart remain still. Only a new live receipt moves.
      if (delivery?.liveReceipts && previous.instanceId === state.instanceId && previous.transport === 'live' && !envelope.gap && state.dropped === previous.dropped) for (const event of envelope.events) if (!seen.has(event.sequence)) {
        receiptGlow(event);
        if (event.kind === 'handoff') handoffPacket(event);
      }
    },
    onConnection: connection => {
      const previous = state.transport; state = {...state,transport:connection}; root.dataset.connection=connection;
      const labels = {disconnected:'未接続',connecting:'接続中',live:'LIVE / 観測中',held:'HELD / 非表示',paused:'PAUSED / 観測休止',lost:'接続を再確認中'};
      $('connection-state').textContent=labels[connection]; $('connect-panel').hidden=!!desktopBridge || !['disconnected','connecting'].includes(connection);
      $('disconnect').hidden=!!desktopBridge || connection==='disconnected';
      for (const button of document.querySelectorAll('#connect-panel button')) button.disabled=connection==='connecting';
      if (connection==='paused') { const cursor=state.cursor,instanceId=state.instanceId; clearPrivateView(); state={...state,cursor,instanceId,transport:'paused'}; }
      if (connection==='lost') { const cursor=state.cursor,instanceId=state.instanceId; clearPrivateView(); state={...state,cursor,instanceId,transport:'lost'}; state.notice=desktopBridge && $('connect-error').textContent || '接続が途切れています。処理中だった箇所の結果は未確認です。自動で接続を再確認します。'; }
      if (connection==='live' && previous==='lost') state.notice='接続が回復しました。受信したイベントから表示を更新しました。';
      if (previous!==connection) { runSignature=''; render(); }
    },
  });

  for (const [id,route] of Object.entries(ROUTES)) { const button=element('button','',route.label);button.type='button';button.dataset.route=id;button.addEventListener('click',()=>{selectedRoute=id;stopPackets();renderNodes();updateRoute();});$('route-picker').append(button); }
  $('clear-task').addEventListener('click',()=>{selectedTask=null;selectedStep=null;selectedSpan=null;spanSignature='';stopPackets();render();});
  $('step-picker').addEventListener('change',()=>{selectedStep=$('step-picker').value||null;selectedSpan=null;spanSignature='';stopPackets();render();});
  $('metric-scope').addEventListener('change',renderAnalysis);
  $('pair-form').addEventListener('submit',event=>{event.preventDefault(); const code=$('pair-code').value; $('pair-code').value=''; void client.pair(code);});
  $('token-form').addEventListener('submit',event=>{event.preventDefault(); const token=$('pair-token').value; $('pair-token').value=''; client.connect(token);});
  $('disconnect').addEventListener('click',()=>client.disconnect());
  $('run-picker').addEventListener('change',()=>{selectedTask=null;selectedStep=null;state={...state,selectedRunId:$('run-picker').value}; $('follow-runs').checked=false; selectedSpan=null; spanSignature=''; toolSignature=''; stopPackets(); render();});
  $('follow-runs').addEventListener('change',()=>{if($('follow-runs').checked){selectedTask=null;selectedStep=null;const latest=[...state.runs.values()].sort((a,b)=>b.firstSequence-a.firstSequence)[0]; state={...state,selectedRunId:latest?.id??null};selectedSpan=null;spanSignature='';stopPackets();render();}});
  $('span-picker').addEventListener('change',()=>{selectedSpan=$('span-picker').value;renderDetail();});
  $('tool-filter').addEventListener('change',()=>{toolSignature='';renderTools(currentRun());});
  document.addEventListener('visibilitychange',()=>document.hidden?client.pause():client.resume());
  window.addEventListener('pagehide',()=>client.pause());
  window.addEventListener('pageshow',event=>{if(event.persisted&&!document.hidden)client.resume();});
  reduceMotion.addEventListener('change',stopPackets);
  if (typeof ResizeObserver==='function') new ResizeObserver(layout).observe($('graph-scroll')); else window.addEventListener('resize',layout);
  render(); layout();
  if(document.hidden)client.pause();
  if (desktopBridge) {
    let desktopEpoch = -1;
    const applyConnection = value => {
      if (!record(value) || typeof value.connected !== 'boolean' || !Number.isSafeInteger(value.epoch) || value.epoch <= desktopEpoch) return;
      desktopEpoch = value.epoch;
      if (value.connected) client.connectExisting();
      else { client.disconnect(); state.notice = 'Windowsアプリの設定からシャノンに接続してください。'; render(); }
    };
    const unsubscribe = desktopBridge.onState(applyConnection);
    void desktopBridge.getState().then(applyConnection).catch(() => client.disconnect('Windowsアプリの接続を確認してください。'));
    window.addEventListener('pagehide', event => { if (!event.persisted) unsubscribe(); });
  } else {
    const saved = session.read();
    if (saved) client.connect(saved.token, saved.expiresAt);
  }
}

if (typeof document !== 'undefined') mountObserver();
