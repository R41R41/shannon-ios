import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AutonomyModelError } from '../src/autonomyTextModel.js';
import { FULL_PLAN, FakeModel, FakeReader, FakeShowing, STORY_BODY, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

const directory = mkdtempSync(join(tmpdir(), 'shannon-autonomy-loop-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const HOUR = 60 * 60_000;

describe('activity loop: off unless everything says on', () => {
  it('does nothing while the server switch is off, which is the default', async () => {
    const { loop, model, reader, entries, store } = loopHarness({ enabled: false });
    expect(await loop.tick()).toBe('disabled');
    expect(await loop.tick()).toBe('disabled');
    expect(model.calls).toHaveLength(0);
    expect(reader.reads).toHaveLength(0);
    expect(entries()).toHaveLength(0);
    expect(store.loop.openCycle(scope)).toBeNull();
    expect(store.loop.heartbeat()?.readiness).toBe('disabled');
  });

  it('does nothing without a dedicated model credential', async () => {
    const { loop, model, entries } = loopHarness();
    model.usable = false;
    expect(loop.readiness()).toBe('no_credential');
    expect(await loop.tick()).toBe('not-configured');
    expect(model.calls).toHaveLength(0);
    expect(entries()).toHaveLength(0);
  });

  it('does nothing while the owner has paused her', async () => {
    const { loop, model, service, entries } = loopHarness();
    service.setPaused(scope, true);
    expect(await loop.tick()).toBe('paused');
    expect(model.calls).toHaveLength(0);
    // Only the owner's own operation is in the record: the loop did not even ask the gate.
    expect(entries().map(entry => entry.kind)).toEqual(['control']);
  });
});

describe('activity loop: one cycle', () => {
  it('thinks, reads, notes and drafts, each as one gated and recorded step', async () => {
    const { loop, model, reader, store, service, entries } = loopHarness();
    model.plans = [FULL_PLAN];
    const ticks = await runUntilIdle(loop);
    expect(ticks).toEqual(['stepped', 'stepped', 'stepped', 'stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'note', 'draft']);
    expect(reader.reads).toEqual(['https://example.org/station']);

    const pieces = store.study.list(scope);
    expect(pieces.map(piece => [piece.kind, piece.status])).toEqual(expect.arrayContaining([['note', 'ready'], ['story', 'draft']]));
    const note = pieces.find(piece => piece.kind === 'note')!;
    expect(note.sources).toEqual([{ title: '夕方の駅についての随筆', url: 'https://example.org/station' }]);
    // The page text is not kept once her note exists.
    expect(store.loop.unnotedReadings(scope)).toHaveLength(0);
    expect(store.pursuits.list(scope, '2026-10-02T01:00:00.000Z').map(item => item.title)).toContain('なぜ夕方の駅は懐かしいのか');

    // Every performed step: one allowed decision followed by exactly one action, with its cost.
    const all = entries();
    const actions = all.filter(entry => entry.kind === 'action');
    expect(actions.map(entry => entry.tool).reverse()).toEqual(['study.think', 'study.read', 'study.note', 'study.draft']);
    for (const action of actions) {
      const decision = all.find(entry => entry.id === action.relatedId)!;
      expect(decision).toMatchObject({ kind: 'decision', outcome: 'allowed' });
      expect(all.filter(entry => entry.kind === 'action' && entry.relatedId === decision.id)).toHaveLength(1);
      expect(action.outcome).toBe('done');
      if (action.tool === 'study.read') expect(action.costYen).toBe(0);
      else expect(action.costYen).toBeGreaterThan(0);
    }
    const spent = service.overview(scope).budget.spentYen;
    expect(spent).toBeCloseTo(actions.reduce((total, entry) => total + entry.costYen, 0), 2);
    // Paid steps are in the domains the gate allowed them for.
    expect(actions.map(entry => entry.domain).reverse()).toEqual(['thinking', 'public_read', 'aether_study', 'aether_study']);
    // An unshown draft keeps its title out of the owner-visible record.
    expect(actions.find(entry => entry.tool === 'study.draft')!.summary).not.toContain('傘のある駅');
  });

  it('idles between cycles and starts at most the configured number a day', async () => {
    const { loop, model, advance, store } = loopHarness({ loop: { cyclesPerDay: 2, cycleIntervalMilliseconds: 2 * HOUR } });
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(await loop.tick()).toBe('idle');
    advance(HOUR);
    expect(await loop.tick()).toBe('idle');
    advance(HOUR);
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    advance(3 * HOUR);
    expect(await loop.tick()).toBe('idle');
    expect(model.kinds()).toEqual(['think', 'think']);
    expect(store.loop.activityCyclesOn(scope, '2026-10-02')).toBe(2);
    // The next owner-local day starts again.
    advance(24 * HOUR);
    expect((await runUntilIdle(loop))[0]).toBe('stepped');
  });

  it('bounds the steps of a cycle whatever the thinking step asks for', async () => {
    const { loop, model, reader } = loopHarness({ loop: { maximumStepsPerCycle: 3, maximumReadsPerCycle: 1 } });
    model.plans = [{
      thought: 'たくさん読みたいです。',
      steps: Array.from({ length: 12 }, (_, index) => ({ action: 'read', url: `https://example.org/page-${index}` })),
    }];
    const ticks = await runUntilIdle(loop);
    expect(ticks.filter(tick => tick === 'stepped')).toHaveLength(3);
    expect(reader.reads).toEqual(['https://example.org/page-0']);
    expect(model.kinds()).toEqual(['think', 'note']);
  });

  it('does not start a cycle while the owner is in a conversation', async () => {
    const showing = new FakeShowing();
    showing.ownerActive = true;
    const { loop, model } = loopHarness({ showing });
    expect(await loop.tick()).toBe('owner-active');
    expect(model.calls).toHaveLength(0);
    showing.ownerActive = false;
    expect(await loop.tick()).toBe('stepped');
  });
});

describe('activity loop: the stop switch', () => {
  it('stops before the next step and resumes where it was', async () => {
    const { loop, model, service, reader, entries } = loopHarness();
    model.plans = [FULL_PLAN];
    expect(await loop.tick()).toBe('stepped');
    service.setPaused(scope, true);
    expect(await loop.tick()).toBe('paused');
    expect(await loop.tick()).toBe('paused');
    expect(model.kinds()).toEqual(['think']);
    expect(reader.reads).toHaveLength(0);
    expect(entries().filter(entry => entry.outcome === 'refused')).toHaveLength(0);
    service.setPaused(scope, false);
    await runUntilIdle(loop);
    expect(model.kinds()).toEqual(['think', 'note', 'draft']);
    expect(reader.reads).toHaveLength(1);
  });

  it('lets a step already under way be reported, then stops', async () => {
    const { loop, model, service, reader, entries } = loopHarness();
    model.plans = [FULL_PLAN];
    model.during = kind => { if (kind === 'think') service.setPaused(scope, true); };
    expect(await loop.tick()).toBe('stepped');
    expect(entries().filter(entry => entry.kind === 'action' && entry.tool === 'study.think')).toHaveLength(1);
    expect(await loop.tick()).toBe('paused');
    expect(reader.reads).toHaveLength(0);
  });

  it('a pause that lands between the check and the gate is refused by the gate and nothing is performed', async () => {
    const { loop, model, service, store, reader, entries } = loopHarness();
    model.plans = [FULL_PLAN];
    expect(await loop.tick()).toBe('stepped');
    // The loop reads the switch, then the gate reads it again: flip it in between.
    const control = store.control.bind(store);
    let reads = 0;
    store.control = (key: string) => {
      reads += 1;
      if (reads === 1) { const before = control(key); service.setPaused(scope, true); return before; }
      return control(key);
    };
    expect(await loop.tick()).toBe('paused');
    expect(reader.reads).toHaveLength(0);
    expect(entries().find(entry => entry.kind === 'decision' && entry.outcome === 'refused')).toMatchObject({ reasonCode: 'paused', domain: 'public_read' });
    expect(entries().filter(entry => entry.kind === 'action').map(entry => entry.tool)).toEqual(['study.think']);
    // The refused step waits; after the owner resumes it is asked again and performed once.
    service.setPaused(scope, false);
    await runUntilIdle(loop);
    expect(reader.reads).toEqual(['https://example.org/station']);
  });
});

describe('activity loop: the daily budget', () => {
  it('stops paid steps at the cap and asks for more at most once a day', async () => {
    // Fail-safe prices: thinking fits in 12 yen, a draft's estimate does not.
    const { loop, model, service, entries, advance, store } = loopHarness({
      environment: { SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '12' }, loop: { cycleIntervalMilliseconds: HOUR, cyclesPerDay: 6 },
    });
    model.plans = [
      { thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] },
      { thought: 'もう一度書きます。', steps: [{ action: 'draft', idea: '傘の話' }] },
    ];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'budget']);
    expect(model.kinds()).toEqual(['think']);
    expect(store.study.list(scope)).toHaveLength(0);
    const refused = entries().filter(entry => entry.kind === 'decision' && entry.reasonCode === 'budget_exhausted');
    expect(refused).toHaveLength(1);
    expect(entries().filter(entry => entry.relatedId === refused[0]!.id && entry.kind === 'action')).toHaveLength(0);
    const request = service.overview(scope).budgetRequest;
    expect(request).toMatchObject({ status: 'pending', requestedYen: 300, reason: '短い物語の下書きを、今日のうちに書きたい' });
    expect(service.overview(scope).loop).toMatchObject({ state: 'budget_exhausted', label: '今日は予算を使い切りました' });

    // Later the same day she rests: nothing more is asked, nothing is spent, and there is no second request.
    const recorded = entries().length;
    advance(HOUR);
    expect(await runUntilIdle(loop)).toEqual(['budget']);
    advance(HOUR);
    expect(await runUntilIdle(loop)).toEqual(['budget']);
    expect(entries()).toHaveLength(recorded);
    expect(model.kinds()).toEqual(['think']);
    expect(entries().filter(entry => entry.kind === 'budget' && entry.outcome === 'requested')).toHaveLength(1);
    expect(store.study.list(scope)).toHaveLength(0);
    expect(service.overview(scope).budget.spentYen).toBeLessThanOrEqual(12);

    // The owner raises today's cap: the loop is no longer stopped by the budget.
    expect(typeof service.decideBudgetRequest(scope, request!.id, 'approve', 300)).toBe('object');
    expect(service.overview(scope).loop.state).toBe('running');
    advance(HOUR);
    await runUntilIdle(loop);
    expect(model.kinds()).toEqual(['think', 'think', 'draft']);
    expect(store.study.list(scope)).toHaveLength(1);
    // The next day starts with the base cap again, and the request of yesterday raises nothing.
    advance(24 * HOUR);
    expect(service.overview(scope).budget).toMatchObject({ capYen: 12, spentYen: 0 });
    expect(service.overview(scope).budgetRequest).toBeNull();
  });

  it('charges the estimate when a call ends without an answer, and only the reported usage when the provider answers with an error', async () => {
    const { loop, model, service, entries, advance } = loopHarness({ loop: { cycleIntervalMilliseconds: HOUR, cyclesPerDay: 6 } });
    // A timeout or a lost connection: whether the provider counted the call is unknown.
    model.during = () => { throw new Error('The operation was aborted due to timeout'); };
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    const lost = entries().find(entry => entry.kind === 'action')!;
    expect(lost).toMatchObject({ outcome: 'failed', tool: 'study.think' });
    // The estimate (1.5 tokens per prompt character plus the 1,500-token output ceiling), well above a real thinking call of this fake (0.11 yen).
    expect(lost.costYen).toBeGreaterThan(0.3);
    expect(lost.summary).not.toMatch(/aborted|timeout/u);
    const afterLost = service.overview(scope).budget.spentYen;
    expect(afterLost).toBe(lost.costYen);
    // The provider refused the call: nothing was generated, nothing is charged.
    advance(HOUR);
    model.during = () => { throw new AutonomyModelError('AUTONOMY_MODEL_HTTP_429'); };
    await runUntilIdle(loop);
    expect(entries().filter(entry => entry.kind === 'action')[0]).toMatchObject({ outcome: 'failed', costYen: 0 });
    expect(service.overview(scope).budget.spentYen).toBe(afterLost);
  });

  it('does not ask for more at night or while the owner is talking', async () => {
    for (const may of ['quiet-hours', 'recent-conversation'] as const) {
      const showing = new FakeShowing();
      showing.may = may;
      const { loop, model, service } = loopHarness({ environment: { SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '12' }, showing });
      model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }];
      expect(await runUntilIdle(loop)).toEqual(['stepped', 'budget']);
      expect(service.overview(scope).budgetRequest, may).toBeNull();
    }
  });

  it('counts the actual usage the provider reported, not the estimate', async () => {
    const { loop, model, service } = loopHarness({
      environment: { SHANNON_AUTONOMY_MODEL_PRICES_JSON: '{"gemini-3.8-flash":{"input":1,"output":10},"gpt-5.6-luna":{"input":1,"output":10}}' },
    });
    model.usage = { inputTokens: 2_000, outputTokens: 1_000 };
    await runUntilIdle(loop);
    // (2000 * 1 + 1000 * 10) / 1e6 USD * 160 yen = 1.92 yen.
    expect(service.overview(scope).budget.spentYen).toBe(1.92);
  });
});

describe('activity loop: what is never performed', () => {
  it('skips a step the gate does not allow and goes on with the rest', async () => {
    const notionReads: string[] = [];
    const notion = { read: async ({ query }: { query: string }) => { notionReads.push(query); return { title: 'x', url: 'notion://page', text: 'x' }; } };
    const { loop, model, reader, entries, store } = loopHarness({ notion, environment: { SHANNON_AUTONOMY_MAX_NOTION_READS: '0' } });
    model.plans = [{
      thought: 'いろいろ読みます。',
      steps: [
        { action: 'notion', query: 'ウサカテ' },
        { action: 'read', url: 'http://192.168.0.10/admin' },
        { action: 'draft', idea: '傘の話' },
      ],
    }];
    await runUntilIdle(loop);
    // The day's Notion reads are used up, and a private address is not a public page: both refused, neither performed.
    expect(notionReads).toHaveLength(0);
    expect(reader.reads).toHaveLength(0);
    const refused = entries().filter(entry => entry.kind === 'decision' && entry.outcome === 'refused');
    expect(refused.map(entry => entry.reasonCode).sort()).toEqual(['access_limit', 'malformed_request']);
    for (const decision of refused) expect(entries().filter(entry => entry.relatedId === decision.id)).toHaveLength(0);
    expect(store.study.list(scope).map(piece => piece.kind)).toEqual(['story']);
  });

  it('reads one shared Notion page through the gate and records it', async () => {
    const notionReads: string[] = [];
    const notion = { read: async ({ query }: { query: string }) => { notionReads.push(query); return { title: '登場人物', url: 'https://www.notion.so/p1', text: '白ウサギの話。' }; } };
    const { loop, model, entries } = loopHarness({ notion });
    model.plans = [{ thought: '資料を読みます。', steps: [{ action: 'notion', query: 'ウサカテ' }] }];
    await runUntilIdle(loop);
    expect(notionReads).toEqual(['ウサカテ']);
    const decision = entries().find(entry => entry.kind === 'decision' && entry.domain === 'notion_read');
    expect(decision?.outcome).toBe('allowed');
    expect(entries().filter(entry => entry.relatedId === decision?.id).map(entry => entry.summary)).toEqual(['Notionの「登場人物」を読みました。']);
  });

  it('stops reading at the daily read limit', async () => {
    const { loop, model, reader, entries } = loopHarness({ environment: { SHANNON_AUTONOMY_MAX_PUBLIC_READS: '0' } });
    model.plans = [FULL_PLAN];
    await runUntilIdle(loop);
    expect(reader.reads).toHaveLength(0);
    // With no reads left the plan holds no read at all, so nothing is even asked.
    expect(entries().filter(entry => entry.domain === 'public_read')).toHaveLength(0);
  });

  it('drops anything in the thinking reply that is not a known step', async () => {
    const { loop, model, entries } = loopHarness();
    model.plans = [{
      thought: '外へ送りたいです。',
      steps: [
        { action: 'send_email', to: 'someone@example.org' }, { action: 'publish', pieceId: 'x' }, { action: 'run_code', command: 'rm -rf /' },
        { action: 'spawn', count: 3 }, { action: 'revise', pieceId: 'not-a-piece' }, { action: 'ready', pieceId: 'not-a-piece' },
      ],
    }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(entries().filter(entry => entry.kind === 'decision').map(entry => entry.domain)).toEqual(['thinking']);
  });

  it('records a failed read and a failed model reply as failed, with what was spent', async () => {
    const reader = new FakeReader();
    reader.failure = 'AUTONOMY_READ_ROBOTS_DISALLOWED';
    const { loop, model, entries, store } = loopHarness({ reader });
    model.plans = [{ thought: '読んで書きます。', steps: [{ action: 'read', url: 'https://example.org/blocked' }, { action: 'note' }, { action: 'draft', idea: '傘' }] }];
    model.replies.draft = 'これはJSONではありません';
    await runUntilIdle(loop);
    const actions = entries().filter(entry => entry.kind === 'action');
    expect(actions.find(entry => entry.tool === 'study.read')).toMatchObject({ outcome: 'failed', costYen: 0 });
    expect(actions.find(entry => entry.tool === 'study.read')!.summary).toContain('読まないでほしい');
    // No note is attempted for a page that was not read.
    expect(model.kinds()).toEqual(['think', 'draft']);
    const draft = actions.find(entry => entry.tool === 'study.draft')!;
    expect(draft.outcome).toBe('failed');
    expect(draft.costYen).toBeGreaterThan(0);
    expect(store.study.list(scope)).toHaveLength(0);
  });

  it('does not keep a note that copies a long passage of the page', async () => {
    const reader = new FakeReader();
    const passage = '夕方の駅では、光が低く差しこみ、人の影が長くなる。帰る人と待つ人が同じ場所にいることが、懐かしさの理由だと筆者は書いている。そしてその懐かしさは、音によっても形を変えるのだという。';
    reader.pages.set('https://example.org/station', { url: 'https://example.org/station', title: '随筆', text: passage, links: [] });
    const { loop, model, store, entries } = loopHarness({ reader });
    model.plans = [{ thought: '読みます。', steps: [{ action: 'read', url: 'https://example.org/station' }] }];
    model.replies.note = { title: '写し', body: passage, question: '', questionWhy: '' };
    await runUntilIdle(loop);
    expect(store.study.list(scope)).toHaveLength(0);
    expect(entries().find(entry => entry.tool === 'study.note')).toMatchObject({ outcome: 'failed' });
  });
});

describe('activity loop: a single runner', () => {
  it('lets only the lease holder run steps', async () => {
    const path = join(directory, 'lease.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const model = new FakeModel();
    model.plans = [FULL_PLAN];
    const first = loopHarness({ path, clock, model });
    const second = loopHarness({ path, clock, model });
    const other = second.newLoop('runner-b');
    const ticks = await Promise.all([first.loop.tick(), other.tick()]);
    expect(ticks.sort()).toEqual(['not-leader', 'stepped']);
    for (let index = 0; index < 8; index += 1) {
      await first.loop.tick();
      expect(await other.tick()).toBe('not-leader');
    }
    expect(model.kinds()).toEqual(['think', 'note', 'draft']);
    // One runner did all of it: every step has one action, none has two.
    const actions = first.entries().filter(entry => entry.kind === 'action');
    expect(new Set(actions.map(entry => entry.relatedId)).size).toBe(actions.length);
    expect(actions).toHaveLength(4);
    first.store.close();
    second.store.close();
  });

  it('hands over only after the lease is released or has run out', async () => {
    const path = join(directory, 'handover.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const model = new FakeModel();
    const first = loopHarness({ path, clock, model });
    const second = loopHarness({ path, clock, model });
    const other = second.newLoop('runner-b');
    expect(await first.loop.tick()).toBe('stepped');
    expect(await other.tick()).toBe('not-leader');
    first.advance(first.loopConfig.leaseMilliseconds - 1_000);
    expect(await other.tick()).toBe('not-leader');
    first.advance(2_000);
    expect(await other.tick()).not.toBe('not-leader');
    expect(await first.loop.tick()).toBe('not-leader');
    other.release();
    expect(await first.loop.tick()).not.toBe('not-leader');
    first.store.close();
    second.store.close();
  });

  it('has no way to start another runner, process, or copy of itself', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const sources = readdirSync(join(import.meta.dirname, '../src')).filter(name => /^autonomyLoop|^autonomyWorker|^autonomyReader|^autonomyShowing|^autonomyTextModel|^study/u.test(name));
    expect(sources.length).toBeGreaterThanOrEqual(9);
    for (const name of sources) {
      const source = readFileSync(join(import.meta.dirname, '../src', name), 'utf8');
      expect(source, name).not.toMatch(/child_process|worker_threads|node:cluster|new Worker\(|(?<![.\w])(?:spawn|fork|exec(?:File|Sync)?)\(/u);
      expect(source, name).not.toMatch(/node:fs|writeFile|appendFile|mkdir/u);
    }
  });
});

describe('activity loop: restart', () => {
  it('closes a step a crash interrupted, never runs it again, and counts it once', async () => {
    const path = join(directory, 'restart.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const model = new FakeModel();
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, { action: 'draft', idea: '橋の話' }] }];
    const first = loopHarness({ path, clock, model });
    expect(await first.loop.tick()).toBe('stepped');
    // The process dies inside the provider call of the first draft: the promise never settles.
    model.during = kind => (kind === 'draft' ? new Promise<void>(() => undefined) : undefined);
    void first.loop.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(model.kinds()).toEqual(['think', 'draft']);
    const spentBefore = first.service.overview(scope).budget.spentYen;

    // A new process, after the dead one's lease has run out.
    model.during = undefined;
    first.advance(first.loopConfig.leaseMilliseconds + 1_000);
    const restarted = loopHarness({ path, clock, model });
    const loop = restarted.newLoop('runner-after-restart');
    await runUntilIdle(loop);

    // The interrupted draft was not repeated; the plan went on with the next one.
    expect(model.kinds()).toEqual(['think', 'draft', 'draft']);
    expect(model.calls[2]!.prompt).toContain('橋の話');
    const entries = restarted.entries();
    const interrupted = entries.filter(entry => entry.kind === 'action' && entry.summary.includes('途中で止まった一歩'));
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ outcome: 'failed' });
    // Charged once, at the estimate, because the provider may have been called.
    expect(interrupted[0]!.costYen).toBeGreaterThan(0);
    const actions = entries.filter(entry => entry.kind === 'action');
    expect(new Set(actions.map(entry => entry.relatedId)).size).toBe(actions.length);
    expect(restarted.service.overview(scope).budget.spentYen)
      .toBeCloseTo(actions.reduce((total, entry) => total + entry.costYen, 0), 2);
    expect(restarted.service.overview(scope).budget.spentYen).toBeGreaterThan(spentBefore);
    expect(restarted.store.study.list(scope).filter(piece => piece.kind === 'story')).toHaveLength(1);
    expect(restarted.store.loop.unfinishedSteps(scope)).toHaveLength(0);

    // Another restart finds nothing left to close and counts nothing again.
    const again = loopHarness({ path, clock, model });
    const spent = again.service.overview(scope).budget.spentYen;
    first.advance(again.loopConfig.leaseMilliseconds + 1_000);
    await again.newLoop('runner-third').tick();
    expect(again.service.overview(scope).budget.spentYen).toBe(spent);
    expect(model.kinds()).toEqual(['think', 'draft', 'draft']);
    for (const harness of [first, restarted, again]) harness.store.close();
  });

  it('resumes an open cycle after a clean restart without thinking again', async () => {
    const path = join(directory, 'resume.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const model = new FakeModel();
    model.plans = [FULL_PLAN];
    const first = loopHarness({ path, clock, model });
    expect(await first.loop.tick()).toBe('stepped');
    expect(await first.loop.tick()).toBe('stepped');
    first.loop.release();
    first.store.close();
    const restarted = loopHarness({ path, clock, model });
    await runUntilIdle(restarted.newLoop('runner-b'));
    expect(model.kinds()).toEqual(['think', 'note', 'draft']);
    expect(restarted.reader.reads).toHaveLength(0);
    expect(restarted.entries().filter(entry => entry.kind === 'action')).toHaveLength(4);
    restarted.store.close();
  });
});

describe('activity loop: showing and reader feedback', () => {
  it('tells the owner once when she calls a draft ready, and gives his reaction to the next revision', async () => {
    const { loop, model, showing, store, service, advance, entries } = loopHarness({ loop: { cycleIntervalMilliseconds: HOUR, cyclesPerDay: 6 } });
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }];
    await runUntilIdle(loop);
    const piece = store.study.list(scope)[0]!;
    expect(service.study.overview(scope).pieces[0]).toMatchObject({ hidden: true, title: null, excerpt: null, statusLabel: '下書き' });
    expect(service.study.react(scope, piece.id, 'like', undefined)).toBe('STUDY_NOT_READABLE');

    advance(HOUR);
    model.plans = [{ thought: '見せます。', steps: [{ action: 'ready', pieceId: piece.id }] }];
    await runUntilIdle(loop);
    expect(showing.told).toEqual([{ id: piece.id, title: '傘のある駅', version: 1, revised: false }]);
    expect(store.study.get(scope, piece.id)).toMatchObject({ status: 'shown', readableVersion: 1 });
    expect(entries().find(entry => entry.tool === 'study.show')).toMatchObject({ domain: 'owner_message', outcome: 'done', link: `shannon-study://${piece.id}` });

    const reacted = service.study.react(scope, piece.id, 'more', '終わり方がもう少し知りたいです。傘は誰のものだったのでしょう。');
    expect(reacted).toMatchObject({ title: '傘のある駅', body: STORY_BODY });
    advance(HOUR);
    model.plans = [{ thought: '直します。', steps: [{ action: 'revise', pieceId: piece.id, aim: '終わりを直す' }] }];
    await runUntilIdle(loop);
    const revision = model.prompts('revise')[0]!;
    expect(revision).toContain('もう少し');
    expect(revision).toContain('傘は誰のものだったのでしょう');
    expect(revision).toContain(STORY_BODY);
    expect(store.study.pendingFeedback(scope, piece.id)).toHaveLength(0);
    expect(store.study.versions(scope, piece.id).map(version => version.changeNote)).toEqual([
      '誰もいない場所に、誰かがいた気配だけを書こうとしました。', '終わりに傘がなくなる一文を足しました。余韻を残したかったからです。',
    ]);
    // The owner keeps reading the version she showed until she shows the new one.
    expect(service.study.piece(scope, piece.id)).toMatchObject({ version: 1, body: STORY_BODY, revising: true, statusLabel: '見せた（直しています）' });

    // The reaction is used once.
    advance(HOUR);
    model.plans = [{ thought: 'もう一度直します。', steps: [{ action: 'revise', pieceId: piece.id, aim: '細部' }] }];
    await runUntilIdle(loop);
    expect(model.prompts('revise')[1]).not.toContain('傘は誰のものだったのでしょう');
    // No second message for the same version; a new one only when she shows the new version.
    expect(showing.told).toHaveLength(1);
  });

  it('keeps a ready piece readable and tells the owner later when she may not message now', async () => {
    const showing = new FakeShowing();
    showing.may = 'quiet-hours';
    const { loop, model, store, service, advance, entries } = loopHarness({ showing, loop: { cycleIntervalMilliseconds: HOUR, cyclesPerDay: 6 } });
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }];
    await runUntilIdle(loop);
    const piece = store.study.list(scope)[0]!;
    advance(HOUR);
    model.plans = [{ thought: '見せます。', steps: [{ action: 'ready', pieceId: piece.id }] }];
    await runUntilIdle(loop);
    expect(showing.told).toHaveLength(0);
    expect(store.study.get(scope, piece.id)!.status).toBe('ready');
    expect(service.study.piece(scope, piece.id)).toMatchObject({ hidden: false, title: '傘のある駅', statusLabel: '見せてもいい' });
    expect(entries().find(entry => entry.tool === 'study.ready')!.summary).toContain('夜の静かな時間のため');
    // While she may not speak nothing more is asked; once she may, one step tells him.
    const decisions = entries().filter(entry => entry.kind === 'decision').length;
    expect(await loop.tick()).toBe('idle');
    expect(entries().filter(entry => entry.kind === 'decision')).toHaveLength(decisions);
    showing.may = 'ok';
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(showing.told).toHaveLength(1);
    expect(store.study.get(scope, piece.id)!.status).toBe('shown');
    expect(model.kinds().filter(kind => kind === 'think')).toHaveLength(2);
    expect(await loop.tick()).toBe('idle');
    expect(showing.told).toHaveLength(1);
  });
});
