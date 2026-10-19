import { Session } from 'node:inspector/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

/**
 * Measurement helpers for the loop-stall bench (`tests/perf`, `fcaLoopStall.test.ts`): how long the API's one thread was held
 * (event-loop delay and the lateness of a 10 ms timer) and where (a CPU profile of a region, summarized by function).
 */
export interface LoopReport {
  wallMs: number; maxMs: number; p99Ms: number; meanMs: number;
  /** Sum of the timer's lateness beyond `thresholdMs`, as `event loop blocked` would name it (a timer of 10 ms). */
  blockedMs: number; blockedFraction: number; stalls: number; longest: number[];
  /** Each stall: when it ended (performance.now) and how late the timer was. */
  events: Array<{ at: number; late: number }>;
}

/** A 10 ms timer's lateness plus the runtime's own delay histogram, for as long as the monitor runs. */
export function monitorLoop(options: { thresholdMs?: number; intervalMs?: number } = {}) {
  const interval = options.intervalMs ?? 10, threshold = options.thresholdMs ?? 50;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const started = performance.now();
  let expected = started + interval, blocked = 0, stalls = 0, max = 0;
  const late: number[] = [], events: Array<{ at: number; late: number }> = [];
  const timer = setInterval(() => {
    const at = performance.now(), lateness = at - expected;
    expected = at + interval;
    if (lateness >= threshold) { blocked += lateness; stalls += 1; late.push(Math.round(lateness)); events.push({ at, late: lateness }); }
    if (lateness > max) max = lateness;
  }, interval);
  return {
    stop(): LoopReport {
      clearInterval(timer);
      histogram.disable();
      const wallMs = performance.now() - started;
      return { wallMs, maxMs: Math.max(max, histogram.max / 1e6), p99Ms: histogram.percentile(99) / 1e6, meanMs: histogram.mean / 1e6,
        blockedMs: blocked, blockedFraction: blocked / wallMs, stalls, longest: late.sort((a, b) => b - a).slice(0, 10), events };
    },
  };
}

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
export interface CpuProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

/** Starts a V8 CPU profile (sampling every 200 microseconds); the returned function stops it and gives the profile. */
export async function startCpuProfile(): Promise<() => Promise<CpuProfile>> {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 200 });
  await session.post('Profiler.start');
  return async () => {
    const { profile } = await session.post('Profiler.stop') as { profile: CpuProfile };
    session.disconnect();
    return profile;
  };
}

/** Self and inclusive time by function (name and file), in milliseconds, largest first. */
export function summarizeProfile(profile: CpuProfile, top = 25, filter = '') {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const key = (node: ProfileNode) => `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.replace(/^.*\/services\/api\//u, '').replace(/^file:\/\//u, '')}:${node.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>(), inclusive = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, index) => {
    const time = profile.timeDeltas[index] ?? 0; total += time;
    const node = byId.get(id)!; self.set(key(node), (self.get(key(node)) ?? 0) + time);
    const seen = new Set<string>();
    for (let current: number | undefined = id; current !== undefined; current = parent.get(current)) {
      const name = key(byId.get(current)!);
      if (seen.has(name)) continue;
      seen.add(name); inclusive.set(name, (inclusive.get(name) ?? 0) + time);
    }
  });
  const rows = (map: Map<string, number>) => [...map].filter(([name]) => name.includes(filter)).sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([name, time]) => ({ name, ms: Math.round(time / 1000), percent: Math.round(1000 * time / total) / 10 }));
  return { totalMs: Math.round(total / 1000), self: rows(self), inclusive: rows(inclusive) };
}

export function printProfile(title: string, profile: CpuProfile, top = 25, filter = ''): void {
  const summary = summarizeProfile(profile, top, filter);
  console.log(`--- ${title}: ${summary.totalMs} ms sampled`);
  console.log('  self:'); for (const row of summary.self) console.log(`  ${String(row.ms).padStart(7)} ms ${String(row.percent).padStart(5)}%  ${row.name}`);
  console.log('  inclusive:'); for (const row of summary.inclusive) console.log(`  ${String(row.ms).padStart(7)} ms ${String(row.percent).padStart(5)}%  ${row.name}`);
}

export function saveProfile(path: string, profile: CpuProfile): void { writeFileSync(path, JSON.stringify(profile)); }
