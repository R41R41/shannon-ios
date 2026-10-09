// Pure, bounded projections of retained observations. No requests, clocks or private persistence.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const TASK_PHASES = new Set(['ready','executing','waiting','stopping','unknown','stopped','completed','failed']);
export const spanKey = span => `${span.runId}/${span.id}`;

/** A task relationship exists only when a producer names it. No timestamp/title inference. */
export function observedTasks(state) {
  const tasks = new Map();
  for (const run of state.runs.values()) for (const span of run.spans.values()) {
    if (!span.taskId) continue;
    let task = tasks.get(span.taskId);
    if (!task) {
      task = { id: span.taskId, parentId: null, parentConflict: false, spans: [], runIds: new Set(), stepIds: new Set(), lastSequence: 0, phase: null, phaseRevision: null, phaseSequence: 0 };
      tasks.set(task.id, task);
    }
    if (span.parentTaskId) {
      if (task.parentId && task.parentId !== span.parentTaskId) task.parentConflict = true;
      else task.parentId = span.parentTaskId;
    }
    task.spans.push(span); task.runIds.add(run.id);
    if (span.stepId) task.stepIds.add(span.stepId);
    task.lastSequence = Math.max(task.lastSequence, span.lastSequence);
  }
  // A generic createChild return belongs to the returned child, not its enclosing parent span.
  // Use the actual terminal event sequence, never a later span event carrying an older output.
  for (const event of state.events) {
    if (event.kind !== 'span.completed' || event.origin !== 'server' || !['taskHub','fca','store'].includes(event.node) || !record(event.output)) continue;
    const span = state.runs.get(event.runId)?.spans.get(event.spanId), task = tasks.get(span?.taskId);
    if (!task || span.node !== event.node || span.origin !== event.origin || !TASK_PHASES.has(event.output.phase)) continue;
    if (event.taskId !== span.taskId) continue;
    const namedTask = Object.prototype.hasOwnProperty.call(event.output,'taskId');
    if (namedTask && event.output.taskId !== span.taskId) continue;
    const checkpoint = event.node === 'taskHub' && record(span.input) && span.input.phase === 'returned_state';
    if (!namedTask && !checkpoint && event.node !== 'fca') continue;
    if (event.sequence <= task.phaseSequence) continue;
    task.phase = event.output.phase; task.phaseSequence = event.sequence;
    task.phaseRevision = Number.isSafeInteger(event.output.revision) && event.output.revision >= 0 ? event.output.revision : null;
  }
  const rows = [];
  const visit = (task, depth, lineage) => {
    if (rows.some(row => row.id === task.id)) return;
    const cycle = lineage.has(task.id);
    rows.push({ ...task, depth, orphan: !!task.parentId && !tasks.has(task.parentId), cycle });
    if (cycle) return;
    const next = new Set([...lineage, task.id]);
    for (const child of tasks.values()) if (!child.parentConflict && child.parentId === task.id) visit(child, depth + 1, next);
  };
  for (const task of tasks.values()) if (!task.parentId || !tasks.has(task.parentId) || task.parentConflict) visit(task, 0, new Set());
  for (const task of tasks.values()) if (!rows.some(row => row.id === task.id)) visit(task, 0, new Set([task.id]));
  return rows;
}

export function taskRunView(state, taskId, stepId = null) {
  const spans = new Map(), events = [];
  for (const run of state.runs.values()) {
    for (const span of run.spans.values()) if (span.taskId === taskId && (!stepId || span.stepId === stepId)) spans.set(spanKey(span), span);
    for (const event of run.events) if (event.taskId === taskId && (!stepId || event.stepId === stepId)) events.push(event);
  }
  events.sort((a,b)=>a.sequence-b.sequence);
  return { id: taskId, spans, events, startedAt: null, endedAt: null, incomplete: true, state: 'unknown', firstSequence: events[0]?.sequence ?? 0, lastSequence: events.at(-1)?.sequence ?? 0 };
}

export function timingSummary(spans) {
  const unique = [...new Map([...spans].map(span => [spanKey(span), span])).values()];
  const samples = unique.filter(span => span.state === 'completed' && count(span.elapsedMs) !== null);
  const values = samples.map(span => span.elapsedMs).sort((a, b) => a - b);
  const n = values.length, mid = Math.floor(n / 2);
  const cache = { readTokens: 0, writeTokens: 0, readN: 0, writeN: 0, providerN: 0 };
  for (const span of unique) {
    if (span.node !== 'llm' || !span.endedAt) continue;
    cache.providerN += 1;
    const usage = record(span.output) && record(span.output.usage) ? span.output.usage : {};
    if (count(usage.cacheReadTokens) !== null) { cache.readTokens += usage.cacheReadTokens; cache.readN += 1; }
    if (count(usage.cacheCreationTokens) !== null) { cache.writeTokens += usage.cacheCreationTokens; cache.writeN += 1; }
  }
  return { total: unique.length, n, median: n ? n % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2 : null,
    p95: n ? values[Math.ceil(n * .95) - 1] : null,
    running: unique.filter(span => span.state === 'running').length,
    failed: unique.filter(span => span.state === 'failed' || span.state === 'cancelled').length,
    unknown: unique.filter(span => span.state === 'unknown').length,
    unmeasured: unique.filter(span => span.state === 'completed' && count(span.elapsedMs) === null).length,
    cache };
}

/** Milestones are relative to a real streamed provider call; absence is never zero. */
export function streamTimingSummary(spans) {
  const completed=[...new Map([...spans].map(span=>[spanKey(span),span])).values()]
    .filter(span=>span.node==='llm'&&span.state==='completed'&&span.endedAt);
  const summary=field=>{
    const values=completed.map(span=>record(span.output)?count(span.output[field]):null)
      .filter(value=>value!==null).sort((a,b)=>a-b);
    const n=values.length,mid=Math.floor(n/2);
    return {n,median:n?n%2?values[mid]:(values[mid-1]+values[mid])/2:null,p95:n?values[Math.ceil(n*.95)-1]:null};
  };
  return {completedRequests:completed.length,firstVisible:summary('firstVisibleOutputAfterMs'),finalUsage:summary('finalUsageAfterMs')};
}

/** Compare like processors/models/origins; never call a parallel span sum wall time. */
export function timingGroups(spans) {
  const groups = new Map();
  for (const span of spans) {
    const key = JSON.stringify([span.node, span.model ?? '', span.origin ?? 'unknown']);
    if (!groups.has(key)) groups.set(key, { node: span.node, model: span.model ?? null, origin: span.origin ?? 'unknown', spans: [] });
    groups.get(key).spans.push(span);
  }
  return [...groups.values()].map(group => ({ ...group, ...timingSummary(group.spans) }));
}

/** Separate clock domains. Bar positions are timestamps, widths are recorded durations. */
export function timelineRows(spans) {
  const unique = [...new Map([...spans].map(span => [spanKey(span), span])).values()];
  const bases = new Map();
  for (const span of unique) if (span.startedAt) {
    const origin = span.origin ?? 'unknown', at = Date.parse(span.startedAt);
    bases.set(origin, Math.min(bases.get(origin) ?? at, at));
  }
  return unique.sort((a, b) => a.firstSequence - b.firstSequence).map(span => ({ span,
    offsetMs: span.startedAt ? Math.max(0, Date.parse(span.startedAt) - bases.get(span.origin ?? 'unknown')) : null,
    durationMs: span.endedAt ? count(span.elapsedMs) : null,
    provenance: span.endedAt && count(span.elapsedMs) !== null ? 'observed' : span.endedAt ? 'unmeasured' : 'open' }));
}

/** Browser time is a lower bound since receipt, not provider/transport elapsed time. */
export function createElapsedClock() {
  const arrivals = new Map();
  return {
    clear() { arrivals.clear(); },
    observe(spans, now) {
      const active = new Set();
      for (const span of spans) if (span.state === 'running' && span.startedAt && !span.endedAt) {
        const key = spanKey(span); active.add(key); if (!arrivals.has(key)) arrivals.set(key, now);
      }
      for (const key of arrivals.keys()) if (!active.has(key)) arrivals.delete(key);
    },
    elapsed(span, now) { const start = span && arrivals.get(spanKey(span)); return start === undefined ? null : Math.max(0, now - start); },
  };
}
