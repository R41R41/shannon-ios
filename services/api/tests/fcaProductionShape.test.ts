import { afterEach, describe, expect, it, vi } from 'vitest';
import { fcaProductionShape, type ProductionShape } from './support/fcaProductionShape.js';
import { fcaNowProjection } from '../src/infra/http/fcaNowProjection.js';
import { FCA_PROVENANCE_LIMITS } from '../src/mind/action/fca/fcaConversationSources.js';
import { FCA_TURN_BUDGET_MS } from '../src/mind/action/fca/fcaConversation.js';

/**
 * 2026-10-12, after the first fix was deployed: a voice turn still spent 27 s of synchronous provenance checks before its model
 * call, and each research step blocked the API's one thread for seconds. On the production-shaped fixture (855 remembered turns,
 * ten skills, a voice conversation task after fourteen turns with 80 skill read receipts, six research children, 64 inbox
 * reports) origin/main took 18.3 s for one turn's context, 39 s for thirty task-tool availability checks, 2.8 s for the Now view
 * and 8.2 s for two research steps. The bounds below are generous for CI runners; locally each is well under 100 ms.
 */
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
async function built(budgetMs?: number): Promise<{ f: ProductionShape; conversation: string }> {
  const f = fcaProductionShape(budgetMs === undefined ? {} : { budgetMs }); cleanups.push(() => f.close());
  return { f, conversation: await f.build() };
}
const elapsed = (work: () => unknown) => { const started = performance.now(); work(); return performance.now() - started; };

describe('FCA provenance on production-shaped data', () => {
  it('prepares a voice turn\'s task context and tool offers within the budget, and runs research steps without long blocks', async () => {
    const { f } = await built();
    let context = '';
    await f.foreground(async () => {
      const turn = f.begin(20);
      const spent = elapsed(() => {
        turn.delegate!({ title: '新しい調べもの', goal: '公開情報を調べる新' });
        context = turn.context();
        for (let offer = 0; offer < 4; offer++) for (const _domain of ['task_runtime', 'memory_read', 'minecraft_body']) f.bridge.taskToolsAvailable('owner');
      });
      expect(spent).toBeLessThan(2_000);
      expect(context).toContain('[Task inbox');
      expect(f.bridge.taskToolsAvailable('owner')).toBe(true);
      turn.abort();
    });
    expect(elapsed(() => fcaNowProjection(f.runtime, 'owner', id => f.visible('owner', id), id => f.visible.progress?.('owner', id) ?? null))).toBeLessThan(2_000);
    const step = performance.now(); await f.driver.tick(); await f.driver.drain();
    expect(performance.now() - step).toBeLessThan(2_000);
    expect(f.steps.length).toBeGreaterThan(0);
  }, 120_000);

  it('applies a forget at once: the research that recalled it leaves the context in the same moment', async () => {
    const { f } = await built();
    const child = f.children[0]!;
    const recalled = f.runtime.taskSources('owner', child).flatMap(source => source.recalledMemoryIds);
    await f.foreground(async () => {
      const turn = f.begin(20);
      expect(turn.context()).toContain(child);
      f.world.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: recalled[0]!, kind: 'experience', status: 'forgotten',
        pinned: false, updatedAt: f.world.now(), changeReason: 'owner' } });
      expect(f.visible('owner', child)).toBe(false); // No clock moved: the new state version is judged afresh.
      expect(turn.context()).not.toContain(child);
      turn.abort();
    });
  }, 120_000);

  it('applies a skill withdrawal at once, for every task that read it', async () => {
    const { f } = await built();
    const child = f.children[0]!;
    expect(f.visible('owner', child)).toBe(true);
    const read = f.runtime.taskSources('owner', child).flatMap(source => source.readSourceIds ?? [])[0]!;
    const skillId = decodeURIComponent(/^shannon-skill:\/\/([^/]+)\//u.exec(read)![1]!);
    expect(f.memory.retire('owner', skillId, 'owner_request', f.world.now())).toBe(true);
    expect(f.visible('owner', child)).toBe(false); // Within the verdict's window: the receipt is asked again.
  }, 120_000);

  it('still asks who can hear on every check', async () => {
    const { f } = await built();
    const child = f.children[0]!;
    expect(f.visible('owner', child)).toBe(true);
    f.setAlone(false); expect(f.visible('owner', child)).toBe(false);
    f.setAlone(true); expect(f.visible('owner', child)).toBe(true);
  }, 120_000);
});

describe('limits', () => {
  it('closes a turn\'s task context and tools once its provenance checks spend the budget, logged once', async () => {
    const { f } = await built(FCA_TURN_BUDGET_MS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += FCA_TURN_BUDGET_MS)); // Every check looks slow.
    await f.foreground(async () => {
      const turn = f.begin(20);
      expect(turn.context()).toBe('');
      expect(f.bridge.taskToolsAvailable('owner')).toBe(false);
      turn.abort();
    });
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith('Shannon FCA context skipped code=fca_context_budget'))).toHaveLength(1);
  }, 120_000);

  it('does not show or run a task carrying more provenance than one check may walk', async () => {
    const { f } = await built();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const task = f.runtime.get('owner', f.children[0]!)!;
    const many = Array.from({ length: FCA_PROVENANCE_LIMITS.recalledIds + 1 }, (_, index) => `memory-${index}`);
    expect(f.visible.sources('owner', task, [{ kind: 'memory', stepId: 'memory:many', experienceId: null, threadId: null, observedAt: f.world.now(), recalledMemoryIds: many }])).toBe(false);
    expect(warn.mock.calls.some(([line]) => String(line).startsWith('Shannon FCA provenance capped code=fca_provenance_capped'))).toBe(true);
  }, 120_000);
});
