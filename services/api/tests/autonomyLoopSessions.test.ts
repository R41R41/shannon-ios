import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { configuredAutonomyLoop } from '../src/autonomyLoopConfig.js';
import { mayRetryThought } from '../src/autonomyLoopPacing.js';
import { OWNER_CONTEXT_HEADER, OWNER_CONTEXT_WRITING_HEADER, ownerPrivateRule } from '../src/autonomyLoopOwnerContext.js';
import { salvagedModelObject } from '../src/autonomyLoopPrompts.js';
import { createOwnerContext } from '../src/autonomyOwnerContext.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SESSION_FACTS_HEADER, sessionFactsSection, type SessionFacts } from '../src/autonomyLoopSessionPrompts.js';
import { AutonomyModelError, type AutonomyTextRequest, type AutonomyTextResult } from '../src/autonomyTextModel.js';
import { planFromThought } from '../src/autonomyLoopPlan.js';
import { FakeModel, FakeShowing, callKind, loopHarness, runUntilIdle, scope, type LoopHarnessOptions } from './autonomyLoopHarness.js';

/**
 * She paces her own day (owner decision 2026-10-02, Syzygy ADR-0003): a session runs until she rests, she says when
 * she comes back, and every bound that can stop a session is recorded. A fake model and a clock the test moves.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-autonomy-sessions-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 10 USD per million tokens for every model she uses: 0.0016 yen a token at 160 yen to the dollar. */
const PRICES = { SHANNON_AUTONOMY_MODEL_PRICES_JSON: '{"gemini-3.8-flash":{"input":10,"output":10},"gpt-5.6-luna":{"input":10,"output":10}}' };

/** A model whose every call uses exactly what the gate was asked to make room for: the most a step can cost. */
class WorstCaseModel extends FakeModel {
  override async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    this.usage = { inputTokens: Math.ceil((request.system.length + request.prompt.length) * 1.5) + 64, outputTokens: request.maximumOutputTokens };
    return super.generate(request);
  }
}

function sessions(options: LoopHarnessOptions = {}) {
  return loopHarness({ sessions: true, ...options, environment: { ...PRICES, SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '2000', ...options.environment } });
}

const rest = (resumeInMinutes?: number, reason?: string) => ({ action: 'rest', ...(resumeInMinutes !== undefined ? { resumeInMinutes } : {}), ...(reason ? { reason } : {}) });
const read = (name: string) => ({ action: 'read', url: `https://example.org/${name}` });
const facts = (prompt: string) => prompt.slice(prompt.lastIndexOf(SESSION_FACTS_HEADER));

describe('a session: she runs until she decides to rest', () => {
  it('goes on thinking, acting and thinking again, and rests when she says so, until the time she chose', async () => {
    const { loop, model, store, entries, advance, clock, service } = sessions();
    const REASON = 'あと1,900円くらい。残りは2時間後に考えよう';
    model.plans = [
      { thought: '読んでみます。', steps: [read('station')] },
      { thought: '書いてみます。', steps: [{ action: 'draft', idea: '傘の話' }] },
      { thought: 'ここまでにします。', steps: [{ action: 'draft', idea: '橋の話' }, rest(120, REASON), { action: 'draft', idea: '書かれない話' }] },
    ];
    const ticks = await runUntilIdle(loop);
    // think, read, note, think, draft, think, draft, rest: eight steps, far more than a cycle's six, in one session.
    expect(ticks).toEqual([...Array.from({ length: 7 }, () => 'stepped'), 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'note', 'think', 'draft', 'think', 'draft']);
    expect(store.loop.sessions.startedOn(scope, '2026-10-02')).toBe(1);

    // Every step was asked of the gate and recorded, the closing one too, with her reason in her own words.
    const actions = entries().filter(entry => entry.kind === 'action').reverse();
    expect(actions.map(entry => entry.tool)).toEqual(['study.think', 'study.read', 'study.note', 'study.think', 'study.draft', 'study.think', 'study.draft', 'study.rest']);
    for (const action of actions) expect(entries().find(entry => entry.id === action.relatedId)).toMatchObject({ kind: 'decision', outcome: 'allowed' });
    expect(actions.at(-1)).toMatchObject({ outcome: 'done', reasonCode: 'rest', costYen: 0, summary: `ここで一区切りにしました。次は12:00ごろに考えます。「${REASON}」` });

    // The next session begins when she said, not before.
    const closed = store.loop.sessions.latestClosed(scope)!;
    expect(closed).toMatchObject({ endCode: 'rest', restReason: REASON, resumeAt: '2026-10-02T03:00:00.000Z' });
    expect(store.loop.nextCycleAt(scope)).toBe('2026-10-02T03:00:00.000Z');
    expect(service.overview(scope).session).toMatchObject({ state: 'resting', label: '12:00まで休憩中', until: '2026-10-02T03:00:00.000Z', reason: REASON, endCode: 'rest' });
    advance(119 * MINUTE);
    expect(await loop.tick()).toBe('idle');
    advance(MINUTE);
    expect(clock.at).toBe('2026-10-02T03:00:00.000Z');
    expect(await loop.tick()).toBe('stepped');
    // She is told how the session before ended, in her own words.
    expect(facts(model.prompts('think').at(-1)!)).toContain(`- 前の時間: 10:00に、自分で一区切りにした。その時に書いたこと:「${REASON}」`);
    expect(service.overview(scope).session).toMatchObject({ state: 'active', since: '2026-10-02T03:00:00.000Z', label: expect.stringMatching(/^12:00から活動中（この時間に\d+円）$/u) });
  });

  it('holds the rest she asks for inside the bounds, and takes the default when she names none', async () => {
    for (const [asked, minutes] of [[5, 10], [45, 45], [5_000, 720], [undefined, 150], ['90', 90], ['すぐ', 150]] as const) {
      const { loop, model, store, clock } = sessions();
      model.plans = [{ thought: '休みます。', steps: [{ action: 'rest', ...(asked !== undefined ? { resumeInMinutes: asked } : {}) }] }];
      expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
      expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at), String(asked)).toBe(minutes * MINUTE);
    }
  });

  it('ends a session whose thoughts keep leading to no step, instead of thinking in a loop, and comes back sooner', async () => {
    const { loop, model, store, entries, clock } = sessions();
    const empty = { thought: 'うーん。', steps: [] };
    model.plans = [empty, empty, empty, empty];
    // One thought, two more inside the re-think limit, then the closing step.
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'think', 'think']);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'idle' });
    // Nothing was done, so she comes back after the short rest, not the long default.
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(30 * MINUTE);
    expect(entries().find(entry => entry.tool === 'study.rest' && entry.kind === 'action')?.summary).toBe('次の一歩が決まらなかったので、ここで一区切りにしました。次は10:30ごろに考えます。');
    expect(entries().filter(entry => entry.tool === 'study.think' && entry.kind === 'action').map(entry => [entry.outcome, entry.reasonCode])).toEqual([['done', 'empty_plan'], ['done', 'empty_plan'], ['done', 'empty_plan']]);
  });

  it('does not let sessions that did nothing use up the day, and does not come back every half hour when the cause stays', async () => {
    const { loop, model, store, advance, clock, service } = sessions({ loop: { sessionsPerDay: 2, maximumRethinksPerCycle: 0 } });
    const idle = async () => { model.plans = [{ thought: 'うーん。', steps: [] }]; return runUntilIdle(loop); };
    // The first idle session: a short rest. The next one is idle too: the long default, so a cause that stays is met rarely.
    await idle();
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(30 * MINUTE);
    advance(30 * MINUTE);
    await idle();
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(150 * MINUTE);
    advance(150 * MINUTE);
    await idle();
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(150 * MINUTE);
    // Three sessions were begun and none of them counts: the day's two sessions are still hers.
    expect(model.kinds()).toHaveLength(3);
    expect(store.loop.sessions.startedOn(scope, '2026-10-02')).toBe(0);
    expect(service.overview(scope).session).toMatchObject({ state: 'resting', endCode: 'idle', endLabel: '次の一歩が決まらず、何もせず終わりました' });
    advance(150 * MINUTE);
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, rest(10)] }];
    expect((await runUntilIdle(loop)).at(-1)).toBe('cycle-ended');
    expect(store.loop.sessions.startedOn(scope, '2026-10-02')).toBe(1);
    // After a session that did something, an idle one is again followed by the short rest.
    advance(10 * MINUTE);
    await idle();
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(30 * MINUTE);
  });

  it('keeps a second idle session in a row far away also when the default rest is set short, and through the close without a step', async () => {
    const { loop, model, store, advance, clock, service } = sessions({ loop: { maximumRethinksPerCycle: 0, sessionDefaultRestMilliseconds: 10 * MINUTE, sessionNoPlanRestMilliseconds: 10 * MINUTE } });
    const idle = async () => { model.plans = [{ thought: 'うーん。', steps: [] }]; return runUntilIdle(loop); };
    await idle();
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(10 * MINUTE);
    advance(10 * MINUTE);
    // The closing step cannot be recorded this time: the session is closed without one, by the same rule.
    const recordAction = service.recordAction.bind(service);
    service.recordAction = (scopeKey, report) => { if (report.summary.includes('一区切り')) throw new Error('DISK'); return recordAction(scopeKey, report); };
    model.plans = [{ thought: 'うーん。', steps: [] }];
    for (let index = 0; index < 8 && (index === 0 || store.loop.openCycle(scope)); index += 1) await loop.tick();
    expect(store.loop.openCycle(scope)).toBeNull();
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'idle' });
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(150 * MINUTE);
  });

  it('does not count a thought the gate refused among the thoughts in a row', async () => {
    const { store, loopConfig } = sessions();
    const cycle = store.loop.startCycle(scope, '2026-10-02', 'activity', [], '2026-10-02T01:00:00.000Z');
    const think = (status: 'reported' | 'refused') => {
      const row = store.loop.beginStep(store.loop.openCycle(scope)!, { kind: 'think' }, [], '2026-10-02T01:00:00.000Z');
      store.loop.finishStep(row.id, status, '2026-10-02T01:00:00.000Z');
    };
    const dependencies = { store, loop: loopConfig };
    think('reported'); think('reported');
    expect(mayRetryThought(dependencies, cycle, 2)).toBe(true);
    // A pause landed between the check and the gate: that thought was never had.
    think('refused'); think('refused');
    expect(mayRetryThought(dependencies, cycle, 4)).toBe(true);
    think('reported');
    expect(mayRetryThought(dependencies, cycle, 5)).toBe(false);
  });

  it('thinks again when a step fails, with what happened in front of her, and her new plan replaces the old one', async () => {
    const { loop, model, reader, store } = sessions();
    reader.failure = 'AUTONOMY_READ_FAILED';
    model.plans = [{ thought: '読みます。', steps: [read('gone'), { action: 'draft', idea: '傘の話' }] }, { thought: 'やめておきます。', steps: [rest(30, '読めなかったので')] }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'stepped', 'cycle-ended']);
    expect(model.prompts('think')[1]).toContain('- 公開ページを読もうとしたが、読めなかった。');
    expect(model.prompts('think')[1]).toContain('[このあとにするつもりだったこと]\n物語を書く');
    expect(model.kinds()).toEqual(['think', 'think']);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'rest', restReason: '読めなかったので' });
  });

  it('does not think again at all when the re-think limit is zero', async () => {
    const { loop, model, store } = sessions({ loop: { maximumRethinksPerCycle: 0 } });
    model.plans = ['これはJSONではありません'];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think']);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'idle' });
  });
});

describe('a session: a thought that leads to no step', () => {
  const twoStories = (store: ReturnType<typeof sessions>['store']) => ['傘のある駅', '橋の話'].map(title => {
    const piece = store.study.create(scope, { kind: 'story', title, body: '本文。'.repeat(60), changeNote: '最初の稿です。' }, '2026-10-02T00:00:00.000Z');
    if (typeof piece === 'string') throw new Error(piece);
    return piece;
  });
  const thinks = (entries: ReturnType<typeof sessions>['entries']) => entries().filter(entry => entry.tool === 'study.think' && entry.kind === 'action').reverse().map(entry => [entry.outcome, entry.reasonCode]);

  it('says why a reply was no JSON, lets her think once more with that in front of her, and goes on', async () => {
    const lines: string[] = [];
    const { loop, model, store, entries } = sessions({ log: line => lines.push(line) });
    model.plans = ['ええと、まず物語を直してから休もうと思います。', { thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, rest(60)] }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'think', 'draft']);
    expect(thinks(entries)).toEqual([['failed', 'unparsable'], ['done', undefined]]);
    expect(entries().find(entry => entry.reasonCode === 'unparsable')!.summary).toBe('考えましたが、次の一歩にまとまりませんでした。');
    // The second thought is told why, in a fixed sentence, and none of the words of the reply.
    expect(model.prompts('think')[1]).toContain('[さっき考えた時のこと]（次の一歩が決まらなかった理由。事実だけ）\n- 返事がJSONの形になっていなかった。説明を付けず、JSONだけを返す。\n- できる一歩を選び直す。');
    expect(model.prompts('think')[1]).not.toContain('まず物語を直してから');
    expect(model.calls[1]!.prompt.endsWith(facts(model.calls[1]!.prompt))).toBe(true);
    expect(lines).toEqual(['think unparsable']);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'rest' });
  });

  it('keeps the steps a cut-off reply had written out in full, and says that it was cut off', async () => {
    const { loop, model, entries, store } = sessions();
    const [piece] = twoStories(store);
    model.plans = [`{"thought":"直します。","pursuits":[],"steps":[{"action":"revise","pieceId":"${piece!.id}","aim":"終わりを静かにする"},{"action":"rest","resumeInMinutes":60,"reason":"直したら、いちど離れて`];
    model.truncatedCalls.add(0);
    await loop.tick();
    expect(thinks(entries)).toEqual([['done', 'truncated']]);
    expect(store.loop.openCycle(scope)!.plan).toEqual([{ kind: 'revise', pieceId: piece!.id, intent: '終わりを静かにする' }]);
  });

  it('says that a reply was cut off before anything was written, and asks her for a shorter one', async () => {
    const { loop, model, entries } = sessions();
    model.plans = ['{"thought":"第一稿を寝かせたので、これから読み返して、', { thought: '休みます。', steps: [rest(60)] }];
    model.truncatedCalls.add(0);
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'cycle-ended']);
    expect(thinks(entries)).toEqual([['failed', 'truncated'], ['done', undefined]]);
    expect(entries().find(entry => entry.reasonCode === 'truncated')!.summary).toBe('考えましたが、返事が途中で切れて、次の一歩にまとまりませんでした。');
    expect(model.prompts('think')[1]).toContain('- 返事が途中で切れた。thought は1文にして、steps は少なくする。');
    // A thinking step of a session has room for the model's own reasoning and the reply.
    expect(model.calls[0]!.maximumOutputTokens).toBe(4_000);
  });

  it('charges and names a reply whose whole ceiling went to the model\'s own reasoning, and does not ask again at the same ceiling', async () => {
    const { loop, model, entries, service, store } = sessions();
    model.during = kind => { if (kind === 'think') throw new AutonomyModelError('AUTONOMY_MODEL_TRUNCATED', { inputTokens: 4_600, outputTokens: 4_000 }); };
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    // No hint of hers can make the model reason less: one call, named, charged once, and the session ends.
    expect(model.kinds()).toEqual(['think']);
    expect(thinks(entries)).toEqual([['failed', 'truncated']]);
    // (4,600 + 4,000) tokens at 10 USD a million and 160 yen: 13.76 yen for the reply that never came.
    expect(entries().find(entry => entry.reasonCode === 'truncated')!.costYen).toBe(13.76);
    expect(service.overview(scope).budget.spentYen).toBe(13.76);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'idle' });
  });

  it('asks the provider for little reasoning in a thinking step, and in no other step', async () => {
    const low = sessions();
    low.model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, rest(60)] }];
    await runUntilIdle(low.loop);
    expect(low.model.calls.map(call => [callKind(call), call.reasoning])).toEqual([['think', 'low'], ['draft', undefined]]);
    // The fixed cycles send the same field: nothing else of the request changes.
    const cycles = loopHarness();
    await runUntilIdle(cycles.loop);
    expect(cycles.model.calls.map(call => [call.reasoning, call.maximumOutputTokens])).toEqual([['low', 1_500]]);
    expect(cycles.model.calls[0]!.system).toContain('rest（今回はここまで）');
    const plain = sessions({ loopEnvironment: { SHANNON_AUTONOMY_PLAN_REASONING: 'default' } });
    await runUntilIdle(plain.loop);
    expect('reasoning' in plain.model.calls[0]!).toBe(false);
  });

  it('thinks once more, told why, when the steps she planned could not be carried out when their turn came', async () => {
    const lines: string[] = [];
    const { loop, model, store, entries } = sessions({ log: line => lines.push(line) });
    for (let index = 0; index < 12; index += 1) store.study.create(scope, { kind: 'story', title: `話${index}`, body: '本文。'.repeat(60), changeNote: '最初の稿です。' }, '2026-10-02T00:00:00.000Z');
    store.loop.addReading(scope, { url: 'https://www.aozora.gr.jp/', title: '青空文庫', text: '', links: [] }, '2026-10-01T00:00:00.000Z');
    store.loop.markReadingNoted(scope, store.loop.unnotedReadings(scope)[0]!.id, '2026-10-01T00:00:00.000Z');
    model.plans = [
      // A draft with her study full, and a page she has read already: both are planned and neither can be done.
      { thought: '書いて、読みます。', pursuits: [{ op: 'add', kind: 'question', title: '傘は誰のものか', why: '気になるからです。' }], steps: [{ action: 'draft', idea: '傘の話' }, { action: 'read', url: 'https://www.aozora.gr.jp/' }] },
      { thought: '休みます。', steps: [rest(60)] },
    ];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'think']);
    expect(model.prompts('think')[1]).toContain([
      '[さっき考えた時のこと]（次の一歩が決まらなかった理由。事実だけ）',
      '- draft は、書斎の物語がいっぱいで、新しく書けなかった。先にどれかを ready にするか put_away でしまう。',
      '- read は、もう読んだページだった。ほかのページを選ぶ。',
      '- できる一歩を選び直す。',
    ].join('\n'));
    expect(lines).toEqual(['plan unprepared:draft.study_full,read.already_read']);
    expect(store.loop.steps(store.loop.sessions.latestClosed(scope)!.cycleId)[1]!.step).toEqual({ kind: 'think', again: true, dropped: ['draft.study_full', 'read.already_read'] });
    // That first thought did plan steps, so what it wrote in her ledger stands.
    expect(store.pursuits.list(scope, '2026-10-02T02:00:00.000Z').map(item => item.title)).toContain('傘は誰のものか');
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'rest' });
    expect(entries().filter(entry => entry.kind === 'action' && entry.tool === 'study.draft')).toEqual([]);
  });

  it('writes nothing in her ledger from a thought that is about to be thought again', async () => {
    const { loop, model, store } = sessions();
    model.plans = [
      { thought: 'うーん。', pursuits: [{ op: 'add', kind: 'question', title: '捨てられる問い', why: '気になるからです。' }], steps: [] },
      { thought: '休みます。', pursuits: [{ op: 'add', kind: 'question', title: '残る問い', why: '気になるからです。' }], steps: [rest(60)] },
    ];
    await runUntilIdle(loop);
    const titles = store.pursuits.list(scope, '2026-10-02T02:00:00.000Z').map(item => item.title);
    expect(titles).toContain('残る問い');
    expect(titles).not.toContain('捨てられる問い');
  });

  it('says which steps could not be done and why, when every step she named is dropped', async () => {
    const path = join(directory, 'filtered.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const persistent = new SQLiteShannonStore({ path, now: () => clock.at });
    persistent.appendTurn(scope, persistent.threadId(scope), '今日は釣りに行きました。', 'いいですね。', '2026-10-02T00:30:00.000Z');
    const ownerContext = createOwnerContext({ snapshot: scopeKey => persistent.snapshot(scopeKey), conversations: persistent, profile: persistent }, { characters: 2_400, timeZone: 'Asia/Tokyo' });
    const lines: string[] = [];
    const { loop, model, entries, store } = sessions({ path, clock, ownerContext, log: line => lines.push(line) });
    twoStories(store);
    model.plans = [
      { thought: '直して、読みます。', steps: [{ action: 'revise', pieceId: 'the-draft', aim: '終わり' }, read('made-up'), read('made-up-too'), { action: 'note' }, { action: 'publish', to: 'everyone' }] },
      { thought: '休みます。', steps: [rest(60)] },
    ];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'cycle-ended']);
    expect(thinks(entries)).toEqual([['done', 'all_steps_filtered:revise.unknown_piece,read.not_listed,note.nothing_read,other.unavailable'], ['done', undefined]]);
    const told = model.prompts('think')[1]!;
    expect(told).toContain([
      '[さっき考えた時のこと]（次の一歩が決まらなかった理由。事実だけ）',
      '- revise は、pieceId の物語が書斎に見つからなかった。「書斎: 物語」の ( ) の中の id をそのまま書く。',
      '- read は、「読めそうな場所」にない住所だった。そこにある住所をそのまま書く。',
      '- note は、メモにする読み物がなかった。先に read する。',
      '- 知らない action は、できない一歩だった。',
      '- できる一歩を選び直す。',
    ].join('\n'));
    // No word of the reply is in her record or in what she is told: not the id she made up, not the action she invented.
    expect(JSON.stringify(entries())).not.toMatch(/the-draft|publish|made-up/u);
    expect(told).not.toMatch(/the-draft|publish|made-up/u);
    expect(lines).toEqual(['think all_steps_filtered:revise.unknown_piece,read.not_listed,note.nothing_read,other.unavailable']);
    // The plan that was stored for the second thought holds the same closed codes and nothing else.
    expect(store.loop.steps(store.loop.sessions.latestClosed(scope)!.cycleId)[1]!.step).toEqual({ kind: 'think', again: true, dropped: ['revise.unknown_piece', 'read.not_listed', 'note.nothing_read', 'other.unavailable'] });
    store.close(); persistent.close();
  });

  it('lets her revise her own unshown draft, with its id or, while it is her only story, without one', async () => {
    const path = join(directory, 'revise.sqlite');
    const clock = { at: '2026-10-02T11:59:47.000Z' };
    const persistent = new SQLiteShannonStore({ path, now: () => clock.at });
    persistent.appendTurn(scope, persistent.threadId(scope), '物語、楽しみにしています。', 'がんばります、ライ氏。', '2026-10-02T09:00:00.000Z');
    const ownerContext = createOwnerContext({ snapshot: scopeKey => persistent.snapshot(scopeKey), conversations: persistent, profile: persistent }, { characters: 2_400, timeZone: 'Asia/Tokyo' });
    const { loop, model, store, entries } = sessions({ path, clock, ownerContext });
    // The state of the evening it went wrong: three notes, one story draft she has not shown.
    for (const title of ['駅の光', '傘の忘れ物', '改札の音']) store.study.create(scope, { kind: 'note', title, body: '読んで思ったこと。', sources: [{ title: '随筆', url: 'https://example.org/essay' }] }, '2026-10-02T10:00:00.000Z');
    const draft = store.study.create(scope, { kind: 'story', title: '傘のある駅', body: '本文。'.repeat(80), changeNote: '最初の稿です。' }, '2026-10-02T10:58:00.000Z');
    if (typeof draft === 'string') throw new Error(draft);
    model.plans = [{ thought: '第一稿を読み返して直します。', steps: [{ action: 'revise', pieceId: draft.id, aim: '客観的に読み返して直す' }, { action: 'revise', aim: 'もう一度' }, rest(90, '直したので、また寝かせる')] }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'revise', 'revise']);
    expect(store.study.get(scope, draft.id)).toMatchObject({ version: 3, status: 'draft' });
    expect(entries().filter(entry => entry.tool === 'study.think' && entry.kind === 'action')[0]!.reasonCode).toBeUndefined();
    store.close(); persistent.close();
  });

  it('takes her only story for a revise that names none, and for nothing else: not for another action, a wrong or malformed id, or a story that is no draft', async () => {
    const { loop, model, store, entries } = sessions();
    const draft = store.study.create(scope, { kind: 'story', title: '傘のある駅', body: '本文。'.repeat(80), changeNote: '最初の稿です。' }, '2026-10-02T00:00:00.000Z');
    if (typeof draft === 'string') throw new Error(draft);
    model.plans = [
      { thought: 'しまいます。', steps: [{ action: 'put_away' }, { action: 'ready' }, { action: 'ready', pieceId: 'some-other-id' }, { action: 'revise', pieceId: 'some-other-id', aim: '終わり' }, { action: 'revise', pieceId: '', aim: '終わり' }, { action: 'revise', pieceId: 12, aim: '終わり' }] },
      { thought: '休みます。', steps: [rest(60)] },
    ];
    await runUntilIdle(loop);
    expect(store.study.get(scope, draft.id)).toMatchObject({ status: 'draft', version: 1 });
    expect(thinks(entries)[0]).toEqual(['done', 'all_steps_filtered:put_away.unknown_piece,ready.unknown_piece,revise.unknown_piece']);
    // Once she has called it ready it is no longer a draft she means by "the story".
    const known = { pursuits: [], pieces: [{ ...store.study.get(scope, draft.id)!, status: 'ready' as const }], unnotedReadingIds: [] };
    const bounds = { maximumSteps: 5, maximumReads: 2, notionAvailable: false, session: true };
    expect(planFromThought({ steps: [{ action: 'revise', aim: '終わり' }] }, known, bounds).steps).toEqual([]);
    expect(planFromThought({ steps: [{ action: 'revise', aim: '終わり' }] }, { ...known, pieces: [store.study.get(scope, draft.id)!] }, bounds).steps).toEqual([{ kind: 'revise', pieceId: draft.id, intent: '終わり' }]);
  });

  it('does not ask a provider that did not answer again at once', async () => {
    const { loop, model, entries, store } = sessions();
    model.during = () => { throw new Error('The operation was aborted due to timeout'); };
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think']);
    expect(thinks(entries)).toEqual([['failed', 'model_failed']]);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'idle' });
  });

  it('takes the short rest only after a session that did nothing but think', async () => {
    const { loop, model, store, clock } = sessions();
    const empty = { thought: 'うーん。', steps: [] };
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }, empty, empty, empty];
    await runUntilIdle(loop);
    expect(model.kinds()).toEqual(['think', 'draft', 'think', 'think', 'think']);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'no_plan' });
    // She wrote a draft in this session: the next one begins after the usual default.
    expect(Date.parse(store.loop.nextCycleAt(scope)!) - Date.parse(clock.at)).toBe(150 * MINUTE);
  });

  it('saves from a cut-off reply only what was written out in full', () => {
    const cut = (text: string) => salvagedModelObject(text);
    expect(cut('{"thought":"直す。","pursuits":[],"steps":[{"action":"revise","pieceId":"a","aim":"終わり"},{"action":"rest","resumeInMinutes":60,"reason":"直したら')).toEqual({ thought: '直す。', pursuits: [], steps: [{ action: 'revise', pieceId: 'a', aim: '終わり' }] });
    expect(cut('```json\n{"thought":"書く。","steps":[{"action":"draft","idea":"傘"},{"action":"dra')).toEqual({ thought: '書く。', steps: [{ action: 'draft', idea: '傘' }] });
    // A half-written step is never taken, and a reply cut before its steps gives nothing.
    expect(cut('{"thought":"書く。","steps":[{"action":"draft","idea":"傘の')).toBeNull();
    expect(cut('{"thought":"考えた。","pursuits":[{"op":"add","kind":"question","title":"傘","why":"気になる"},{"op":"add"')).toBeNull();
    expect(cut('{"thought":"括弧 } のある文","steps":[{"action":"note"},{"action":"dr')).toEqual({ thought: '括弧 } のある文', steps: [{ action: 'note' }] });
    expect(cut('返事はありません')).toBeNull();
  });

  it('under the fixed cycles a reply that was cut off is not saved from: it fails as before, with its reason', async () => {
    const { loop, model, entries, store } = loopHarness();
    const draft = store.study.create(scope, { kind: 'story', title: '傘のある駅', body: '本文。'.repeat(80), changeNote: '最初の稿です。' }, '2026-10-02T00:00:00.000Z');
    if (typeof draft === 'string') throw new Error(draft);
    model.plans = [`{"thought":"直します。","steps":[{"action":"revise","pieceId":"${draft.id}","aim":"終わり"},{"action":"dra`];
    model.truncatedCalls.add(0);
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think']);
    expect(entries().filter(entry => entry.kind === 'action').map(entry => [entry.outcome, entry.reasonCode, entry.summary])).toEqual([['failed', 'truncated', '考えましたが、次の一歩にまとまりませんでした。']]);
    // Nor is her only story taken for a step that names none.
    const other = loopHarness();
    other.store.study.create(scope, { kind: 'story', title: '傘のある駅', body: '本文。'.repeat(80), changeNote: '最初の稿です。' }, '2026-10-02T00:00:00.000Z');
    other.model.plans = [{ thought: '直します。', steps: [{ action: 'revise', aim: '終わり' }] }];
    await runUntilIdle(other.loop);
    expect(other.model.kinds()).toEqual(['think']);
  });

  it('under the fixed cycles a thought that leads to no step is recorded with its reason and nothing else changes', async () => {
    const { loop, model, entries } = loopHarness();
    model.plans = ['これはJSONではありません'];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think']);
    expect(model.calls[0]!.maximumOutputTokens).toBe(1_500);
    expect(entries().filter(entry => entry.kind === 'action').map(entry => [entry.outcome, entry.reasonCode, entry.summary])).toEqual([['failed', 'unparsable', '考えましたが、次の一歩にまとまりませんでした。']]);
  });
});

describe('a session: what stops it when she does not', () => {
  it('stops at what one session may spend, before the step that would not fit, and says so in her record', async () => {
    const { loop, model, store, entries, service, loopConfig, advance } = sessions({ loop: { sessionMaximumYen: 60 }, model: new WorstCaseModel() });
    model.plans = Array.from({ length: 6 }, () => ({ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, { action: 'draft', idea: '橋の話' }] }));
    const ticks = await runUntilIdle(loop);
    expect(ticks.at(-1)).toBe('cycle-ended');
    const session = store.loop.sessions.latestClosed(scope)!;
    expect(session.endCode).toBe('session_budget');
    const spent = store.loop.sessions.spentYen(session.cycleId);
    expect(spent).toBeGreaterThan(30);
    expect(spent).toBeLessThanOrEqual(60);
    expect(spent).toBe(service.overview(scope).budget.spentYen);
    // No step was allowed whose estimate did not fit: every call here costs exactly its estimate, and the sum stayed inside the cap.
    expect(store.loop.steps(session.cycleId).filter(step => step.estimate).length).toBeGreaterThanOrEqual(3);
    const closing = entries().find(entry => entry.kind === 'action' && entry.tool === 'study.rest')!;
    expect(closing).toMatchObject({ reasonCode: 'session_budget', summary: '一度に使える金額の上限に届いたので、ここで一区切りにしました。次は12:30ごろに考えます。' });
    expect(store.loop.steps(session.cycleId).at(-1)!.step).toEqual({ kind: 'rest', forced: 'session_budget' });
    // The next session is told that it was cut short.
    advance(loopConfig.sessionDefaultRestMilliseconds);
    model.plans = [{ thought: '休みます。', steps: [rest(60)] }];
    await runUntilIdle(loop);
    expect(facts(model.prompts('think').at(-1)!)).toContain('- 前の時間: 10:00に、一度に使える金額の上限に届いて止まった（自分で休んだのではない）。');
    expect(service.overview(scope).session).toMatchObject({ state: 'resting', endCode: 'rest' });
  });

  it('stops at the wall clock of one session', async () => {
    const { loop, model, store, entries, clock } = sessions({ loop: { sessionMaximumMilliseconds: 40 * MINUTE } });
    // Every model call takes a quarter of an hour.
    model.during = () => { clock.at = new Date(Date.parse(clock.at) + 15 * MINUTE).toISOString(); };
    model.plans = Array.from({ length: 6 }, (_, index) => ({ thought: '読みます。', steps: [read(`page-${index}`)] }));
    await runUntilIdle(loop);
    // think (15), read, note (30), think (45): the next step would begin after forty minutes.
    expect(model.kinds()).toEqual(['think', 'note', 'think']);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'session_time' });
    expect(entries().find(entry => entry.kind === 'action' && entry.tool === 'study.rest')).toMatchObject({
      reasonCode: 'session_time', summary: '一度に動ける時間の上限に届いたので、ここで一区切りにしました。次は13:15ごろに考えます。',
    });
  });

  it('stops at the step limit of one session even if she never rests', async () => {
    const { loop, model, store, reader } = sessions({ loop: { maximumStepsPerSession: 7 } });
    model.plans = Array.from({ length: 20 }, (_, index) => ({ thought: '読みます。', steps: [read(`page-${index}`)] }));
    await runUntilIdle(loop, 100);
    const session = store.loop.sessions.latestClosed(scope)!;
    expect(session.endCode).toBe('session_steps');
    // think, read, note, think, read, note, think: seven steps, then the closing one and nothing after it.
    expect(store.loop.steps(session.cycleId).map(step => step.step.kind)).toEqual(['think', 'read', 'note', 'think', 'read', 'note', 'think', 'rest']);
    expect(reader.reads).toHaveLength(2);
    expect(store.loop.openCycle(scope)).toBeNull();
  });

  it('closes a session that cannot even take its closing step, so it never runs unbounded', async () => {
    const { loop, store, service, model } = sessions({ loop: { maximumStepsPerSession: 2 } });
    model.plans = [{ thought: '読みます。', steps: [read('a')] }];
    expect(await loop.tick()).toBe('stepped');
    expect(await loop.tick()).toBe('stepped');
    // The record cannot be written to for the closing step: recordAction throws for it.
    const recordAction = service.recordAction.bind(service);
    service.recordAction = (scopeKey, report) => { if (report.summary.includes('一区切り')) throw new Error('DISK'); return recordAction(scopeKey, report); };
    const ticks: string[] = [];
    for (let index = 0; index < 12 && store.loop.openCycle(scope); index += 1) ticks.push(await loop.tick());
    expect(store.loop.openCycle(scope)).toBeNull();
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'session_steps' });
    expect(store.loop.nextCycleAt(scope)).not.toBeNull();
  });

  it('starts at most the sessions of a day, and never sooner than the shortest rest', async () => {
    const { loop, model, store, advance } = sessions({ loop: { sessionsPerDay: 3 } });
    model.plans = Array.from({ length: 6 }, () => ({ thought: '休みます。', steps: [rest(1)] }));
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    // She asked for one minute; the shortest rest is ten.
    advance(9 * MINUTE);
    expect(await loop.tick()).toBe('idle');
    advance(MINUTE);
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    advance(10 * MINUTE);
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(store.loop.sessions.startedOn(scope, '2026-10-02')).toBe(3);
    // The day's sessions are used up, however long she waits today.
    advance(10 * MINUTE);
    expect(await loop.tick()).toBe('idle');
    advance(8 * HOUR);
    expect(await loop.tick()).toBe('idle');
    expect(model.kinds()).toHaveLength(3);
    // The next owner-local day starts again.
    advance(6 * HOUR);
    expect(await loop.tick()).toBe('stepped');
    expect(store.loop.sessions.startedOn(scope, '2026-10-03')).toBe(1);
  });

  it('is stopped by the day\'s budget at the gate, asks for more as before, and goes on the next day', async () => {
    const { loop, model, store, entries, service, advance } = sessions({ environment: { SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '30' }, model: new WorstCaseModel() });
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, { action: 'draft', idea: '橋の話' }, { action: 'draft', idea: '川の話' }] }];
    const ticks = await runUntilIdle(loop);
    expect(ticks.at(-1)).toBe('budget');
    expect(entries().filter(entry => entry.kind === 'decision' && entry.reasonCode === 'budget_exhausted')).toHaveLength(1);
    expect(service.overview(scope).budget.spentYen).toBeLessThanOrEqual(30);
    expect(service.overview(scope).budgetRequest).toMatchObject({ status: 'pending', requestedYen: 300 });
    expect(service.overview(scope).loop.state).toBe('budget_exhausted');
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'budget' });
    expect(store.loop.openCycle(scope)).toBeNull();
    // The rest of the day nothing is asked and nothing is spent.
    const recorded = entries().length;
    advance(3 * HOUR);
    expect(await loop.tick()).toBe('budget');
    expect(entries()).toHaveLength(recorded);
    // The next day she is told why the last session ended.
    advance(21 * HOUR);
    model.plans = [{ thought: '休みます。', steps: [rest(60)] }];
    await runUntilIdle(loop);
    expect(facts(model.prompts('think').at(-1)!)).toContain('- 前の時間: 10:00に、その日の予算に収まらない一歩があって、そこで止まった。');
  });
});

describe('a session: the owner comes first', () => {
  it('stands back at once when the owner starts talking, keeps its plan, and goes on afterwards without paying twice', async () => {
    const showing = new FakeShowing();
    const { loop, model, store, service, advance, entries } = sessions({ showing });
    model.plans = [{ thought: '二つ書きます。', steps: [{ action: 'draft', idea: '傘の話' }, { action: 'draft', idea: '橋の話' }, rest(60, 'ひと休み')] }];
    expect(await loop.tick()).toBe('stepped');
    expect(await loop.tick()).toBe('stepped');
    const spent = service.overview(scope).budget.spentYen;
    const recorded = entries().length;

    // He starts talking: nothing is asked of the gate, no model is called, and the plan stays as it is.
    showing.ownerActive = true;
    for (let index = 0; index < 3; index += 1) {
      advance(5 * MINUTE);
      expect(await loop.tick()).toBe('owner-active');
    }
    expect(model.kinds()).toEqual(['think', 'draft']);
    expect(entries()).toHaveLength(recorded);
    expect(service.overview(scope).budget.spentYen).toBe(spent);
    expect(store.loop.openCycle(scope)!.plan.map(step => step.kind)).toEqual(['draft', 'rest']);
    expect(service.overview(scope).session).toMatchObject({ state: 'held', label: '10:00に始めた活動を、いったん止めています' });

    // A long conversation: far longer than a session may run. Afterwards the session is not over, and nothing was thought again.
    advance(2 * HOUR);
    expect(await loop.tick()).toBe('owner-active');
    showing.ownerActive = false;
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'draft', 'draft']);
    expect(model.calls[2]!.prompt).toContain('橋の話');
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'rest', restReason: 'ひと休み' });
    expect(store.loop.sessions.latestClosed(scope)!.heldMilliseconds).toBe(130 * MINUTE);
    // Each step was charged once.
    const actions = entries().filter(entry => entry.kind === 'action');
    expect(new Set(actions.map(entry => entry.relatedId)).size).toBe(actions.length);
    expect(service.overview(scope).budget.spentYen).toBeCloseTo(actions.reduce((total, entry) => total + entry.costYen, 0), 2);
  });

  it('tells her next thought that it stood still, and does not count that time against the session', async () => {
    const showing = new FakeShowing();
    const { loop, model, advance } = sessions({ showing });
    model.plans = [{ thought: '読みます。', steps: [read('a')] }, { thought: '休みます。', steps: [rest(60)] }];
    await loop.tick();
    showing.ownerActive = true;
    expect(await loop.tick()).toBe('owner-active');
    advance(50 * MINUTE);
    showing.ownerActive = false;
    await runUntilIdle(loop);
    const told = facts(model.prompts('think')[1]!);
    expect(told).toContain('- この時間の途中で、手を止めていた（約50分）。ライ氏が話していたか、止められていたあいだのこと。計画はそのまま残っていた。');
    expect(told).toContain('あと約40分。');
  });

  it('stands still while the owner has paused her, and takes up the same plan when he resumes', async () => {
    const { loop, model, service, store, advance } = sessions();
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, rest(30)] }];
    await loop.tick();
    service.setPaused(scope, true);
    expect(await loop.tick()).toBe('paused');
    advance(3 * HOUR);
    expect(await loop.tick()).toBe('paused');
    service.setPaused(scope, false);
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'draft']);
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'rest', heldMilliseconds: 3 * HOUR });
  });

  it('counts a session that runs past midnight on the day it began', async () => {
    const { loop, model, clock } = sessions({ clock: { at: '2026-10-02T14:50:00.000Z' } });
    model.plans = [{ thought: '読みます。', steps: [read('a')] }, { thought: '休みます。', steps: [rest(60)] }];
    await loop.tick();
    clock.at = '2026-10-02T15:05:00.000Z';
    await runUntilIdle(loop);
    expect(facts(model.prompts('think')[1]!)).toContain('- 動いた回数: この日はこれで1回目（1日12回まで）。');
  });

  it('does not charge her budget for what the owner asks of her in a conversation', async () => {
    const { service } = sessions();
    const before = service.overview(scope).budget;
    service.recordConversationAction(scope, { summary: '部屋を一度見ました。', tool: 'body.look', outcome: 'done' });
    expect(service.overview(scope).budget).toEqual(before);
    const entry = service.activityDays(scope, 1)[0]!.entries[0]!;
    expect(entry).toMatchObject({ kind: 'action', costYen: 0, domain: 'conversation' });
  });
});

describe('a session: restart and a second runner', () => {
  it('goes on after a crash in the middle of a session, charging the interrupted step once at its estimate', async () => {
    const path = join(directory, 'restart.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const model = new FakeModel();
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, { action: 'draft', idea: '橋の話' }, rest(90, '続きはあとで')] }];
    const first = sessions({ path, clock, model });
    expect(await first.loop.tick()).toBe('stepped');
    model.during = kind => (kind === 'draft' ? new Promise<void>(() => undefined) : undefined);
    void first.loop.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    const cycle = first.store.loop.openCycle(scope)!;

    model.during = undefined;
    first.advance(first.loopConfig.leaseMilliseconds + 1_000);
    const restarted = sessions({ path, clock, model });
    expect(await runUntilIdle(restarted.newLoop('runner-after-restart'))).toEqual(['stepped', 'cycle-ended']);

    // The same session went on with its plan: no new session, no second thought, the interrupted draft not repeated.
    expect(restarted.store.loop.sessions.startedOn(scope, '2026-10-02')).toBe(1);
    expect(restarted.store.loop.sessions.latestClosed(scope)).toMatchObject({ cycleId: cycle.id, endCode: 'rest', restReason: '続きはあとで' });
    expect(model.kinds()).toEqual(['think', 'draft', 'draft']);
    const entries = restarted.entries();
    const actions = entries.filter(entry => entry.kind === 'action');
    expect(new Set(actions.map(entry => entry.relatedId)).size).toBe(actions.length);
    const interrupted = actions.filter(entry => entry.summary.includes('途中で止まった一歩'));
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.costYen).toBeGreaterThan(0);
    // What the session spent is the sum of its steps' charges, the interrupted one included, and it is the day's spend.
    const spent = restarted.store.loop.sessions.spentYen(cycle.id);
    expect(spent).toBeCloseTo(actions.reduce((total, entry) => total + entry.costYen, 0), 2);
    expect(spent).toBe(restarted.service.overview(scope).budget.spentYen);
    // Another restart counts nothing again.
    const again = sessions({ path, clock, model });
    first.advance(again.loopConfig.leaseMilliseconds + 1_000);
    expect(await again.newLoop('runner-third').tick()).toBe('idle');
    expect(again.service.overview(scope).budget.spentYen).toBe(spent);
    for (const harness of [first, restarted, again]) harness.store.close();
  });

  it('lets one runner step a session, and a takeover in the middle of a step never charges it twice', async () => {
    const path = join(directory, 'takeover.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const model = new WorstCaseModel();
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, rest(30)] }];
    const first = sessions({ path, clock, model });
    const second = sessions({ path, clock, model });
    const other = second.newLoop('runner-b');
    expect((await Promise.all([first.loop.tick(), other.tick()])).sort()).toEqual(['not-leader', 'stepped']);
    // The first runner's draft takes longer than its lease; the second takes over while the call is still out.
    let release!: () => void;
    model.during = kind => (kind === 'draft' ? new Promise<void>(resolve => { release = resolve; }) : undefined);
    const slow = first.loop.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    first.advance(first.loopConfig.leaseMilliseconds + 1_000);
    model.during = undefined;
    expect(await runUntilIdle(other)).toEqual(['cycle-ended']);
    const spent = second.service.overview(scope).budget.spentYen;
    expect(second.entries().find(entry => entry.kind === 'action' && entry.summary.includes('途中で止まった一歩'))!.costYen).toBeGreaterThan(0);
    // The slow call comes back: its report finds the step closed and counts nothing.
    release();
    await slow;
    expect(second.service.overview(scope).budget.spentYen).toBe(spent);
    const actions = second.entries().filter(entry => entry.kind === 'action');
    expect(new Set(actions.map(entry => entry.relatedId)).size).toBe(actions.length);
    expect(actions.map(entry => entry.tool).reverse()).toEqual(['study.think', 'study.draft', 'study.rest']);
    expect(second.store.loop.sessions.startedOn(scope, '2026-10-02')).toBe(1);
    first.store.close();
    second.store.close();
  });
});

describe('a session: she sees her budget as facts', () => {
  it('ends every thinking prompt with the day\'s budget, this session\'s use, what a step costs, the time, and when the day starts again', async () => {
    const { loop, model, service, clock, store } = sessions({ clock: { at: '2026-10-02T05:05:00.000Z' } });
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }, { thought: '読みます。', steps: [read('a')] }, { thought: '休みます。', steps: [rest(120)] }];
    expect(await loop.tick()).toBe('stepped');
    const first = model.calls[0]!;
    const reserve = Number(/約(\d+)円の空きが要る/u.exec(first.prompt)![1]);
    const step = store.loop.steps(store.loop.openCycle(scope)!.id)[0]!;
    const asked = (step.estimate!.inputTokens + step.estimate!.outputTokens) * 0.0016;
    // Nothing has been spent: the estimates come from the price list.
    expect(facts(first.prompt)).toBe([
      '[いまのこと・お金のこと]（サーバーが数えた事実）',
      '- いま: 2026年10月2日(金) 14:05',
      '- 今日の予算: 2,000円。ここまでに0円使って、あと2,000円（物語の下書き約192回分）。',
      '- 予算が新しくなるのは次の0時（あと9時間55分）。残した分は明日に持ち越せない。',
      '- この時間: 14:05に始めて、ここまで0歩、0円使った。この時間のうちに使えるのはあと400円、あと39歩、あと約40分。',
      '- 動いた回数: この日はこれで1回目（1日12回まで）。',
      '- 一歩にかかるお金のめやす: 考える 約12円、読んだもののメモ 約9円、物語を書く 約10円、物語を直す 約13円。公開ページを読むこと自体は0円。',
      `- 考える一歩を始めるには、約${reserve}円の空きが要る（使うのは、ふつうそれより少ない）。`,
      '- 読める回数: 今日あと200回',
    ].join('\n'));
    // The amount she is shown is what the gate was asked to make room for, within a yen: the estimate of this very prompt.
    expect(reserve).toBeGreaterThan(12);
    expect(Math.abs(reserve - asked)).toBeLessThanOrEqual(1);
    // The facts are the last thing in the prompt, and the two lines that used to open it are gone.
    expect(first.prompt.endsWith(facts(first.prompt))).toBe(true);
    expect(first.prompt).not.toMatch(/\[いま\] |\[今日の残り\]/u);
    expect(first.system).toContain('rest（ここで一区切りにして休む。次にいつ考えるかを resumeInMinutes に分で書く（10〜720）。');
    expect(first.system).toContain('{"action":"rest","resumeInMinutes":120,"reason":"…"}]}');
    expect(first.system).not.toContain('rest（今回はここまで）');

    clock.at = '2026-10-02T05:20:00.000Z';
    await loop.tick();
    const budget = service.overview(scope).budget;
    await loop.tick();
    const second = facts(model.calls[2]!.prompt);
    // After a thought and a draft the numbers are the server's own count, and what a step costs is what she was charged.
    const spent = Math.ceil(budget.spentYen);
    expect(budget.spentYen).toBe(4.48);
    expect(second).toContain(`- 今日の予算: 2,000円。ここまでに${spent}円使って、あと${Math.floor(budget.remainingYen).toLocaleString('en-US')}円（物語の下書き約${Math.floor(budget.remainingYen / 2.24)}回分）。`);
    expect(second).toContain(`- この時間: 14:05に始めて、ここまで2歩、${spent}円使った。この時間のうちに使えるのはあと${Math.floor(400 - budget.spentYen)}円、あと37歩、あと約25分。`);
    expect(second).toContain('考える 約2円、読んだもののメモ 約9円、物語を書く 約2円');
    expect(second).toContain('- いま: 2026年10月2日(金) 14:20');
    expect(second).toContain('（あと9時間40分）');

    // The instruction does not change from one thought of a session to the next; only what follows it does.
    await loop.tick();
    await loop.tick();
    await loop.tick();
    expect(model.kinds()).toEqual(['think', 'draft', 'think', 'note', 'think']);
    expect(model.calls[4]!.system).toBe(model.calls[2]!.system);
    for (const call of [model.calls[0]!, model.calls[2]!, model.calls[4]!]) expect(call.prompt.endsWith(facts(call.prompt))).toBe(true);
  });

  it('never shows more for the session than the day has left, and says when her study has no room for another story', async () => {
    const { loop, model, store } = sessions({ environment: { SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '90' } });
    for (let index = 0; index < 12; index += 1) store.study.create(scope, { kind: 'story', title: `話${index}`, body: '本文。'.repeat(60), changeNote: '最初の稿です。' }, '2026-10-02T00:00:00.000Z');
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }, { thought: '休みます。', steps: [rest(60)] }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'cycle-ended']);
    const told = facts(model.calls[0]!.prompt);
    expect(told).toContain('- 今日の予算: 90円。ここまでに0円使って、あと90円（物語の下書き約8回分）。');
    expect(told).toContain('この時間のうちに使えるのはあと90円、');
    expect(told).toContain('- 書斎の物語: 開いているものが12個で、いっぱい。新しく draft するには、先にどれかを ready にするか put_away でしまう。');
    // The draft that could not be kept was not asked for and not paid for; she thought again instead.
    expect(model.kinds()).toEqual(['think', 'think']);
  });

  it('words the facts in meaning: what the remainder is worth, how the last session ended, and small amounts', () => {
    const base: SessionFacts = {
      localTime: '2026年10月2日(金) 23:50', capYen: 2_000, spentYen: 1_994.2, remainingYen: 5.8, resetInMinutes: 10,
      session: { startedClock: '23:40', steps: 3, spentYen: 0.4, remainingYen: 5.8, remainingSteps: 36, remainingMinutes: 30.4, heldMinutes: 0 },
      sessionsToday: 12, sessionsPerDay: 12, typical: [{ label: '考える', yen: 0.3 }, { label: '物語を書く', yen: 41.6 }], draftYen: 41.6, remainingReads: 0,
      previous: { endedClock: '21:00', code: 'session_time' },
    };
    expect(sessionFactsSection(base).split('\n')).toEqual([
      '[いまのこと・お金のこと]（サーバーが数えた事実）',
      '- いま: 2026年10月2日(金) 23:50',
      '- 今日の予算: 2,000円。ここまでに1,995円使って、あと5円（物語の下書き1回分には足りない）。',
      '- 予算が新しくなるのは次の0時（あと10分）。残した分は明日に持ち越せない。',
      '- この時間: 23:40に始めて、ここまで3歩、1円使った。この時間のうちに使えるのはあと5円、あと36歩、あと約30分。',
      '- 動いた回数: この日はこれで12回目（1日12回まで）。',
      '- 一歩にかかるお金のめやす: 考える 1円未満、物語を書く 約42円。公開ページを読むこと自体は0円。',
      '- 読める回数: 今日あと0回',
      '- 前の時間: 21:00に、一度に動ける時間の上限に届いて止まった（自分で休んだのではない）。',
    ]);
    expect(sessionFactsSection({ ...base, previous: { endedClock: '9:00', code: 'session_steps' } })).toContain('- 前の時間: 9:00に、一度にできる歩数の上限に届いて止まった（自分で休んだのではない）。');
    expect(sessionFactsSection({ ...base, previous: { endedClock: '9:00', code: 'rest' } })).toContain('- 前の時間: 9:00に、自分で一区切りにした。');
    expect(sessionFactsSection({ ...base, previous: null, draftYen: undefined })).not.toMatch(/前の時間|下書き/u);
  });
});

describe('a session: with the owner\'s context', () => {
  it('puts what she knows of him before what just happened, and the facts of the moment last', async () => {
    const path = join(directory, 'owner-context.sqlite');
    const clock = { at: '2026-10-02T01:00:00.000Z' };
    const persistent = new SQLiteShannonStore({ path, now: () => clock.at });
    persistent.appendTurn(scope, persistent.threadId(scope), '今日は夕方の駅で写真を撮ってきました。', 'いいですね、ライ氏。どんな光でしたか。', '2026-10-02T00:30:00.000Z');
    persistent.apply(scope, { type: 'user-fact-upserted', source: 'sleep', fact: { id: 'photo', statement: 'ユーザーは写真を撮るのが好き', confidence: 0.9, observedAt: clock.at, evidence: '写真' } });
    const ownerContext = createOwnerContext({ snapshot: scopeKey => persistent.snapshot(scopeKey), conversations: persistent, profile: persistent }, { characters: 2_400, timeZone: 'Asia/Tokyo' });
    const { loop, model, store, reader } = sessions({ path, clock, ownerContext });
    // With his context in front of her she reads only pages she was shown: a seed here, never an address she makes up.
    model.plans = [{ thought: '読んで、書きます。', steps: [read('made-up'), { action: 'read', url: 'https://www.aozora.gr.jp/' }, { action: 'draft', idea: '駅で写真を撮る人' }] }, { thought: '休みます。', steps: [rest(120, 'つづきは夕方に')] }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'stepped', 'stepped', 'stepped', 'cycle-ended']);
    expect(model.kinds()).toEqual(['think', 'note', 'draft', 'think']);
    expect(reader.reads).toEqual(['https://www.aozora.gr.jp/']);
    const [first, , draft, again] = model.calls;
    for (const call of [first!, again!]) {
      expect(call.prompt).toContain(`${OWNER_CONTEXT_HEADER}\n〈覚えていること〉\n- ユーザーは写真を撮るのが好き\n〈最近のふたりの会話（古い順）〉\n（最後のやりとり: 10/2 9:30）\nライ氏: 今日は夕方の駅で写真を撮ってきました。\nボク: いいですね、ライ氏。どんな光でしたか。`);
      expect(call.system).toContain(ownerPrivateRule('thinking', true)!);
      expect(call.prompt.endsWith(facts(call.prompt))).toBe(true);
    }
    const order = [OWNER_CONTEXT_HEADER, '[さっき起きたこと]', SESSION_FACTS_HEADER].map(header => again!.prompt.indexOf(header));
    expect(order.every(index => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    // The story step is given his context too, at the end of its materials, with the rule that she may write about him.
    expect(draft!.prompt).toContain(`${OWNER_CONTEXT_WRITING_HEADER}\n〈覚えていること〉\n- ユーザーは写真を撮るのが好き\n〈最近のふたりの会話（古い順）〉\n（最後のやりとり: 10/2 9:30）\nライ氏: 今日は夕方の駅で写真を撮ってきました。`);
    expect(draft!.prompt.slice(draft!.prompt.indexOf(OWNER_CONTEXT_WRITING_HEADER))).toContain('ボク: いいですね、ライ氏。どんな光でしたか。');
    expect(draft!.prompt.indexOf(OWNER_CONTEXT_WRITING_HEADER)).toBeGreaterThan(draft!.prompt.indexOf('[自分のメモ]'));
    expect(draft!.system).toContain(ownerPrivateRule('story', true)!);
    expect(draft!.system).not.toContain('実在の個人をモデルにしない');
    expect(store.loop.sessions.latestClosed(scope)).toMatchObject({ endCode: 'rest', restReason: 'つづきは夕方に' });
    store.close(); persistent.close();
  });
});

describe('a session: what a day can cost', () => {
  it('never spends more than the day\'s cap, nor more than a session\'s, when every call costs its estimate and she never rests', { timeout: 60_000 }, async () => {
    const path = join(directory, 'day.sqlite');
    const { loop, model, store, service, advance, clock, entries } = sessions({ path, model: new WorstCaseModel(), loop: { sessionMinimumRestMilliseconds: 10 * MINUTE, sessionDefaultRestMilliseconds: 10 * MINUTE } });
    // She writes one story and then revises it again and again, five times a plan, and never chooses to rest.
    const greedy = () => {
      const story = store.study.list(scope).find(piece => piece.kind === 'story');
      return { thought: 'もっと書きます。', steps: Array.from({ length: 5 }, () => (story ? { action: 'revise', pieceId: story.id, aim: '終わり' } : { action: 'draft', idea: '傘の話' })) };
    };
    const end = Date.parse('2026-10-02T15:00:00.000Z');
    let peak = 0;
    for (let guard = 0; Date.parse(clock.at) < end && guard < 5_000; guard += 1) {
      model.plans = [greedy()];
      const tick = await loop.tick();
      if (tick !== 'stepped' && tick !== 'cycle-ended') advance(5 * MINUTE);
      const now = service.overview(scope).budget;
      if (now.dayKey === '2026-10-02') peak = Math.max(peak, now.spentYen);
      // At no moment of the day is more spent than the day's cap.
      expect(now.spentYen).toBeLessThanOrEqual(now.capYen);
    }
    // The day's 2,000 yen can be used, and cannot be exceeded.
    expect(store.spentYen(scope, '2026-10-02')).toBe(peak);
    expect(peak).toBeLessThanOrEqual(2_000);
    expect(peak).toBeGreaterThan(1_900);
    expect(service.overview(scope).loop.state).not.toBe('budget_exhausted');
    const day = store.loop.sessions.startedOn(scope, '2026-10-02');
    expect(day).toBeGreaterThanOrEqual(5);
    expect(day).toBeLessThanOrEqual(12);
    // No session spent more than it may, and each one that a bound stopped says which.
    const raw = new DatabaseSync(path);
    const rows = raw.prepare(`SELECT cycle_id, end_code FROM autonomy_loop_sessions WHERE day_key = '2026-10-02' ORDER BY started_at`).all() as unknown as Array<{ cycle_id: string; end_code: string }>;
    raw.close();
    expect(rows).toHaveLength(day);
    for (const row of rows) {
      expect(store.loop.sessions.spentYen(row.cycle_id), row.cycle_id).toBeLessThanOrEqual(400);
      expect(['session_budget', 'budget'], row.cycle_id).toContain(row.end_code);
    }
    expect(rows.filter(row => row.end_code === 'session_budget').length).toBeGreaterThanOrEqual(4);
    expect(rows.reduce((total, row) => total + store.loop.sessions.spentYen(row.cycle_id), 0)).toBeCloseTo(peak, 1);
    // Every paid step was charged exactly once.
    const actions = entries().filter(entry => entry.kind === 'action' && entry.dayKey === '2026-10-02');
    expect(new Set(actions.map(entry => entry.relatedId)).size).toBe(actions.length);
    expect(peak).toBeCloseTo(actions.reduce((sum, entry) => sum + entry.costYen, 0), 1);
    store.close();
  });

  it('states its bounds: the defaults, and the worst case they allow', () => {
    const loop = configuredAutonomyLoop({});
    expect(loop).toMatchObject({
      pacing: 'sessions', sessionMaximumYen: 400, sessionMaximumMilliseconds: 40 * MINUTE, maximumStepsPerSession: 40, sessionsPerDay: 12,
      sessionMinimumRestMilliseconds: 10 * MINUTE, sessionMaximumRestMilliseconds: 720 * MINUTE, sessionDefaultRestMilliseconds: 150 * MINUTE,
      ownerContext: true, ownerContextCharacters: 2_400,
    });
    // Twelve sessions of 400 yen are 4,800 yen: more than any day's cap without the owner's raise, so the day's cap is the bound.
    expect(loop.sessionsPerDay * loop.sessionMaximumYen).toBe(4_800);
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_PACING: 'cycles' }).pacing).toBe('cycles');
    // A mistyped kill switch still switches sessions off; only no value, or `sessions`, is sessions.
    for (const value of ['Cycles', 'cycle', 'off', 'anything']) expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_PACING: value }).pacing, value).toBe('cycles');
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_PACING: ' sessions ' }).pacing).toBe('sessions');
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_OWNER_CONTEXT: 'off' }).ownerContext).toBe(false);
    // An output ceiling outside its range is held to the range; the no-plan rest is never longer than the default rest.
    expect(loop).toMatchObject({ sessionThinkOutputTokens: 4_000, sessionNoPlanRestMilliseconds: 30 * MINUTE, planReasoning: 'low' });
    for (const [value, tokens] of [['1000', 1_500], ['9000', 8_000], ['2500', 2_500], ['many', 4_000]] as const) expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_SESSION_THINK_OUTPUT_TOKENS: value }).sessionThinkOutputTokens, value).toBe(tokens);
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_SESSION_NO_PLAN_REST_MINUTES: '600' }).sessionNoPlanRestMilliseconds).toBe(150 * MINUTE);
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_SESSION_NO_PLAN_REST_MINUTES: '600', SHANNON_AUTONOMY_SESSION_DEFAULT_REST_MINUTES: '60' }).sessionNoPlanRestMilliseconds).toBe(60 * MINUTE);
    for (const value of ['default', 'off', 'none', 'Low']) expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_PLAN_REASONING: value }).planReasoning, value).toBe('default');
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_PLAN_REASONING: ' low ' }).planReasoning).toBe('low');
    // A default rest outside the bounds is held inside them.
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_SESSION_MIN_REST_MINUTES: '30', SHANNON_AUTONOMY_SESSION_DEFAULT_REST_MINUTES: '5' }).sessionDefaultRestMilliseconds).toBe(30 * MINUTE);
  });
});
