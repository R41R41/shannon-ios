// Timings on the run 6 production shape (`run6RecallShape.ts`): `node --import tsx tests/support/run6Profile.ts`.
import { prepareTurnCognitiveContext } from '../../src/mind/workspace/turnCognitiveContext.js';
import { run6RecallShape } from './run6RecallShape.js';

const f = run6RecallShape();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const time = (work: () => unknown) => { const at = performance.now(); work(); return performance.now() - at; };
const turn = (channel: 'text' | 'voice') => () => prepareTurnCognitiveContext(f.world.store.snapshot('owner'), f.world.store, {
  scopeKey: 'owner', message: '調べもの12の結果を覚えてる？', occurredAt: f.world.now(), channel, present: f.present, threadId: 'thread-1' });
const results: Record<string, number[]> = {};
const add = (name: string, ms: number) => { (results[name] ??= []).push(ms); };
const warn = console.warn; console.warn = () => {};
for (let round = 0; round < 7; round++) {
  add('text turn', time(turn('text')));
  add('voice turn', time(turn('voice')));
  for (const [name, cue] of [['FCA start (run 6 cue)', 'エンドラを討伐してください'], ['FCA start (matching cue)', '調べもの12の結果']] as const) {
    const input = { scopeKey: 'owner', taskId: `${name}-${round}`, contextVersion: `v${round}`, cue, present: f.present, semantic: false };
    add(name, time(() => f.recall.start(input)));
    const at = performance.now(); await f.recall.packet(input); add(name.replace('start', 'packet'), performance.now() - at);
  }
}
console.warn = warn;
for (const [name, values] of Object.entries(results)) console.log(`${name.padEnd(28)} first ${Math.round(values[0]!)} ms, median ${Math.round(median(values.slice(1)))} ms`);
f.close();
