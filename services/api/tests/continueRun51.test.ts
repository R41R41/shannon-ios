import { afterEach, describe, expect, it } from 'vitest';
import { benchC, until, type BenchC } from './helpers/benchC.js';
import { noteRedecide as noteRedecideRow } from '../src/infra/decisionRecords/decisionRecordNotes.js';
import { setIncidentHoldPort } from '../src/wiring/minecraftIncidentHold.js';
import { forgetStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { createLlmcEvents, llmcTransient } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { foodLeads } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

const benches: BenchC[] = [];
afterEach(() => { for (const bench of benches.splice(0)) bench.close(); setIncidentHoldPort(null); forgetStalls(); });
describe('run51: a pending hold is a barrier to further motor commands', () => {
  it('blocks a late model answer on every look, without waiting on its own step stop', async () => {
    let publish!: () => void, published = false;
    const publishing = new Promise<void>(r => { publish = r; });
    setIncidentHoldPort({ holdRequested: () => true, async hold() { published = true; await publishing; return true; },
      bodyHeld: async () => true, notHeld() {}, resumePending: () => null, resumeChecked() {} });
    const b = benchC({ scene: 'run51-pending', run: 'run51-pending', autoPoll: false }); benches.push(b); await b.begin();
    await b.decide('決め直し失敗', () => noteRedecideRow({ asked: true, count: 1, outcome: 'kept_first', why: 'failed', failed: 'timeout 60000' }));
    // The take is in flight; the body's next poll has not answered it yet.
    const spec = b.spec([{ do: 'wait', seconds: 1 }]);
    const late = await b.decide('保留前から待っていた判断の返答', () => b.head.queue.add(spec));
    expect(late).toMatchObject({ ok: false, text: expect.stringContaining('保留の作成・確定中') });
    const lifecycle = b.lifecycle(), signal = new AbortController().signal;
    let firstDone = false, secondDone = false;
    const first = lifecycle.beforeDecision!(signal).then(() => { firstDone = true; });
    const second = lifecycle.beforeDecision!(signal).then(() => { secondDone = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(firstDone).toBe(false); expect(secondDone).toBe(false);
    await b.spin(5);
    expect(await until(() => published)).toBe(true);
    // The hold port writes its audit and starts the stop before its first await. That stop may need this step to exit.
    await Promise.all([first, second]);
    publish();
    expect(b.body.handed.filter(c => c.kind === 'skill' && c.skill === 'act')).toHaveLength(0);
    expect(await b.head.queue.add(spec)).toMatchObject({ ok: false });
  });
});

describe('run51: facts supplied to the decision', () => {
  it('shows active minutes, excluding the hold exactly once', () => {
    const llmc = { plan: () => undefined, planView: () => null };
    const observation = { schemaVersion: 1, bodyId: 'b', sequence: 1, connected: true, stateAt: 't', receivedAt: 't', facts: {}, state: { world: { health: 20, food: 20, inventory: {} } } } as const;
    const live = llmcTransient(llmc, createLlmcEvents('clock51'), observation, 62, [], { heldMs: 54 * 60_000 }) as { state: { minutes: number } };
    expect(live.state.minutes).toBe(8);
  });
  it('includes safe fish as a visible food lead and does not claim food exists outside the scan', () => {
    expect(foodLeads({ nearbyEntities: [{ id: 7, name: 'salmon', distance: 9 }] }, 'overworld')).toContain('#7 salmon 9m');
    const unseen = foodLeads({ scan: { dimension: 'overworld', rows: [] } }, 'overworld');
    expect(unseen).toContain('走査外は未確認'); expect(unseen).toContain('地下');
  });
});
