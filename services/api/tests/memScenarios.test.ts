import { afterEach, describe, expect, it } from 'vitest';
import { memoryKernel } from './support/memoryKernel.js';

/**
 * The `mem.*` scenarios of Syzygy ADR-0008 stage 3 (memory through the one writer), through the API kernel on SQLite with the
 * memory outbox on and an in-process writer that runs only when the scenario says so:
 * - `mem.cas-forget`: what a turn taught is proposed; the owner forgets the turn before the writer runs; nothing of it is written,
 *   the op is superseded as `forgotten`, and the cursor moves past it. A turn he did not forget is learned.
 */
const kernels: Array<ReturnType<typeof memoryKernel>> = [];
const kernel = () => { const created = memoryKernel(); kernels.push(created); return created; };
afterEach(() => { for (const created of kernels.splice(0)) created.close(); });

describe('mem.cas-forget', () => {
  it('writes nothing of a turn the owner forgot before the writer ran, and learns the turn he kept', async () => {
    const k = kernel();
    const forgotten = await k.chat('私は紅茶が好き');
    const proposed = k.outbox.rows({ status: 'pending' });
    expect(proposed.map(row => row.kind)).toContain('fact.upsert');
    expect(proposed.every(row => JSON.parse(row.episodeIdsJson).includes(forgotten))).toBe(true);
    // Nothing is learned until the writer runs.
    expect(k.store.snapshot('owner').userFacts).toHaveLength(0);

    const forget = await k.api.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: forgotten, action: 'forget' } });
    expect(forget.status).toBe(200);
    await k.writer.drain();
    expect(k.store.snapshot('owner').userFacts).toHaveLength(0);
    const ended = k.outbox.rows();
    expect(ended.filter(row => row.kind === 'fact.upsert').every(row => row.status === 'superseded' && row.outcomeCode === 'forgotten')).toBe(true);
    expect(ended.every(row => row.status !== 'pending')).toBe(true);
    expect(k.outbox.appliedSeq()).toBe(Math.max(...ended.map(row => row.seq)));

    // A turn he kept is learned through the same writer.
    await k.chat('私は猫が好き');
    await k.writer.drain();
    expect(k.store.snapshot('owner').userFacts.map(fact => fact.statement).join()).toContain('猫');
  });
});
