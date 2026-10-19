/* Exploratory: cost of one full provenance walk on the production-dense remembered-turn graph (not a test). */
import { fcaDenseWorld } from '../support/fcaDenseWorld.js';
import { printProfile, startCpuProfile } from '../support/perfMeasure.js';
import { createFcaSourceGuard } from '../../src/mind/action/fca/fcaConversationPorts.js';
import { MemoryWithholding } from '../../src/mind/memory/memoryVisibility.js';

const counts: Record<string, number> = {};
if (process.env.COUNT) {
  for (const name of ['withholdsReply', 'withholdsExperience', 'recalledWithheldWithin', 'provenanceWithheld', 'sourceVisible', 'experience', 'unavailableReadWithin']) {
    const proto = MemoryWithholding.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = proto[name]!;
    proto[name] = function (this: unknown, ...args: unknown[]) { counts[name] = (counts[name] ?? 0) + 1; return original.apply(this, args); };
  }
}

const world = fcaDenseWorld();
const root = world.runtime.ensureRoot('owner');
const task = world.runtime.createChild('owner', root.id, { title: 'bench', goal: 'bench goal', completionCriteria: 'x', kind: 'generic' }, 'bench');
const steps = Number(process.env.STEPS ?? 100), pool = Number(process.env.POOL ?? 190), repeats = Number(process.env.REPEATS ?? 7);
const rows = world.provenance(steps, pool);
const now = () => performance.now();
for (const count of [10, 50, steps].filter((value, index, all) => value <= steps && all.indexOf(value) === index)) {
  const sub = rows.slice(0, count), distinct = new Set(sub.flatMap(row => row.recalledMemoryIds)).size, times: number[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    // A fresh guard each time: nothing reused, so this is one full walk.
    const guard = createFcaSourceGuard({ runtime: world.runtime, state: world.world.store, conversations: world.world.store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: world.readSourceVisible, log: () => {} });
    const stop = process.env.PROFILE && repeat === repeats - 1 && count === steps ? await startCpuProfile() : null;
    for (const key of Object.keys(counts)) counts[key] = 0;
    const started = now(); const visible = guard.sources('owner', task, sub); times.push(now() - started);
    if (!visible) throw new Error('not visible');
    if (stop) printProfile('full walk', await stop(), 30);
  }
  times.sort((a, b) => a - b);
  console.log(`full walk rows=${count} distinctIds=${distinct} min=${times[0]!.toFixed(0)}ms median=${times[Math.floor(times.length / 2)]!.toFixed(0)}ms`, process.env.COUNT ? JSON.stringify(counts) : '');
}
await world.close();
