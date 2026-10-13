import { BLOCKS, VIEW_NODES, VIEW_INDEX, VIEW_LINKS, viewNodeOf, viewHandoff, CURRENT_LAYOUT, TARGET_LAYOUT, TARGET_BLOCKS, TARGET_NODES, TARGET_LINKS, TARGET_RUNS, dummyFields, mergeFields, routeTable, blockRoutes, edgeCurve, routePath, routePoint, detailLevel, ioRows, fitText, textWidth } from './observerMap.js';
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

/** Per-tab view preferences only (never credentials or observations): overlay hidden, hint dismissed, picked detail level. */
export function viewPrefs(value) {
  const saved = record(value) ? value : {};
  return { hidden: saved.hidden === true, hint: saved.hint === true, level: [1, 2, 3].includes(saved.level) ? saved.level : null };
}

/* ================= Owner view (2026-10-13): per-turn timeline first, layered map second ================= */
const STATE_LABELS = { running: '処理中', completed: '完了', failed: '失敗', cancelled: '取り消し', unknown: '不明', unobserved: '未観測' };
const GLOSS = { surface: '入口', parentRunId: '親run', status: '結果', model: 'モデル', messageCount: 'メッセージ数', maximumOutputTokens: '出力上限',
  offeredTools: '渡した道具', offeredCount: '候補の道具数', chosen: '選んだ数', offered: '候補数', round: '回目', streaming: '逐次', itemCount: '候補', sourceCount: '出どころ', memoryCount: '記憶',
  maximumWaitMs: '待てる上限', phase: '段階', allowed: '許可', admitted: '受付', revision: '版', taskId: 'task', stepId: 'step', parentId: '親task', errorKind: '失敗の種類',
  sampleCount: '標本数', byteCount: 'バイト', sampleRate: '標本化', channels: 'チャンネル', bitsPerSample: 'ビット', destination: '渡し先', operation: '操作',
  boundary: '境界', kind: '種類', outcomeCount: '結果数', historyMessageCount: '履歴', deliveredMessageCount: '送った履歴', tools: '道具', messages: 'メッセージ',
  selector: '選び手', provider: '提供元', difficulty: '難しさ', steps: '段の時間', modelStartMs: 'モデルまで', firstVisibleOutputAfterMs: '最初の表示',
  finalUsageAfterMs: '最終usage', semantic: '意味で想起', strategy: '方法', message: '発言', recalledCount: '想起数', characterCount: '文字数',
  utteranceId: '発話', captureRunId: '録音run', sentenceCount: '文の数', selected: '選択', reason: '理由', trigger: 'きっかけ', candidateCount: '候補数',
  questionCount: '質問数', name: '名前', fixture: '見本', replyChars: '返事の字数', toolCalls: '道具呼出', chosenTools: '選んだ道具', stop: '止まり方', cacheReadInputTokens: 'cache 読み', cacheCreationInputTokens: 'cache 書き', toolMenu: '道具メニュー', saved: '保存', turns: '発言', audience: '聞き手', eventId: '出来事', threadId: '会話', snapshotVersion: '状態の版', peopleCount: '人', explicitCommand: '命令', actionId: 'action', selectedTools: '選んだ道具' };
const STEP_LABELS = { orchestration: '段取り', command: '命令', snapshot: '状態', people: '人', deterministic: '決定的文脈', identity: '自己とできること',
  threadSummary: '要約', provenance: '出典', toolOffer: '道具の提示', replay: '再生', fcaContext: 'FCA 文脈' };
const BASE_STEPS = ['orchestration', 'command', 'snapshot', 'people', 'deterministic'];
const TOOL_VIEWS = new Set(['router', 'fcaTool', 'gate', 'tools', 'haiku']);
const fmt = value => Math.round(value).toLocaleString('ja-JP');
const ms = value => typeof value === 'number' && Number.isFinite(value) ? `${fmt(value)} ms` : '—';
const textValue = value => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const shortText = (value, size = 160) => { const text = textValue(value).replace(/\s+/g, ' '); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };
const timeValue = value => value ? new Date(value).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, fractionalSecondDigits: 3 }) : '—';
/** Observed JSON as rows. Values are shown as projected by the server, never re-derived. */
function fieldRows(value) {
  if (value === undefined) return [];
  if (!record(value)) return [{ gloss: '値', key: '', value: shortText(value, 400) }];
  return Object.entries(value).filter(([key]) => key !== 'steps').map(([key, item]) => ({ gloss: GLOSS[key] ?? '', key, value: shortText(item, 400) }));
}

function mountObserver() {
  const $ = id => document.getElementById(id);
  const root = $('observer');
  if (!root) return;
  const el = (name, className, text, parent) => { const value = document.createElement(name); if (className) value.className = className; if (text !== undefined && text !== null) value.textContent = text; if (parent) parent.append(value); return value; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Presentation attributes only; the page CSP forbids inline style attributes.
  const sv = (name, attrs, parent) => { const value = document.createElementNS(SVGNS, name); for (const [key, content] of Object.entries(attrs ?? {})) value.setAttribute(key, String(content)); if (parent) parent.append(value); return value; };
  const role = (target, value) => target.style.setProperty('--c', `var(--c-${value})`);
  const desktopBridge = window.shannonObserver;
  const session = createObserverSession(() => window.sessionStorage, `shannon.observer.connection.v1:${observerBasePath(window.location.pathname)}`);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = createObserverState(), catalog = null, priorCatalog = null;
  let mode = 'cur', view = 'timeline', selectedTask = null, selectedStep = null, selectedKey = null, selectedView = null, focusBlock = null;
  // Owner feedback 2026-10-13: the canvas fills the viewport and every control floats above it. Only this view preference is kept per tab.
  const uiKey = `shannon.observer.ui.v1:${observerBasePath(window.location.pathname)}`;
  const readUi = () => { try { const value = JSON.parse(window.sessionStorage.getItem(uiKey) ?? 'null'); return record(value) ? value : {}; } catch { return {}; } };
  const writeUi = value => { try { window.sessionStorage.setItem(uiKey, JSON.stringify(viewPrefs(value))); } catch { /* storage may be unavailable */ } };
  const ui = viewPrefs(readUi()), panels = { tasks: false, metrics: false };
  let drawerOpen = false, topPad = 120;
  const elapsedClock = createElapsedClock(); let clockTimer = null;
  let viewRuns = null, viewId = null, linkedView;
  const currentRun = () => {
    if (selectedTask) return taskRunView(state, selectedTask, selectedStep);
    if (viewRuns !== state.runs || viewId !== state.selectedRunId) { viewRuns = state.runs; viewId = state.selectedRunId; linkedView = linkedRunView(state, state.selectedRunId); }
    return linkedView;
  };
  const viewModel = () => mode === 'cur'
    ? { blocks: BLOCKS, nodes: VIEW_NODES, index: VIEW_INDEX, layout: CURRENT_LAYOUT, links: VIEW_LINKS }
    : { blocks: TARGET_BLOCKS, nodes: TARGET_NODES, index: new Map(TARGET_NODES.map(spec => [spec[0], spec])), layout: TARGET_LAYOUT, links: TARGET_LINKS };
  const blockOf = (model, id) => model.index.get(id)?.[1];
  const blockSpec = (model, id) => model.blocks.find(block => block[0] === id);
  const roleFor = (model, id) => blockSpec(model, blockOf(model, id))?.[3] ?? 'own';
  const labelFor = (model, id) => model.index.get(id)?.[4] ?? id;

  /* ---------- Rows: one normalized shape for live spans and the dummy target ---------- */
  function liveRows() {
    const run = currentRun();
    if (!run) return { rows: [], run };
    const spans = effectiveObservedSpans(state, [...run.spans.values()]), now = performance.now();
    const rows = [];
    for (const item of timelineRows(spans)) {
      const span = item.span, id = viewNodeOf(span.node, span.input, span.output);
      if (!id) continue;
      let duration = item.durationMs, open = false;
      if (span.state === 'running') { const elapsed = elapsedClock.elapsed(span, now); if (elapsed !== null) { duration = elapsed; open = true; } }
      rows.push({ key: spanKey(span), span, view: id, offset: item.offsetMs, duration, open, measured: item.provenance === 'observed',
        state: span.state, origin: span.origin === 'client' ? 'client' : 'server', root: Boolean(span.isRunRoot), linked: Boolean(span.linked) });
    }
    return { rows, run };
  }
  const target = { run: 0, t: 0, playing: !reduceMotion.matches, last: 0, seen: new Set(), frame: null, hold: 0 };
  function dummyRows() {
    const model = viewModel(), run = TARGET_RUNS[target.run], rows = [];
    run.spans.forEach(([id, start, duration, override, kids], index) => {
      if (start > target.t) { rows.push({ key: `dummy/${index}`, view: id, offset: start, duration, future: true, state: 'unobserved', origin: 'server', dummy: true, index, kids, override }); return; }
      const end = start + duration, open = target.t < end;
      rows.push({ key: `dummy/${index}`, view: id, offset: start, duration: open ? target.t - start : duration, full: duration, open, measured: true, state: open ? 'running' : 'completed', origin: 'server', dummy: true, index, kids, override });
    });
    return { rows, run: null, total: Math.max(...run.spans.map(([, start, duration]) => start + duration)) + 200, model };
  }
  function dummyFieldsOf(row) {
    const spec = viewModel().index.get(row.view), [inputOverride, outputOverride] = (row.override || '|').split('|');
    return { input: mergeFields(dummyFields(spec?.[6]), inputOverride), output: mergeFields(dummyFields(spec?.[7]), outputOverride) };
  }

  /* ---------- Timeline (案B) ---------- */
  let timelineSignature = '', barElements = new Map();
  function renderTimeline() {
    const model = viewModel(), data = mode === 'cur' ? liveRows() : dummyRows(), rows = data.rows;
    const host = $('lanes'); const axis = $('axis'); const head = $('run-head');
    const placed = rows.filter(row => row.offset !== null), unplaced = rows.filter(row => row.offset === null);
    const domains = { server: placed.filter(row => row.origin === 'server'), client: placed.filter(row => row.origin === 'client') };
    const extent = list => Math.max(1, ...list.map(row => row.offset + (row.full ?? row.duration ?? 0)));
    const scale = { server: data.total ?? extent(domains.server), client: extent(domains.client) };
    const signature = JSON.stringify([mode, focusBlock, rows.map(row => [row.key, row.state, row.offset, row.future ?? false, row.duration === null]), Math.round(scale.server / 250), Math.round(scale.client / 250)]);
    $('timeline-empty').hidden = rows.length > 0;
    $('timeline-empty').textContent = mode === 'cur' ? (state.transport === 'live' ? 'この一回の処理をまだ観測していません。会話や作業が始まると、ここに時間割が出ます。' : '接続すると、届いた処理を時間割で表示します。') : '';
    if (signature !== timelineSignature) {
      timelineSignature = signature; barElements = new Map();
      host.replaceChildren(); head.replaceChildren(); axis.replaceChildren();
      const roots = rows.filter(row => row.root);
      if (roots.length) {
        el('span', 'lane-name', '一回', head).title = 'run（ターンや作業の一回）';
        const track = el('div', 'track run-track', null, head);
        for (const row of roots) bar(row, track, scale.server, 0, model);
        const steps = roots.map(row => row.span?.output).find(output => record(output) && typeof output.modelStartMs === 'number');
        const rootRow = roots.find(row => record(row.span?.output) && typeof row.span.output.modelStartMs === 'number');
        if (steps && rootRow && rootRow.offset !== null) marker(host, (rootRow.offset + steps.modelStartMs) / scale.server, `モデルへ ${fmt(steps.modelStartMs)} ms`);
      }
      if (mode === 'tgt' && TARGET_RUNS[target.run].spans.some(([id]) => id === 'haikuLow')) marker(host, 350 / scale.server, 'モデルへ 350 ms');
      for (const [blockId, label, process, blockRole] of model.blocks) {
        const lane = rows.filter(row => !row.root && row.offset !== null && blockOf(model, row.view) === blockId);
        if (!lane.length) continue;
        const client = lane.every(row => row.origin === 'client');
        const laneElement = el('div', 'lane', null, host); role(laneElement, blockRole); laneElement.dataset.block = blockId;
        if (focusBlock && focusBlock !== blockId) laneElement.classList.add('dim');
        const name = el('button', 'lane-name', label, laneElement); name.type = 'button'; name.title = `${label}（${process}）${client ? ' · 端末の時計で別の目盛り' : ''}`;
        name.addEventListener('click', () => setFocus(focusBlock === blockId ? null : blockId));
        if (client) el('small', '', '端末の時計', name);
        const track = el('div', 'track', null, laneElement), ends = [];
        for (const row of lane.sort((a, b) => a.offset - b.offset)) {
          const total = client ? scale.client : scale.server, end = row.offset + Math.max(row.full ?? row.duration ?? 0, total * .03);
          let slot = ends.findIndex(value => value <= row.offset); if (slot < 0) { slot = ends.length; ends.push(0); } ends[slot] = end;
          bar(row, track, total, slot, model);
        }
        track.style.setProperty('--rows', String(Math.max(1, ends.length)));
      }
      if (unplaced.length) {
        const line = el('p', 'unplaced', '開始を観測していない処理：', host);
        for (const row of unplaced) { const button = el('button', 'chip', labelFor(model, row.view), line); button.type = 'button'; button.addEventListener('click', () => select(row.key, row.view)); }
      }
      const step = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000].find(value => scale.server / value <= 7) ?? 120000;
      for (let value = 0; value <= scale.server; value += step) { const tick = el('span', '', value >= 1000 ? `${value / 1000}s` : `${value}`, axis); tick.style.setProperty('left', `${value / scale.server * 100}%`); }
      if (mode === 'tgt') { const playhead = el('div', 'playhead', null, host); playhead.id = 'playhead'; }
    }
    for (const [key, item] of barElements) {
      const row = rows.find(value => value.key === key); if (!row) continue;
      const width = row.future ? (row.full ?? row.duration) : row.duration;
      item.element.style.setProperty('width', `${width === null || width === undefined ? 0 : width / item.total * 100}%`);
      item.element.classList.toggle('open', Boolean(row.open));
      if (row.open && !row.dummy) item.element.title = `${labelFor(model, row.view)} ≥ ${fmt(row.duration)} ms · 受信後（下限）`;
    }
    const playhead = $('playhead');
    if (playhead) playhead.style.setProperty('left', `calc(var(--lane-w) + (100% - var(--lane-w)) * ${Math.min(1, target.t / scale.server)})`);
    $('run-summary').textContent = mode === 'cur' ? runSummary(data.run, rows) : `${TARGET_RUNS[target.run].name} · ${fmt(target.t)} / ${fmt(scale.server)} ms · ダミー`;
    return rows;
  }
  function marker(host, fraction, text) {
    const mark = el('div', 'mark', null, host); mark.style.setProperty('left', `calc(var(--lane-w) + (100% - var(--lane-w)) * ${Math.min(1, fraction)})`); el('b', '', text, mark);
  }
  function bar(row, track, total, slot, model) {
    const button = el('button', `bar state-${row.state}${row.future ? ' future' : ''}${row.linked ? ' linked' : ''}${row.duration === null ? ' unmeasured' : ''}`, null, track);
    button.type = 'button'; role(button, roleFor(model, row.view)); button.dataset.key = row.key;
    button.style.setProperty('left', `${row.offset / total * 100}%`); button.style.setProperty('--slot', String(slot));
    const label = labelFor(model, row.view), errorKind = record(row.span?.output) && typeof row.span.output.errorKind === 'string' ? row.span.output.errorKind : null;
    el('span', 'bar-label', `${row.state === 'failed' ? '! ' : ''}${label}`, button);
    if (row.kids) for (const [name, start, duration] of row.kids) { const kid = el('i', 'kid', null, button); kid.style.setProperty('left', `${(start - row.offset) / (row.full ?? row.duration) * 100}%`); kid.style.setProperty('width', `${duration / (row.full ?? row.duration) * 100}%`); kid.title = name; }
    button.title = `${label} · ${row.duration === null ? '所要は未計測' : ms(row.duration)}${errorKind ? ` · 失敗: ${errorKind}` : ''}`;
    button.setAttribute('aria-label', `${label}、${STATE_LABELS[row.state] ?? ''}、${row.duration === null ? '所要は未計測' : `${fmt(row.duration)}ミリ秒`}`);
    button.setAttribute('aria-pressed', String(row.key === selectedKey));
    button.addEventListener('click', () => select(row.key, row.view));
    barElements.set(row.key, { element: button, total });
  }
  function runSummary(run, rows) {
    if (!run) return state.transport === 'live' ? 'イベント待ち' : '';
    const active = rows.filter(row => row.state === 'running').length, failed = rows.filter(row => row.state === 'failed').length;
    const rootRow = rows.find(row => row.root), surface = record(rootRow?.span?.input) && typeof rootRow.span.input.surface === 'string' ? rootRow.span.input.surface : null;
    return `${selectedTask ? `task ${selectedTask}${selectedStep ? ` / step ${selectedStep}` : ''}` : surface ? `入口 ${surface}` : 'run'} · ${rows.length} 処理${active ? ` · 処理中 ${active}` : ''}${failed ? ` · 失敗 ${failed}` : ''}${run.linkedCount ? ` · 別runの参照 ${run.linkedCount}` : ''}${run.incomplete ? ' · 開始は未観測' : ''}`;
  }

  /* ---------- Detail (shared by both views) ---------- */
  function select(key, id) { selectedKey = key; selectedView = id; setDrawer(true); for (const [rowKey, item] of barElements) item.element.setAttribute('aria-pressed', String(rowKey === key)); renderDetail(); highlightMapSelection(); $('announcement').textContent = `${labelFor(viewModel(), id)}の入力と出力を表示しました。`; }
  function table(title, rows, parent) {
    const box = el('div', 'io', null, parent); el('h4', '', title, box);
    if (!rows.length) { el('p', 'hint', 'なし', box); return; }
    const grid = el('table', 'kv', null, box), body = el('tbody', '', null, grid);
    for (const row of rows) { const line = el('tr', '', null, body), name = el('td', 'name', row.gloss || row.key, line); if (row.gloss && row.key) el('small', 'k', row.key, name); el('td', 'v', row.value, line); }
  }
  function stepsBlock(parent, output, span) {
    if (!record(output) || !record(output.steps)) return false;
    const steps = Object.entries(output.steps).filter(([, value]) => typeof value === 'number');
    if (!steps.length) return false;
    const box = el('div', 'steps', null, parent); el('h4', '', 'ターンの段（turn steps）', box);
    const list = el('ul', '', null, box), sum = steps.reduce((total, [, value]) => total + value, 0);
    for (const [name, value] of steps) { const item = el('li', '', `${STEP_LABELS[name] ?? name} `, list); el('span', 'num', ms(value), item); }
    const total = typeof span?.elapsedMs === 'number' ? span.elapsedMs : null, model = typeof output.modelStartMs === 'number' ? output.modelStartMs : null;
    el('p', 'hint', `段の合計 ${ms(sum)}${model !== null ? ` · モデルまで ${ms(model)} · 段の外 ${ms(Math.max(0, model - sum))}（並列の想起・Jev・待ちを含む）` : ''}${total !== null ? ` · 全体 ${ms(total)}` : ''}`, box);
    return true;
  }
  function baseSteps(parent, span, run) {
    const rootSpan = [...(run?.spans.values() ?? [])].find(item => item.isRunRoot && item.runId === span.runId);
    const steps = record(rootSpan?.output) && record(rootSpan.output.steps) ? rootSpan.output.steps : null;
    if (!steps) return;
    const parts = BASE_STEPS.filter(name => typeof steps[name] === 'number');
    if (!parts.length) return;
    const box = el('div', 'steps', null, parent); el('h4', '', '土台の中の段', box);
    const list = el('ul', '', null, box), sum = parts.reduce((total, name) => total + steps[name], 0);
    for (const name of parts) { const item = el('li', '', `${STEP_LABELS[name]} `, list); el('span', 'num', ms(steps[name]), item); }
    if (typeof span.elapsedMs === 'number') { const item = el('li', 'gap', '測っていない隙間 ', list); el('span', 'num', ms(Math.max(0, span.elapsedMs - sum)), item); }
  }
  function concurrent(parent, row, rows, model) {
    if (row.offset === null || row.future) return;
    const end = row.offset + (row.full ?? row.duration ?? 0);
    const others = rows.filter(other => other !== row && !other.root && !other.future && other.offset !== null && other.origin === row.origin && other.offset < end && other.offset + (other.full ?? other.duration ?? 0) > row.offset);
    const box = el('div', 'concurrent', null, parent); el('h4', '', '同時に動いていたもの', box);
    if (!others.length) { el('p', 'hint', 'なし', box); return; }
    const chips = el('div', 'chips', null, box);
    for (const other of others.slice(0, 24)) { const chip = el('button', 'chip', labelFor(model, other.view), chips); chip.type = 'button'; role(chip, roleFor(model, other.view)); chip.addEventListener('click', () => select(other.key, other.view)); }
  }
  function renderDetail() {
    const panel = $('detail'), model = viewModel(); panel.replaceChildren();
    const data = mode === 'cur' ? liveRows() : dummyRows(), rows = data.rows;
    let row = rows.find(item => item.key === selectedKey);
    if (!row && selectedView) row = [...rows].reverse().find(item => item.view === selectedView && !item.future);
    if (!row && !selectedView) row = rows.find(item => item.state === 'failed') ?? [...rows].reverse().find(item => !item.future && (item.view === 'haiku' || item.view === 'executive')) ?? rows.find(item => !item.root && !item.future);
    const id = row?.view ?? selectedView;
    if (!id) { el('p', 'hint', mode === 'cur' ? '時間割の棒か地図の箱を押すと、ここに入力・出力と所要時間が出ます。' : 'ダミーの棒か箱を押すと、ここに入出力が出ます。', panel); return; }
    const spec = model.index.get(id), block = blockSpec(model, spec?.[1]);
    role(panel, roleFor(model, id));
    const title = el('h3', '', labelFor(model, id), panel); el('small', '', block ? `${block[1]} · ${block[2]}` : '', title);
    const status = row ? (row.future ? '未開始' : STATE_LABELS[row.state] ?? row.state) : '未観測';
    el('span', `state state-${row?.state ?? 'unobserved'}`, status, title);
    el('p', 'role', spec?.[5] ?? '', panel);
    if (mode === 'tgt') {
      el('p', 'dummy-note', '目指す姿（ADR-0009）のダミーの値です。本番のイベントではありません。', panel);
      if (row) {
        el('p', 'hint', `開始 +${fmt(row.offset)} ms · 所要 ${fmt(row.full ?? row.duration)} ms`, panel);
        const fields = dummyFieldsOf(row), columns = el('div', 'columns', null, panel); table('入力', fields.input, columns); table('出力', fields.output, columns);
        if (row.kids) { const box = el('div', 'steps', null, panel); el('h4', '', '中の段', box); const list = el('ul', '', null, box); for (const [name, , duration] of row.kids) { const item = el('li', '', `${name} `, list); el('span', 'num', ms(duration), item); } }
        if (id === 'reward') weights(panel);
        concurrent(panel, row, rows, model);
      }
      return;
    }
    const span = row?.span, run = data.run;
    const sources = spec?.[6] ?? [];
    const coverage = sources.map(node => catalog?.coverage?.find(item => item.node === node)).filter(Boolean);
    const definition = sources.map(node => catalog?.nodes?.find(item => item.id === node)).find(Boolean);
    if (!span) {
      el('p', 'hint', id === 'identity' ? '自己とできることは独立した処理として届きません。ターンの段（identity）の時間として、受付の一回の詳細に出ます。'
        : id === 'executive' ? 'Executive は作ってありますが、今は止まっています（観察イベントはありません）。' : id === 'sqlite' ? '共有 SQLite は処理として観察していません。保存や記憶の書き込みの行き先です。'
        : 'この一回では、この処理を観測していません。', panel);
      if (id === 'identity') { const rootSpan = [...(run?.spans.values() ?? [])].find(item => item.isRunRoot && record(item.output) && record(item.output.steps)); if (rootSpan) { const value = rootSpan.output.steps.identity; el('p', 'num', typeof value === 'number' ? `identity ${ms(value)}` : 'identity の段はこの一回で測っていません。', panel); } }
      if (definition) el('p', 'location', definition.location, panel);
      for (const item of coverage) if (item.reason) el('p', 'hint', item.reason, panel);
      return;
    }
    const errorKind = record(span.output) && typeof span.output.errorKind === 'string' ? span.output.errorKind : null;
    if (span.state === 'failed') el('p', 'failure', `失敗${errorKind ? `：${errorKind}` : ''}`, panel);
    const facts = el('dl', 'facts', null, panel);
    const fact = (name, value) => { const wrap = el('div', '', null, facts); el('dt', '', name, wrap); el('dd', '', value, wrap); };
    fact('開始', `${row.offset === null ? '未観測' : `+${fmt(row.offset)} ms`} · ${timeValue(span.startedAt)}`);
    fact('所要', row.open ? `≥ ${fmt(row.duration)} ms · 受信後（下限）` : typeof span.elapsedMs === 'number' && span.endedAt ? `${span.elapsedMs.toFixed(1)} ms · 実測` : '未計測');
    fact('モデル', span.model ?? '—'); fact('出典', span.origin === 'client' ? '端末からの報告' : span.origin === 'server' ? 'サーバー' : '記録なし');
    fact('観察ノード', span.node); fact('run', span.runId); fact('span', span.id); fact('親 span', span.parentSpanId ?? '—');
    if (span.taskId) fact('task', `${span.taskId}${span.stepId ? ` / step ${span.stepId}` : ''}${span.actionId ? ` / action ${span.actionId}` : ''}`);
    if (row.linked) fact('参照', '別 run の span を明示の親子・受け渡しで参照');
    const columns = el('div', 'columns', null, panel); table('入力', fieldRows(span.input), columns);
    table('出力', span.endedAt ? fieldRows(span.output) : [{ gloss: '', key: '', value: span.state === 'running' ? '出力イベント待ち' : '状態不明・完了は未確認' }], columns);
    if (span.isRunRoot) stepsBlock(panel, span.output, span);
    if (id === 'base') baseSteps(panel, span, run);
    concurrent(panel, row, rows, model);
    if (TOOL_VIEWS.has(id)) tools(panel, run);
    if (definition) el('p', 'location', `実装：${definition.location}`, panel);
    for (const item of coverage) if (item.reason) el('p', 'hint', item.reason, panel);
  }
  function weights(parent) {
    const box = el('div', 'steps', null, parent); el('h4', '', '報酬 r2 の重み', box);
    const stack = el('div', 'stack', null, box);
    for (const [name, value, part] of [['完了の判定', 35, 'memory'], ['所有者の反応', 35, 'output'], ['予測が当たった', 20, 'judgment'], ['自分の評価', 10, 'own']]) {
      const piece = el('i', '', null, stack); piece.style.setProperty('width', `${value}%`); role(piece, part); piece.title = `${name} ${value}%`;
      const legend = el('span', 'legend-item', `${name} ${value}%`, box); role(legend, part);
    }
  }
  let toolFilter = 'all', selectedTool = null;
  function tools(parent, run) {
    const evidence = runToolEvidence(run), registry = Array.isArray(catalog?.tools) ? catalog.tools : [];
    const box = el('details', 'tools', null, parent); box.open = evidence.offered.size + evidence.called.size > 0;
    el('summary', '', `道具：提示 ${evidence.offered.size} · 選択 ${evidence.chosen.size} · 実行 ${evidence.called.size}（カタログ ${registry.length}）`, box);
    const filter = el('select', '', null, box); filter.setAttribute('aria-label', '道具の絞り込み');
    for (const [value, name] of [['all', 'カタログ全体'], ['offered', '提示した'], ['chosen', '選んだ'], ['called', '実行した']]) filter.append(new Option(name, value));
    filter.value = toolFilter; filter.addEventListener('change', () => { toolFilter = filter.value; renderDetail(); });
    const known = new Map(registry.map(tool => [tool.name, tool]));
    for (const name of new Set([...evidence.offered, ...evidence.chosen, ...evidence.called])) if (!known.has(name)) known.set(name, { name, domain: 'observed', effect: 'イベント参照', input: evidence.schemas.get(name) });
    const list = el('div', 'tool-list', null, box);
    for (const tool of [...known.values()].filter(tool => toolFilter === 'all' || evidence[toolFilter]?.has(tool.name))) {
      const label = evidence.called.has(tool.name) ? '実行' : evidence.chosen.has(tool.name) ? '選択' : evidence.offered.has(tool.name) ? '提示' : '定義';
      const button = el('button', `tool${label !== '定義' ? ' seen' : ''}`, null, list); button.type = 'button';
      el('code', '', tool.name, button); el('span', '', `${label} · ${tool.domain ?? ''}`, button);
      button.addEventListener('click', () => { selectedTool = selectedTool === tool.name ? null : tool.name; renderDetail(); });
      if (selectedTool === tool.name) { const more = el('div', 'tool-more', null, list); el('p', '', tool.description ?? '', more); el('pre', '', JSON.stringify(evidence.schemas.get(tool.name) ?? tool.input ?? null, null, 2), more); }
    }
  }

  /* ---------- Layered map (案A) ---------- */
  let map = null;
  function buildMap() {
    const svg = $('map'), model = viewModel(), layout = model.layout; svg.replaceChildren();
    const routes = routeTable(layout, model.links), blockLines = blockRoutes(layout, model.links);
    const groups = sv('g', {}, svg), blockEdges = sv('g', {}, svg), edges = sv('g', {}, svg), nodes = sv('g', {}, svg), packets = sv('g', {}, svg);
    const nodeElements = new Map(), blockElements = new Map(), counts = new Map(), times = new Map(), fieldGroups = new Map();
    for (const [id, label, process, blockRole] of model.blocks) {
      const box = layout.blocks.get(id); if (!box) continue;
      const group = sv('g', { class: 'block' }, groups); role(group, blockRole); blockElements.set(id, group);
      sv('rect', { class: 'block-box', x: box.x, y: box.y, width: box.w, height: box.h, rx: 10 }, group);
      sv('text', { class: 'block-head', x: box.x + 12, y: box.y + 19, 'font-size': Math.min(12, (box.w - 24) / [...label].reduce((sum, char) => sum + (char.charCodeAt(0) < 256 ? .58 : 1), 0)).toFixed(1) }, group).textContent = label;
      sv('text', { class: 'block-process', x: box.x + box.w - 10, y: box.y + box.h - 4, 'text-anchor': 'end' }, group).textContent = process;
      const far = sv('g', { class: 'far' }, group), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const width = text => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 256 ? .58 : 1), 0);
      sv('text', { class: 'far-title', x: cx, y: cy - 12, 'text-anchor': 'middle', 'font-size': Math.min(26, (box.w - 16) / width(label)).toFixed(1) }, far).textContent = label;
      sv('text', { class: 'far-process', x: cx, y: cy + 10, 'text-anchor': 'middle', 'font-size': Math.min(17, (box.w - 16) / width(process)).toFixed(1) }, far).textContent = process;
      const count = sv('text', { class: 'far-count', x: cx, y: cy + 32, 'text-anchor': 'middle' }, far); counts.set(id, count);
      group.addEventListener('click', () => { if (map.level === 1) zoomTo(cx, cy, Math.min(2.4, fitK(box.w + 40, box.h + 40))); });
    }
    for (const route of blockLines.values()) { const path = sv('path', { class: 'block-edge', d: routePath(route) }, blockEdges); role(path, blockSpec(model, route.from)?.[3] ?? 'own'); }
    const edgeElements = [];
    for (const route of routes.values()) { const path = sv('path', { class: `edge${route.background ? ' background' : ''}`, d: routePath(route) }, edges); edgeElements.push([route.from, route.to, path]); role(path, roleFor(model, route.from)); }
    for (const spec of model.nodes) {
      const [id] = spec, box = layout.boxes.get(id), group = sv('g', { class: 'node', tabindex: 0, role: 'button', 'aria-label': spec[4] }, nodes); role(group, roleFor(model, id));
      if (mode === 'cur' && (id === 'executive' || id === 'sqlite' || id === 'identity')) group.classList.add('static');
      sv('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 7 }, group);
      const labelSize = Math.max(8, Math.min(12.5, (box.w - 52) / textWidth(spec[4], 1)));
      sv('text', { class: 'node-label', x: box.x + 8, y: box.y + 17, 'font-size': labelSize.toFixed(1) }, group).textContent = fitText(spec[4], labelSize, box.w - 52);
      sv('text', { class: 'node-role', x: box.x + 8, y: box.y + 34 }, group).textContent = spec[5];
      const time = sv('text', { class: 'node-time', x: box.x + box.w - 7, y: box.y + 16, 'text-anchor': 'end' }, group); times.set(id, time);
      const fields = sv('g', { class: 'node-fields' }, group); fieldGroups.set(id, fields);
      nodeElements.set(id, group);
      const pick = () => { const rows = mode === 'cur' ? liveRows().rows : dummyRows().rows; const latest = [...rows].reverse().find(row => row.view === id && !row.future); select(latest?.key ?? null, id); zoomTo(box.x + box.w / 2, box.y + box.h / 2, Math.max(map.k, 3.4)); };
      group.addEventListener('click', event => { event.stopPropagation(); pick(); });
      group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } });
    }
    map = { svg, model, layout, routes, blockLines, packets, edgeElements, nodeElements, blockElements, counts, times, fieldGroups, k: 1, cx: layout.width / 2, cy: layout.height / 2, level: 0, particles: [], fieldSignature: new Map(), animation: null };
    applyView(); highlightMapSelection();
  }
  const mapSize = () => { const rect = map.svg.getBoundingClientRect(); return [rect.width || 360, rect.height || 420]; };
  /** The part of the viewport not covered by the overlay controls; fitting and centring use it. */
  const insets = () => {
    if (ui.hidden) return { t: 12, b: 12, l: 12, r: 12 };
    const tools = $('map-tools').getBoundingClientRect(), chips = $('block-chips').getBoundingClientRect(), [, height] = mapSize();
    return { t: topPad + 8, b: Math.max(12, height - Math.min(tools.top || height, chips.top || height) + 8), l: 12, r: 12 };
  };
  const inner = () => { const [width, height] = mapSize(), edge = insets(); return { width, height, edge, w: Math.max(80, width - edge.l - edge.r), h: Math.max(80, height - edge.t - edge.b) }; };
  const baseScale = () => { const area = inner(); return Math.min(area.w / map.layout.width, area.h / map.layout.height); };
  const fitK = (width, height) => { const area = inner(); return Math.min(area.w / width, area.h / height) / baseScale(); };
  const viewOrigin = (scale, area = inner()) => [map.cx - (area.edge.l + area.w / 2) / scale, map.cy - (area.edge.t + area.h / 2) / scale];
  function applyView() {
    if (!map) return;
    const area = inner(), scale = baseScale() * map.k;
    map.cx = Math.max(0, Math.min(map.layout.width, map.cx)); map.cy = Math.max(0, Math.min(map.layout.height, map.cy));
    const [x, y] = viewOrigin(scale, area);
    map.svg.setAttribute('viewBox', `${x} ${y} ${area.width / scale} ${area.height / scale}`);
    const level = detailLevel(ui.level, map.k);
    if (level !== map.level) { map.level = level; map.svg.dataset.level = String(level); }
    for (const button of document.querySelectorAll('#zoom-levels button')) { const value = button.dataset.level === 'auto' ? null : Number(button.dataset.level); button.setAttribute('aria-current', String(value === ui.level)); button.classList.toggle('effective', value === level && ui.level === null); }
  }
  function zoomTo(cx, cy, k) {
    if (!map) return; k = Math.max(1, Math.min(5, k));
    if (reduceMotion.matches) { Object.assign(map, { k, cx, cy }); applyView(); return; }
    const from = { k: map.k, cx: map.cx, cy: map.cy }, started = performance.now();
    map.animation = now => { const t = Math.min(1, (now - started) / 360), e = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      Object.assign(map, { k: from.k + (k - from.k) * e, cx: from.cx + (cx - from.cx) * e, cy: from.cy + (cy - from.cy) * e }); applyView(); if (t >= 1) map.animation = null; };
    requestFrame();
  }
  function highlightMapSelection() { if (!map) return; for (const [id, group] of map.nodeElements) group.classList.toggle('selected', id === selectedView); }
  function renderMap(rows) {
    if (!map || view !== 'map') return;
    const active = new Map(), latest = new Map();
    for (const row of rows) { if (row.future) continue; latest.set(row.view, row); if (row.state === 'running') active.set(row.view, (active.get(row.view) ?? 0) + 1); }
    const blockActive = new Map();
    for (const [id, group] of map.nodeElements) {
      const row = latest.get(id), status = active.has(id) ? 'running' : row?.state ?? 'unobserved';
      if (group.dataset.state !== status) group.dataset.state = status;
      group.classList.toggle('dim', Boolean(focusBlock) && blockOf(map.model, id) !== focusBlock);
      const text = active.has(id) ? `処理中${active.get(id) > 1 ? ` ×${active.get(id)}` : ''}` : row ? row.duration === null ? '未計測' : ms(row.full ?? row.duration) : '';
      const time = map.times.get(id); if (time.textContent !== text) time.textContent = text;
      if (active.has(id)) { const block = blockOf(map.model, id); blockActive.set(block, (blockActive.get(block) ?? 0) + 1); }
      const fields = map.fieldGroups.get(id), signature = row ? `${row.key}:${row.state}` : '';
      if (map.fieldSignature.get(id) !== signature) {
        map.fieldSignature.set(id, signature); fields.replaceChildren();
        const box = map.layout.boxes.get(id), parts = row ? (row.dummy ? dummyFieldsOf(row) : { input: fieldRows(row.span?.input), output: row.span?.endedAt ? fieldRows(row.span.output) : [] }) : { input: [], output: [] };
        for (const item of ioRows(box, parts.input, parts.output)) {
          if (item.mark) sv('text', { class: 'io-mark', x: box.x + 8, y: item.y }, fields).textContent = item.mark;
          const line = sv('text', { class: 'field', x: box.x + 17, y: item.y }, fields); sv('tspan', { class: 'field-key' }, line).textContent = `${item.name} `; sv('tspan', {}, line).textContent = item.value;
        }
        if (!row) sv('text', { class: 'field field-key', x: box.x + 8, y: box.y + 32 }, fields).textContent = mode === 'cur' && map.model.index.get(id)?.[6]?.length === 0 ? '観察イベントなし' : 'この一回では未観測';
      }
    }
    // Faded wiring; the selected box and the boxes now running keep their routes emphasised.
    const hot = new Set([...active.keys(), ...(selectedView ? [selectedView] : [])]);
    for (const [from, to, path] of map.edgeElements) path.classList.toggle('hot', hot.has(from) || hot.has(to));
    for (const [id, count] of map.counts) {
      const value = blockActive.get(id) ?? 0, nodes = map.model.nodes.filter(spec => spec[1] === id).length, text = value ? `● 処理中 ${value}` : `${nodes} 処理`;
      if (count.textContent !== text) count.textContent = text;
      map.blockElements.get(id)?.classList.toggle('active', value > 0);
      map.blockElements.get(id)?.classList.toggle('dim', Boolean(focusBlock) && focusBlock !== id);
    }
  }
  /** A moving dot depicts the receipt of an explicit handoff (or a dummy start); never transport speed. */
  function packet(from, to) {
    if (!map || view !== 'map' || reduceMotion.matches || document.hidden || map.particles.length >= 24) return;
    const a = map.layout.boxes.get(from), b = map.layout.boxes.get(to);
    if (!a || !b || from === to) return;
    map.particles.push({ from, to, started: performance.now(), route: map.routes.get(`${from}>${to}`) ?? { kind: 'curve', points: edgeCurve(a, b) } });
    requestFrame();
  }
  function glow(id) {
    const group = map?.nodeElements.get(id); if (!group) return;
    group.classList.remove('receipt'); void group.getBoundingClientRect(); group.classList.add('receipt');
    clearTimeout(group.receiptTimer); group.receiptTimer = setTimeout(() => group.classList.remove('receipt'), 3000);
  }
  function drawPackets(now) {
    if (!map) return false;
    map.packets.replaceChildren();
    map.particles = map.particles.filter(item => now - item.started < 650);
    for (const item of map.particles) {
      const t = (now - item.started) / 650, a = map.layout.boxes.get(item.from), b = map.layout.boxes.get(item.to);
      let route = item.route, radius = 4.5;
      if (map.level === 1) { if (a.block === b.block) continue; route = map.blockLines.get(`${a.block}>${b.block}`); if (!route) continue; radius = 7; }
      const [x, y] = routePoint(route, t), dot = sv('circle', { class: 'packet', cx: x, cy: y, r: radius }, map.packets); role(dot, roleFor(map.model, item.from));
    }
    return map.particles.length > 0;
  }

  /* ---------- One animation frame owner ---------- */
  let frameRequested = false;
  function requestFrame() { if (!frameRequested) { frameRequested = true; requestAnimationFrame(frame); } }
  function frame(now) {
    frameRequested = false;
    let again = false;
    if (map?.animation) { map.animation(now); again = true; }
    if (mode === 'tgt' && target.playing && !document.hidden) { advanceTarget(now); again = true; }
    if (drawPackets(now)) again = true;
    if (again) requestFrame();
  }
  let lastTargetRender = 0;
  function advanceTarget(now) {
    const delta = target.last ? Math.min(100, now - target.last) : 0; target.last = now;
    const run = TARGET_RUNS[target.run], total = Math.max(...run.spans.map(([, start, duration]) => start + duration)) + 200, speed = Math.max(.28, total / 9000);
    if (target.hold > 0) { target.hold -= delta; if (target.hold <= 0) { target.run = (target.run + 1) % TARGET_RUNS.length; target.t = 0; target.seen = new Set(); selectedKey = null; renderTargetRuns(); } return; }
    const before = target.t; target.t = Math.min(total, target.t + delta * speed);
    for (const [id, start] of run.spans) if (start > before && start <= target.t || before === 0 && start === 0 && !target.seen.has(id)) {
      for (const [from, to] of TARGET_LINKS) if (to === id && target.seen.has(from)) packet(from, to);
      target.seen.add(id); glow(id);
    }
    if (target.t >= total) target.hold = 1400;
    if (now - lastTargetRender > 90) { lastTargetRender = now; const rows = renderTimeline(); renderMap(rows); if (selectedKey?.startsWith('dummy/')) renderDetail(); }
  }
  function renderTargetRuns() {
    const host = $('target-runs'); host.replaceChildren();
    TARGET_RUNS.forEach((run, index) => { const button = el('button', 'chip', run.name, host); button.type = 'button'; button.setAttribute('aria-pressed', String(index === target.run));
      button.addEventListener('click', () => { target.run = index; target.t = 0; target.hold = 0; target.seen = new Set(); selectedKey = null; renderTargetRuns(); render(); }); });
    $('target-play').textContent = target.playing ? '一時停止' : '再生';
  }

  /* ---------- Runs, tasks, failures ---------- */
  let runSignature = '', taskSignature = '';
  function renderRuns() {
    const runs = [...state.runs.values()].sort((a, b) => b.firstSequence - a.firstSequence);
    const signature = runs.map(run => `${run.id}:${run.state}`).join('|') + state.selectedRunId + state.transport;
    if (signature === runSignature) return;
    runSignature = signature;
    const picker = $('run-picker'); picker.replaceChildren();
    if (!runs.length) picker.append(new Option('イベント待ち', ''));
    for (const run of runs) {
      const rootSpan = run.rootSpanId ? run.spans.get(run.rootSpanId) : null, surface = record(rootSpan?.input) && typeof rootSpan.input.surface === 'string' ? rootSpan.input.surface : '—';
      const mark = run.state === 'failed' ? '!' : run.endedAt ? '✓' : state.transport === 'live' && !run.incomplete ? '●' : '?';
      picker.append(new Option(`${mark} ${timeValue(run.startedAt ?? run.events[0]?.at)} · ${surface} · ${run.spans.size} 処理`, run.id));
    }
    picker.value = state.selectedRunId ?? ''; picker.disabled = !runs.length;
    const failures = runs.flatMap(run => [...run.spans.values()].filter(span => span.state === 'failed'));
    $('failure-jump').hidden = !failures.length; $('failure-jump').textContent = `失敗 ${failures.length}`;
  }
  function renderTasks() {
    const tasks = observedTasks(state);
    if (selectedTask && !tasks.some(task => task.id === selectedTask)) { selectedTask = null; selectedStep = null; }
    $('task-count').textContent = String(tasks.length);
    $('task-empty').hidden = tasks.length > 0; $('clear-task').disabled = !selectedTask;
    const signature = JSON.stringify([tasks.map(task => [task.id, task.parentId, task.lastSequence, task.phase]), selectedTask, selectedStep, state.transport]);
    if (signature === taskSignature) return;
    taskSignature = signature;
    const tree = $('task-tree'); tree.replaceChildren();
    for (const task of tasks) {
      const item = el('li', '', null, tree), button = el('button', 'task', null, item); button.type = 'button'; item.style.setProperty('--depth', String(Math.min(task.depth, 8)));
      button.setAttribute('aria-pressed', String(task.id === selectedTask));
      const active = task.spans.filter(span => spanState(span, state.runs.get(span.runId), state.transport) === 'running').length;
      const failed = task.spans.filter(span => span.state === 'failed').length;
      el('code', '', `${task.depth ? '↳ ' : ''}${task.id}`, button);
      el('span', 'hint', `${task.phase ? `phase ${task.phase}` : 'phase 未観測'} · ${task.stepIds.size} step · ${task.runIds.size} run${active ? ` · 処理中 ${active}` : ''}${failed ? ` · 失敗 ${failed}` : ''}${task.orphan ? ' · 親は保持範囲外' : ''}${task.cycle || task.parentConflict ? ' · 親の相関が不明' : ''}`, button);
      if (failed) button.classList.add('has-failure');
      button.addEventListener('click', () => { selectedTask = task.id; selectedStep = null; selectedKey = null; selectedView = null; $('follow-runs').checked = false; render(); });
    }
    const picker = $('step-picker'), selected = tasks.find(task => task.id === selectedTask); picker.replaceChildren(new Option('task 内の全 step', '')); picker.disabled = !selected;
    for (const id of selected?.stepIds ?? []) picker.append(new Option(id, id)); picker.value = selectedStep ?? '';
  }
  let metricSignature = '';
  function renderMetrics() {
    if ($('metrics').hidden) return;
    const spans = $('metric-scope').value === 'window' ? [...state.runs.values()].flatMap(run => [...run.spans.values()]) : [...(currentRun()?.spans.values() ?? [])].filter(span => !span.linked);
    const signature = JSON.stringify([state.cursor, state.selectedRunId, selectedTask, selectedStep, $('metric-scope').value, spans.length]);
    if (signature === metricSignature) return; metricSignature = signature;
    const effective = effectiveObservedSpans(state, spans), summary = timingSummary(effective), body = $('metric-rows'); body.replaceChildren();
    $('metric-summary').textContent = `完了の実測 n=${summary.n} / ${summary.total} 処理 · ${state.events.length}/${MAX_EVENTS} イベント保持 · 並列は合計しません`;
    const value = number => number === null ? '—' : `${number.toFixed(1)} ms`;
    for (const group of timingGroups(effective)) {
      const line = el('tr', '', null, body), name = el('td', '', null, line);
      const id = viewNodeOf(group.node, group.spans[0]?.input, group.spans[0]?.output);
      el('strong', '', id ? labelFor({ index: VIEW_INDEX }, id) : group.node, name); el('small', '', ` ${group.model ?? ''} / ${group.origin}`, name);
      for (const cell of [`${group.n} / ${group.total}`, value(group.median), value(group.p95), `${group.failed} / ${group.running} / ${group.unknown}`]) el('td', 'num', cell, line);
      if (group.node === 'llm') { const stream = streamTimingSummary(group.spans); el('td', 'num', stream.firstVisible.n ? value(stream.firstVisible.median) : '—', line); } else el('td', 'num', '—', line);
    }
  }

  /* ---------- Overlay controls ---------- */
  function setDrawer(open) { drawerOpen = open; $('drawer').hidden = !open; root.dataset.drawer = open ? 'open' : 'closed'; highlightMapSelection(); }
  function measureTop() {
    const bar = $('topbar').getBoundingClientRect(), next = ui.hidden || !bar.height ? 12 : Math.round(bar.bottom);
    if (next === topPad) return; topPad = next; document.documentElement.style.setProperty('--top-pad', `${topPad}px`); applyView();
  }
  function setUi(hidden) {
    ui.hidden = hidden; writeUi(ui); root.dataset.ui = hidden ? 'hidden' : 'shown';
    if (!hidden) requestAnimationFrame(measureTop);
    if (map && map.k <= 1.01) Object.assign(map, { cx: map.layout.width / 2, cy: map.layout.height / 2 });
    applyView(); (hidden ? $('ui-show') : $('ui-hide')).focus({ preventScroll: true });
  }
  function togglePanel(name) { panels[name] = !panels[name]; if (panels[name]) { for (const other of Object.keys(panels)) if (other !== name) panels[other] = false; } metricSignature = ''; render(); }

  /* ---------- Render and modes ---------- */
  function render() {
    root.dataset.mode = mode; root.dataset.view = view;
    $('live-controls').hidden = mode !== 'cur'; $('target-controls').hidden = mode !== 'tgt';
    $('tasks').hidden = mode !== 'cur' || !panels.tasks; $('metrics').hidden = mode !== 'cur' || !panels.metrics;
    $('tasks-toggle').setAttribute('aria-expanded', String(!$('tasks').hidden)); $('metrics-toggle').setAttribute('aria-expanded', String(!$('metrics').hidden));
    $('timeline-view').hidden = view !== 'timeline'; $('map-view').hidden = view !== 'map'; $('map-tools').hidden = view !== 'map'; $('map-hint').hidden = ui.hint;
    $('drawer').hidden = !drawerOpen; root.dataset.drawer = drawerOpen ? 'open' : 'closed'; root.dataset.ui = ui.hidden ? 'hidden' : 'shown';
    for (const button of document.querySelectorAll('#mode-seg button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    for (const button of document.querySelectorAll('#view-seg button')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
    if (mode === 'cur') { renderTasks(); renderRuns(); renderMetrics(); }
    renderBlockChips();
    const rows = renderTimeline(); renderMap(rows); renderDetail();
    $('notice').textContent = state.notice; $('notice').hidden = !state.notice || mode !== 'cur';
  }
  let chipSignature = '';
  function renderBlockChips() {
    const model = viewModel(), signature = `${mode}:${focusBlock}`; if (signature === chipSignature) return; chipSignature = signature;
    const host = $('block-chips'); host.replaceChildren();
    for (const [id, label, , blockRole] of model.blocks) { const chip = el('button', 'chip block-chip', label, host); chip.type = 'button'; role(chip, blockRole); chip.setAttribute('aria-pressed', String(focusBlock === id)); chip.addEventListener('click', () => setFocus(focusBlock === id ? null : id)); }
  }
  function setFocus(id) {
    focusBlock = id; chipSignature = ''; timelineSignature = '';
    if (map && view === 'map') { const box = map.layout.blocks.get(id); if (box) zoomTo(box.x + box.w / 2, box.y + box.h / 2, Math.min(2.4, fitK(box.w + 40, box.h + 40))); else zoomTo(map.layout.width / 2, map.layout.height / 2, 1); }
    render();
  }
  function setMode(next) {
    if (next === mode) return;
    mode = next; selectedKey = null; selectedView = null; focusBlock = null; timelineSignature = ''; chipSignature = ''; map = null;
    if (mode === 'tgt') { target.t = 0; target.hold = 0; target.seen = new Set(); target.last = 0; renderTargetRuns(); requestFrame(); }
    if (view === 'map') buildMap();
    render();
  }
  function setView(next) { if (next === view) return; view = next; timelineSignature = ''; render(); if (view === 'map') { buildMap(); render(); } }

  function clearPrivateView() {
    state = createObserverState(); catalog = null; priorCatalog = null; selectedKey = null; selectedView = null; selectedTask = null; selectedStep = null;
    runSignature = ''; taskSignature = ''; timelineSignature = ''; metricSignature = ''; viewRuns = null; linkedView = undefined;
    elapsedClock.clear(); if (clockTimer !== null) clearTimeout(clockTimer); clockTimer = null;
    if (map) { map.particles = []; map.packets.replaceChildren(); map.fieldSignature = new Map(); }
    $('pair-code').value = ''; $('pair-token').value = ''; drawerOpen = false;
    render();
  }
  function tick() {
    clockTimer = null;
    if (document.hidden || state.transport !== 'live' || mode !== 'cur') return;
    const rows = renderTimeline(); renderMap(rows);
    if (effectiveObservedSpans(state, [...state.runs.values()].flatMap(run => [...run.spans.values()])).some(span => span.state === 'running')) clockTimer = setTimeout(tick, 250);
  }
  function eventInView(event) { return selectedTask ? event.taskId === selectedTask && (!selectedStep || event.stepId === selectedStep) : event.runId === state.selectedRunId; }

  const client = createObserverClient({
    basePath: observerBasePath(window.location.pathname), fetch: window.fetch.bind(window), desktopBridge,
    getCursor: () => state.cursor,
    onReset: reason => { clearPrivateView(); $('connect-error').textContent = reason; $('connect-error').hidden = !reason; if (desktopBridge && reason) state.notice = reason; },
    onCatalog: value => { if (priorCatalog === value) return; catalog = value; priorCatalog = value; renderDetail(); },
    onCredential: credential => {
      if (desktopBridge) return;
      const saved = session.write(credential);
      $('pair-hint').textContent = saved ? '同じタブでは再読み込みしても接続を維持します。「接続を切る」で保存した接続情報を消します。' : 'このブラウザでは接続情報を保存できません。再読み込み後は再接続が必要です。';
    },
    onEnvelope: (envelope, delivery) => {
      const previous = state, seen = new Set(previous.events.map(event => event.sequence));
      if (previous.instanceId !== envelope.instanceId || envelope.gap || (envelope.dropped ?? 0) > previous.dropped || envelope.availability === 'held') elapsedClock.clear();
      state = reduceObserverEnvelope(previous, envelope, $('follow-runs').checked && !selectedTask);
      elapsedClock.observe(effectiveObservedSpans(state, [...state.runs.values()].flatMap(run => [...run.spans.values()])), performance.now());
      if (!clockTimer && state.transport === 'live') clockTimer = setTimeout(tick, 250);
      if (previous.transport === 'lost' && state.transport === 'live' && !envelope.gap && previous.instanceId === state.instanceId) state.notice = '接続が回復しました。受信したイベントから表示を更新しました。';
      if (envelope.availability === 'held') { selectedTask = null; selectedStep = null; selectedKey = null; selectedView = null; catalog = null; priorCatalog = null; elapsedClock.clear(); if (map) { map.particles = []; map.fieldSignature = new Map(); } }
      if (state.selectedRunId !== previous.selectedRunId || state.instanceId !== previous.instanceId || envelope.gap || state.dropped > previous.dropped) { if (selectedKey && !selectedKey.startsWith(state.selectedRunId ?? '-')) selectedKey = null; if (map) map.particles = []; }
      const changed = envelope.events.some(event => !seen.has(event.sequence)) || previous.transport !== state.transport || previous.availability !== state.availability || previous.notice !== state.notice || state.instanceId !== previous.instanceId || envelope.gap;
      if (changed) render();
      // Initial history, a gap and a server restart stay still. Only a new live receipt glows or moves.
      if (mode === 'cur' && delivery?.liveReceipts && previous.instanceId === state.instanceId && previous.transport === 'live' && !envelope.gap && state.dropped === previous.dropped) {
        for (const event of envelope.events) if (!seen.has(event.sequence) && eventInView(event)) {
          if (event.kind === 'handoff') { const [from, to] = viewHandoff(event); if (from) glow(from); if (to) glow(to); if (from && to) packet(from, to); }
          else { const id = viewNodeOf(event.node, event.input, event.output); if (id) glow(id); }
        }
      }
    },
    onConnection: connection => {
      const previous = state.transport; state = { ...state, transport: connection }; root.dataset.connection = connection;
      const labels = { disconnected: '未接続', connecting: '接続中', live: '観測中', held: '非表示（所有者だけの場で表示）', paused: '観測休止', lost: '接続を再確認中' };
      $('connection-state').textContent = labels[connection]; $('connect-panel').hidden = Boolean(desktopBridge) || !['disconnected', 'connecting'].includes(connection);
      $('disconnect').hidden = Boolean(desktopBridge) || connection === 'disconnected';
      for (const button of document.querySelectorAll('#connect-panel button')) button.disabled = connection === 'connecting';
      if (connection === 'paused') { const cursor = state.cursor, instanceId = state.instanceId; clearPrivateView(); state = { ...state, cursor, instanceId, transport: 'paused' }; }
      if (connection === 'lost') { const cursor = state.cursor, instanceId = state.instanceId; clearPrivateView(); state = { ...state, cursor, instanceId, transport: 'lost' }; state.notice = desktopBridge && $('connect-error').textContent || '接続が途切れています。処理中だった箇所の結果は未確認です。自動で接続を再確認します。'; }
      if (connection === 'live' && previous === 'lost') state.notice = '接続が回復しました。受信したイベントから表示を更新しました。';
      if (previous !== connection) { runSignature = ''; render(); }
    },
  });

  // Controls.
  for (const button of document.querySelectorAll('#mode-seg button')) button.addEventListener('click', () => setMode(button.dataset.mode));
  for (const button of document.querySelectorAll('#view-seg button')) button.addEventListener('click', () => setView(button.dataset.view));
  $('ui-hide').addEventListener('click', () => setUi(true));
  $('ui-show').addEventListener('click', () => setUi(false));
  $('drawer-close').addEventListener('click', () => setDrawer(false));
  $('tasks-toggle').addEventListener('click', () => togglePanel('tasks'));
  $('metrics-toggle').addEventListener('click', () => togglePanel('metrics'));
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => { panels[button.dataset.close] = false; render(); });
  $('map-hint-close').addEventListener('click', () => { ui.hint = true; writeUi(ui); $('map-hint').hidden = true; applyView(); });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.target.closest?.('input, select, textarea')) return;
    if (!$('connect-panel').hidden && event.key !== 'Escape') return;
    if (event.key === 'h' || event.key === 'H') { event.preventDefault(); setUi(!ui.hidden); }
    else if (event.key === 'Escape') {
      if (drawerOpen && !ui.hidden) setDrawer(false);
      else if (Object.values(panels).some(Boolean) && !ui.hidden) { for (const name of Object.keys(panels)) panels[name] = false; render(); }
      else setUi(!ui.hidden);
    }
  });
  $('target-play').addEventListener('click', () => { target.playing = !target.playing; target.last = 0; renderTargetRuns(); if (target.playing) requestFrame(); });
  // A picked level sticks across zoom, pan and resize until changed; 自動 returns to following the zoom.
  for (const button of document.querySelectorAll('#zoom-levels button')) button.addEventListener('click', () => { ui.level = button.dataset.level === 'auto' ? null : Number(button.dataset.level); writeUi(ui); if (map) map.fieldSignature = new Map(); applyView(); render(); });
  for (const button of document.querySelectorAll('[data-zoom]')) button.addEventListener('click', () => { if (!map) return; const step = Number(button.dataset.zoom); if (!step) zoomTo(map.layout.width / 2, map.layout.height / 2, 1); else zoomTo(map.cx, map.cy, map.k * (step > 0 ? 1.5 : 1 / 1.5)); });
  const svgMap = $('map'), pointers = new Map(); let pinch = null, moved = 0;
  svgMap.addEventListener('wheel', event => { if (!map) return; event.preventDefault(); const rect = svgMap.getBoundingClientRect(), scale = baseScale() * map.k, px = event.clientX - rect.left, py = event.clientY - rect.top;
    const area = inner(), [ox, oy] = viewOrigin(scale, area), wx = ox + px / scale, wy = oy + py / scale, k = Math.max(1, Math.min(5, map.k * Math.exp(-event.deltaY * .0018))), next = baseScale() * k;
    Object.assign(map, { k, cx: wx - px / next + (area.edge.l + area.w / 2) / next, cy: wy - py / next + (area.edge.t + area.h / 2) / next }); applyView(); }, { passive: false });
  svgMap.addEventListener('pointerdown', event => { pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); moved = 0; if (pointers.size === 2 && map) { const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: map.k }; } });
  svgMap.addEventListener('pointermove', event => { const point = pointers.get(event.pointerId); if (!point || !map) return; const dx = event.clientX - point.x, dy = event.clientY - point.y; point.x = event.clientX; point.y = event.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (pointers.size === 2 && pinch) { const [a, b] = [...pointers.values()]; map.k = Math.max(1, Math.min(5, pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance)); applyView(); return; }
    if (moved > 4) { if (!svgMap.hasPointerCapture(event.pointerId)) svgMap.setPointerCapture(event.pointerId); const scale = baseScale() * map.k; map.cx -= dx / scale; map.cy -= dy / scale; applyView(); } });
  const release = event => { pointers.delete(event.pointerId); if (pointers.size < 2) pinch = null; };
  svgMap.addEventListener('pointerup', release); svgMap.addEventListener('pointercancel', release);
  svgMap.addEventListener('click', event => { if (moved > 4) { event.stopPropagation(); event.preventDefault(); } }, true);
  // Fit to the viewport on load and on resize unless the owner has zoomed in.
  const refit = () => { if (!map) return; if (map.k <= 1.01) Object.assign(map, { k: 1, cx: map.layout.width / 2, cy: map.layout.height / 2 }); applyView(); };
  if (typeof ResizeObserver === 'function') { new ResizeObserver(refit).observe(svgMap); new ResizeObserver(measureTop).observe($('topbar')); } else window.addEventListener('resize', () => { measureTop(); refit(); });
  $('clear-task').addEventListener('click', () => { selectedTask = null; selectedStep = null; selectedKey = null; render(); });
  $('step-picker').addEventListener('change', () => { selectedStep = $('step-picker').value || null; selectedKey = null; render(); });
  $('metric-scope').addEventListener('change', () => { metricSignature = ''; renderMetrics(); });
  $('failure-jump').addEventListener('click', () => {
    const failed = [...state.runs.values()].flatMap(run => [...run.spans.values()].filter(span => span.state === 'failed')).sort((a, b) => b.lastSequence - a.lastSequence)[0];
    if (!failed) return;
    selectedTask = null; selectedStep = null; $('follow-runs').checked = false; state = { ...state, selectedRunId: failed.runId };
    selectedKey = spanKey(failed); selectedView = viewNodeOf(failed.node, failed.input, failed.output); render();
  });
  $('pair-form').addEventListener('submit', event => { event.preventDefault(); const code = $('pair-code').value; $('pair-code').value = ''; void client.pair(code); });
  $('token-form').addEventListener('submit', event => { event.preventDefault(); const token = $('pair-token').value; $('pair-token').value = ''; client.connect(token); });
  $('disconnect').addEventListener('click', () => client.disconnect());
  $('run-picker').addEventListener('change', () => { selectedTask = null; selectedStep = null; state = { ...state, selectedRunId: $('run-picker').value }; $('follow-runs').checked = false; selectedKey = null; selectedView = null; render(); });
  $('follow-runs').addEventListener('change', () => { if ($('follow-runs').checked) { selectedTask = null; selectedStep = null; const latest = [...state.runs.values()].sort((a, b) => b.firstSequence - a.firstSequence)[0]; state = { ...state, selectedRunId: latest?.id ?? null }; selectedKey = null; render(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) client.pause(); else { client.resume(); target.last = 0; requestFrame(); } });
  window.addEventListener('pagehide', () => client.pause());
  window.addEventListener('pageshow', event => { if (event.persisted && !document.hidden) client.resume(); });
  reduceMotion.addEventListener('change', () => { if (map) map.particles = []; });
  render(); requestAnimationFrame(measureTop);
  if (document.hidden) client.pause();
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
