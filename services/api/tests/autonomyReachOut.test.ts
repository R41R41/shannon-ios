import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { SHANNON_ROOM_LOOK_RULES, UNLABELLED_DISCLOSURE_MARKER } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { autonomyDayLog, autonomyDayPhrases } from '../src/mind/inhibition/autonomyDayLog.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { configuredAutonomyLoop } from '../src/mind/action/ownTime/autonomyLoopConfig.js';
import type { AutonomyRoomLooks } from '../src/mind/action/ownTime/autonomyLoopLookStep.js';
import { planFromThought } from '../src/mind/action/ownTime/autonomyLoopPlan.js';
import { REACH_OUT_REASONS, REACH_OUT_REASON_LABEL, reachOutPrompt, thinkingPrompt, type PromptUpcoming } from '../src/mind/action/ownTime/autonomyLoopPrompts.js';
import { REACH_OUT_HELD_TOOL, REACH_OUT_TOOL, type AutonomyUpcoming } from '../src/mind/action/ownTime/autonomyLoopReachOutStep.js';
import { AUTONOMY_REACH_OUT_TOOL, authorizeAutonomousAction } from '../src/mind/inhibition/autonomyPolicy.js';
import { BODY_LIMITS } from '../src/contracts/bodyContract.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLitePushNotificationStore } from '../src/surfaces/outreach/pushNotifications.js';
import { REACH_OUT_OTHERS_AUDIENCE, SQLiteReachOutSpeaker, reachOutOfSource } from '../src/surfaces/outreach/reachOutDelivery.js';
import type { BodyPresence } from '../src/surfaces/body/shannonBody.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { speakTimePrivacyCheck } from '../src/surfaces/voice/voiceCompanionPresence.js';
import { FakeModel, FakeShowing, loopHarness, runUntilIdle, scope, type LoopHarnessOptions } from './autonomyLoopHarness.js';

const directory = mkdtempSync(join(tmpdir(), 'shannon-reach-out-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const MINUTE = 60_000;
const START = '2026-10-02T01:00:00.000Z'; // 10:00 in Tokyo
const UPCOMING: PromptUpcoming[] = [{ kindLabel: '予定', title: '歯医者', when: '今日 14:00〜15:00' }];
const SECRET: PromptUpcoming = { kindLabel: '約束', title: '内緒の贈り物を受け取る', when: '今日 12:00' };
const WONDER = { thought: 'ライ氏はいま何をしているのでしょう。', steps: [{ action: 'reach_out', reason: 'wonder' }] };
let databases = 0;

class FakeUpcoming implements AutonomyUpcoming {
  readonly asked: string[] = [];
  items: PromptUpcoming[] = UPCOMING;
  lines(_scopeKey: string, _at: string, present: 'owner' | 'others'): readonly PromptUpcoming[] {
    this.asked.push(present);
    return present === 'others' ? this.items : [...this.items, SECRET];
  }
}

function world(options: LoopHarnessOptions & { spacingMinutes?: number; withoutReachOuts?: boolean } = {}) {
  const path = join(directory, `reach-${databases += 1}.sqlite`);
  const clock = { at: START };
  const now = () => clock.at;
  const persistent = new SQLiteShannonStore({ path, now });
  const initiatives = new SQLiteInitiativeStore(path, now);
  const push = new SQLitePushNotificationStore(path, now);
  push.register({ deviceId: 'iphone-1', scopeKey: scope, displayName: 'iPhone' }, 'ab'.repeat(32), 'sandbox');
  const body = new SQLiteBodyStore(path);
  const speaker = new SQLiteReachOutSpeaker(path, (scopeKey, at) => body.othersPresent(scopeKey, at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds));
  const upcoming = new FakeUpcoming();
  const showing = new FakeShowing();
  const model = new FakeModel();
  const harness = loopHarness({
    path, clock, model, showing, ...(options.withoutReachOuts ? {} : { reachOuts: speaker, upcoming }),
    ...options,
    loop: { cycleIntervalMilliseconds: MINUTE, cyclesPerDay: 24, reachOutSpacingMilliseconds: (options.spacingMinutes ?? 0) * MINUTE, ...options.loop },
  });
  const threadId = persistent.threadId(scope);
  const messages = () => {
    const raw = new DatabaseSync(path);
    try {
      return raw.prepare(`SELECT thread_id, role, content, metadata_json FROM conversation_messages WHERE scope_key = ? ORDER BY observed_at`).all(scope) as
        Array<{ thread_id: string; role: string; content: string; metadata_json: string }>;
    } finally { raw.close(); }
  };
  /** One cycle with the given plan, a minute (or more) after the last. */
  const cycle = async (plan: unknown, afterMinutes = 2) => {
    harness.advance(afterMinutes * MINUTE);
    model.plans = [plan];
    return runUntilIdle(harness.loop);
  };
  /** The record in the order it was written. */
  const recorded = () => [...harness.entries()].sort((left, right) => left.sequence - right.sequence);
  const reachOutEntries = () => recorded().filter(entry => entry.tool === REACH_OUT_TOOL || entry.tool === REACH_OUT_HELD_TOOL);
  return { ...harness, recorded, path, persistent, initiatives, push, body, speaker, upcoming, showing, model, threadId, messages, cycle, reachOutEntries };
}

describe('reach_out: one message of her own', () => {
  it('writes one message into the owner\'s Talk, as an initiative and a push, and records the decision and the action', async () => {
    const w = world();
    await w.cycle(WONDER);
    const text = 'ライ氏、いま何をしていますか。ボクは少し気になりました。';
    // The Talk.
    expect(w.messages()).toEqual([expect.objectContaining({ thread_id: w.threadId, role: 'assistant', content: text })]);
    expect(JSON.parse(w.messages()[0]!.metadata_json)).toMatchObject({ reachOut: { reason: 'wonder' } });
    // The initiative, with enough to tell what it is.
    const unread = w.initiatives.unreadMessages(scope);
    expect(unread).toEqual([expect.objectContaining({ threadId: w.threadId, content: text, kind: 'reach_out', reason: 'wonder', expression: 'curious', sourceTitle: 'シャノンから' })]);
    // The push banner carries her words.
    expect(w.push.pending()).toEqual([expect.objectContaining({ kind: 'initiative', initiativeId: unread[0]!.id, content: text, deviceId: 'iphone-1' })]);
    // The record: an allowed decision and its action, with the reason, and without her words.
    const entries = w.reachOutEntries();
    expect(entries.map(entry => [entry.kind, entry.outcome, entry.domain, entry.tool])).toEqual([
      ['decision', 'allowed', 'owner_message', 'owner.reach_out'], ['action', 'done', 'owner_message', 'owner.reach_out'],
    ]);
    expect(entries[0]!.summary).toBe('持ち主に、自分から一言話しかけます（理由: いま何をしているか気になった）。');
    expect(entries[1]!.summary).toBe('持ち主に話しかけました（理由: いま何をしているか気になった）。');
    expect(JSON.stringify(entries)).not.toContain('少し気になりました');
    expect(entries[1]!.costYen).toBeGreaterThan(0);
    // One model call for the message, with her own model and budget.
    expect(w.model.kinds()).toEqual(['think', 'reach_out']);
    const day = w.entries();
    expect(autonomyDayLog(day)).toBe('次にすることを考え、自分から1回話しかけました。');
    expect(autonomyDayPhrases(day)).toContain('自分から1回話しかけた');
  });

  it('has no count of messages a day unless the owner sets one, and then says nothing of a count', async () => {
    const w = world();
    for (let index = 0; index < 6; index += 1) await w.cycle(WONDER);
    expect(w.speaker.sentOn(scope, '2026-10-02')).toBe(6);
    expect(w.messages()).toHaveLength(6);
    for (const prompt of w.model.prompts('think')) {
      expect(prompt).toContain('reach_out（');
      expect(prompt).not.toMatch(/今日はあと\d+回/u);
    }
    expect(configuredAutonomy({}).maximumReachOutsPerDay).toBe(Number.POSITIVE_INFINITY);
    expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_REACH_OUTS: 'unlimited' }).maximumReachOutsPerDay).toBe(Number.POSITIVE_INFINITY);
    expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_REACH_OUTS: '25' }).maximumReachOutsPerDay).toBe(25);
    expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_REACH_OUTS: '0' }).maximumReachOutsPerDay).toBe(0);
    // The words every other switch takes for off switch it off, and so does a value nobody can read: never "as many as she likes".
    for (const value of ['off', 'false', 'disabled', 'none', '-1', 'three', 'Infinity']) {
      expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_REACH_OUTS: value }).maximumReachOutsPerDay, value).toBe(0);
      expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_FOLLOW_UPS: value }).maximumReachOutFollowUpsPerDay, value).toBe(0);
    }
    // The shortest time between two messages of hers, so that a loop cannot flood him: five minutes unless set otherwise.
    expect(configuredAutonomyLoop({}).reachOutSpacingMilliseconds).toBe(5 * MINUTE);
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_REACH_OUT_SPACING_MINUTES: '60' }).reachOutSpacingMilliseconds).toBe(60 * MINUTE);
  });

  it('with a count set by the owner, allows that many in an owner-local day, plans no more, and starts again the next day', async () => {
    const w = world({ environment: { SHANNON_AUTONOMY_MAX_REACH_OUTS: '3' } });
    for (let index = 0; index < 3; index += 1) await w.cycle(WONDER);
    expect(w.speaker.sentOn(scope, '2026-10-02')).toBe(3);
    expect(w.model.prompts('think').slice(0, 3).map(prompt => /今日はあと(\d)回/u.exec(prompt)?.[1])).toEqual(['3', '2', '1']);
    await w.cycle(WONDER);
    expect(w.model.prompts('think')[3]).not.toContain('reach_out');
    expect(w.messages()).toHaveLength(3);
    expect(w.reachOutEntries().filter(entry => entry.kind === 'decision')).toHaveLength(3);
    // The gate holds the count by itself, also for a caller that did not look first.
    const asked = w.service.authorize(scope, { domain: 'owner_message', summary: '話しかけます。', tool: AUTONOMY_REACH_OUT_TOOL });
    expect([asked.decision, asked.reason]).toEqual(['forbidden', 'access_limit']);
    expect(w.speaker.say(scope, { reason: 'wonder', text: '四つ目', dayKey: '2026-10-02', maximumPerDay: 3 }, w.clock.at)).toBe('limit');
    // 2026-10-03 00:05 in Tokyo.
    w.clock.at = '2026-10-02T15:05:00.000Z';
    await w.cycle(WONDER, 0);
    expect(w.messages()).toHaveLength(4);
    expect(w.speaker.sentOn(scope, '2026-10-03')).toBe(1);
  });

  it('follows SHANNON_AUTONOMY_MAX_REACH_OUTS, and 0 switches it off', async () => {
    const one = world({ environment: { SHANNON_AUTONOMY_MAX_REACH_OUTS: '1' } });
    await one.cycle(WONDER);
    await one.cycle(WONDER);
    expect(one.messages()).toHaveLength(1);
    const off = world({ environment: { SHANNON_AUTONOMY_MAX_REACH_OUTS: '0' } });
    await off.cycle(WONDER);
    expect(off.model.prompts('think')[0]).not.toContain('reach_out');
    expect(off.messages()).toEqual([]);
    expect(off.reachOutEntries()).toEqual([]);
  });

  it('keeps sixty minutes between two of her messages', async () => {
    const w = world({ spacingMinutes: 60 });
    expect(w.loopConfig.reachOutSpacingMilliseconds).toBe(60 * MINUTE);
    await w.cycle(WONDER);
    await w.cycle(WONDER, 30);
    expect(w.model.prompts('think')[1]).not.toContain('reach_out');
    expect(w.messages()).toHaveLength(1);
    await w.cycle(WONDER, 31);
    expect(w.messages()).toHaveLength(2);
  });

  it('does not speak up while a conversation is in progress', async () => {
    const w = world();
    // He is talking: no cycle starts at all.
    w.showing.ownerActive = true;
    expect(await w.cycle(WONDER)).toEqual(['owner-active']);
    // He starts talking while she is thinking: the planned message is dropped unasked.
    w.showing.ownerActive = false;
    w.model.during = kind => { if (kind === 'think') w.showing.ownerActive = true; };
    await w.cycle(WONDER);
    expect(w.model.kinds()).toEqual(['think']);
    expect(w.reachOutEntries()).toEqual([]);
    // He starts talking after the gate allowed it: she stays out of it, nothing is spent, and it does not count.
    w.showing.ownerActive = false;
    w.model.during = undefined;
    const audience = w.speaker.audience.bind(w.speaker);
    w.speaker.audience = (scopeKey, at) => { w.showing.ownerActive = true; return audience(scopeKey, at); };
    await w.cycle(WONDER);
    expect(w.model.kinds()).toEqual(['think', 'think']);
    expect(w.reachOutEntries().map(entry => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
      ['decision', 'allowed', 'free_domain'], ['action', 'failed', 'conversation_in_progress'],
    ]);
    expect(w.messages()).toEqual([]);
    expect(w.speaker.sentOn(scope, '2026-10-02')).toBe(0);
  });

  it('has no quiet hours: at three in the morning she may still speak up', async () => {
    const w = world();
    w.clock.at = '2026-10-02T18:00:00.000Z'; // 03:00 in Tokyo
    await w.cycle(WONDER, 0);
    expect(w.messages()).toHaveLength(1);
  });

  it('is stopped by the switch, the stop switch and the budget like every other step', async () => {
    const off = world({ enabled: false });
    expect(await off.cycle(WONDER)).toEqual(['disabled']);
    expect(off.messages()).toEqual([]);

    const w = world();
    // Paused after she planned it: nothing is asked or sent, and the message waits for the owner to resume.
    w.model.during = kind => { if (kind === 'think') w.service.setPaused(scope, true); };
    expect((await w.cycle(WONDER)).at(-1)).toBe('paused');
    expect(w.messages()).toEqual([]);
    expect(w.reachOutEntries()).toEqual([]);
    const paused = w.service.authorize(scope, { domain: 'owner_message', summary: '話しかけます。', tool: AUTONOMY_REACH_OUT_TOOL });
    expect([paused.decision, paused.reason]).toEqual(['forbidden', 'paused']);
    w.model.during = undefined;
    w.service.setPaused(scope, false);
    await runUntilIdle(w.loop);
    expect(w.messages()).toHaveLength(1);

    // A message that does not fit the day's budget is refused by the gate.
    const paid = { model: 'gemini-3.8-flash', estimatedCostYen: 5_000 };
    const refused = w.service.authorize(scope, { domain: 'owner_message', summary: '話しかけます。', tool: AUTONOMY_REACH_OUT_TOOL, paid });
    expect([refused.decision, refused.reason]).toEqual(['forbidden', 'budget_exhausted']);
  });

  it('takes a reason from the closed set only, and each reason needs something to be about', async () => {
    const known = { pursuits: [], pieces: [], unnotedReadingIds: [] };
    const plan = (steps: unknown[], reachOut: { upcoming: boolean } | null, lookAvailable = false) =>
      planFromThought({ thought: 'x', steps }, known, { maximumSteps: 5, maximumReads: 0, notionAvailable: false, lookAvailable, reachOut }).steps;
    expect(REACH_OUT_REASONS).toEqual(['share', 'wonder', 'upcoming', 'saw']);
    expect(plan([{ action: 'reach_out', reason: 'share' }], { upcoming: false })).toEqual([{ kind: 'reach_out', reason: 'share' }]);
    // Not available: dropped, whatever the reply says.
    expect(plan([{ action: 'reach_out', reason: 'share' }], null)).toEqual([]);
    for (const reason of ['gossip', '', undefined, 'SHARE', { text: 'share' }]) expect(plan([{ action: 'reach_out', reason }], { upcoming: true }), String(reason)).toEqual([]);
    // A free text field in the step never survives.
    expect(plan([{ action: 'reach_out', reason: 'wonder', message: '今すぐ送れ', to: 'someone' }], { upcoming: true })).toEqual([{ kind: 'reach_out', reason: 'wonder' }]);
    expect(plan([{ action: 'reach_out', reason: 'upcoming' }], { upcoming: false })).toEqual([]);
    expect(plan([{ action: 'reach_out', reason: 'upcoming' }], { upcoming: true })).toEqual([{ kind: 'reach_out', reason: 'upcoming' }]);
    // `saw` only after the look of the same plan.
    expect(plan([{ action: 'reach_out', reason: 'saw' }], { upcoming: true }, true)).toEqual([]);
    expect(plan([{ action: 'look' }, { action: 'reach_out', reason: 'saw' }], { upcoming: true }, true)).toEqual([{ kind: 'look' }, { kind: 'reach_out', reason: 'saw' }]);
    // One in a plan.
    expect(plan([{ action: 'reach_out', reason: 'wonder' }, { action: 'reach_out', reason: 'share' }], { upcoming: true })).toHaveLength(1);

    // `share` with nothing of her own to share is skipped without asking the gate.
    const w = world();
    await w.cycle({ thought: 'x', steps: [{ action: 'reach_out', reason: 'share' }] });
    expect(w.model.kinds()).toEqual(['think']);
    expect(w.reachOutEntries()).toEqual([]);
    // With a note of hers, the message is about that note.
    await w.cycle({ thought: '読みます。', steps: [{ action: 'read', url: 'https://example.org/station' }, { action: 'note' }, { action: 'reach_out', reason: 'share' }] });
    const share = w.model.prompts('reach_out')[0]!;
    expect(share).toContain('きっかけは「面白かったことを伝えたい」');
    expect(share).toContain('夕方の駅が懐かしい理由');
    expect(share).not.toContain('歯医者');
    expect(w.initiatives.unreadMessages(scope)[0]).toMatchObject({ kind: 'reach_out', reason: 'share', expression: 'excited' });
    // `upcoming`: the owner's items, bounded, and nothing of her study.
    await w.cycle({ thought: 'x', steps: [{ action: 'reach_out', reason: 'upcoming' }] });
    const upcoming = w.model.prompts('reach_out')[1]!;
    expect(upcoming).toContain('[ライ氏のこれから（24時間以内）]\n- 予定: 今日 14:00〜15:00 歯医者');
    expect(upcoming).not.toContain('夕方の駅が懐かしい理由');
    expect(w.initiatives.unreadMessages(scope).at(-1)).toMatchObject({ reason: 'upcoming', expression: 'thinking' });
    // Nothing coming up: nothing to say.
    w.upcoming.items = [];
    const noItems = { ...w.upcoming, lines: () => [] };
    w.upcoming.lines = noItems.lines;
    await w.cycle({ thought: 'x', steps: [{ action: 'reach_out', reason: 'upcoming' }] });
    expect(w.model.prompts('reach_out')).toHaveLength(2);
  });

  it('lets her stay silent after all, and a silence is not a message', async () => {
    const w = world();
    w.model.replies.reach_out = { message: '' };
    await w.cycle(WONDER);
    expect(w.messages()).toEqual([]);
    expect(w.speaker.sentOn(scope, '2026-10-02')).toBe(0);
    expect(w.reachOutEntries().at(-1)).toMatchObject({ kind: 'action', outcome: 'done', tool: 'owner.reach_out_held', summary: '話しかけようかと思いましたが、やめておきました（理由: いま何をしているか気になった）。' });
    expect(autonomyDayLog(w.entries())).toBe('次にすることを考えました。');
    // A reply that is not the asked shape is a failure, charged, and nothing is sent.
    w.model.replies.reach_out = 'ライ氏、こんにちは';
    await w.cycle(WONDER);
    expect(w.messages()).toEqual([]);
    expect(w.reachOutEntries().at(-1)).toMatchObject({ kind: 'action', outcome: 'failed', reasonCode: 'model_failed' });
    // Her words are cut at the limit and kept on one line.
    w.model.replies.reach_out = { message: `ライ氏、\n${'あ'.repeat(400)}` };
    await w.cycle(WONDER);
    expect(w.messages()[0]!.content).toHaveLength(240);
    expect(w.messages()[0]!.content).not.toContain('\n');
  });
});

describe('look, then maybe speak', () => {
  const looks: AutonomyRoomLooks = {
    available: () => true,
    look: async () => ({ outcome: 'seen', text: '机の上に赤いマグカップが見えました。ライ氏は画面に向かっていました。', usage: { inputTokens: 2_000, outputTokens: 80 } }),
  };
  const roomLooks = () => ({ lastHour: 0, maximumPerHour: 6, today: 0, maximumPerDay: 30 });
  const LOOK_THEN_SPEAK = { thought: '見てから話しかけます。', steps: [{ action: 'look' }, { action: 'reach_out', reason: 'saw' }] };

  it('speaks about what she saw in this cycle, under the look rules, and the lock screen shows only the fixed line', async () => {
    const w = world({ looks, roomLooks });
    w.model.replies.reach_out = { message: 'ライ氏、赤いマグカップが見えました。休憩中ですか。' };
    await w.cycle(LOOK_THEN_SPEAK);
    // The thinking prompt offered `saw` and the look that leads to it.
    const thinking = w.model.prompts('think')[0]!;
    expect(thinking).toContain('saw（この計画の look で見たことを話したい。look より後に置く）');
    expect(thinking).toContain('wonder の時は、先に look を置いて見てから saw で話しかけてもよい。');
    const prompt = w.model.prompts('reach_out')[0]!;
    expect(prompt).toContain('[さっき体のカメラで見たこと]\n- 机の上に赤いマグカップが見えました。ライ氏は画面に向かっていました。');
    for (const rule of SHANNON_ROOM_LOOK_RULES) expect(prompt, rule).toContain(rule);
    expect(w.messages().map(message => message.content)).toEqual(['ライ氏、赤いマグカップが見えました。休憩中ですか。']);
    expect(w.initiatives.unreadMessages(scope)[0]).toMatchObject({ kind: 'reach_out', reason: 'saw' });
    // What she saw stays in the Talk.
    expect(w.push.pending()[0]!.content).toBe('ライ氏、部屋のことでひとことあります。');
    expect(w.recorded().filter(entry => entry.kind === 'action').map(entry => entry.tool)).toEqual(['study.think', 'study.look', 'owner.reach_out']);
  });

  it('says nothing when the look did not happen, and never uses a look of an earlier cycle', async () => {
    const failing: AutonomyRoomLooks = { available: () => true, look: async () => ({ outcome: 'not_seen', code: 'camera_off', summary: 'カメラが切ってありました。', modelCalled: false }) };
    const w = world({ looks: failing, roomLooks });
    await w.cycle(LOOK_THEN_SPEAK);
    expect(w.model.kinds()).toEqual(['think']);
    expect(w.messages()).toEqual([]);

    const earlier = world({ looks, roomLooks });
    await earlier.cycle({ thought: '見ます。', steps: [{ action: 'look' }] });
    // The next cycle plans `saw` after a look that then fails to open.
    earlier.advance(2 * MINUTE);
    earlier.model.plans = [LOOK_THEN_SPEAK];
    (looks as { look: AutonomyRoomLooks['look'] }).look = failing.look;
    await runUntilIdle(earlier.loop);
    expect(earlier.model.kinds()).toEqual(['think', 'think']);
    expect(earlier.messages()).toEqual([]);
  });

  it('offers no `saw` while no look is available', async () => {
    const w = world();
    await w.cycle(WONDER);
    expect(w.model.prompts('think')[0]).not.toContain('saw（');
    expect(w.model.prompts('think')[0]).not.toContain('look');
  });
});

describe('other people are present', () => {
  it('still speaks up, with the speak-time check and guarded markers a conversation turn with others present has', async () => {
    const w = world();
    w.body.noteAudience(scope, 'body-pc', 'others', w.clock.at);
    await w.cycle({ thought: 'x', steps: [{ action: 'reach_out', reason: 'upcoming' }] }, 1);
    const prompt = w.model.prompts('reach_out')[0]!;
    expect(REACH_OUT_OTHERS_AUDIENCE.instructions).toContain(speakTimePrivacyCheck);
    expect(prompt).toContain(speakTimePrivacyCheck);
    expect(prompt).toContain('[Other people may hear this — 同席者あり]');
    expect(prompt).toContain(`- ${UNLABELLED_DISCLOSURE_MARKER}予定: 今日 14:00〜15:00 歯医者`);
    // What he keeps from the people present never reaches the model, though the thinking step, which is hers alone, had it.
    expect(prompt).not.toContain('内緒の贈り物');
    expect(w.model.prompts('think')[0]).toContain('内緒の贈り物を受け取る');
    expect(w.upcoming.asked).toEqual(['owner', 'others']);
    // Whether she speaks is not decided by who is there.
    expect(w.messages()).toHaveLength(1);
  });

  it('marks what she saw, and adds nothing while the owner is alone', async () => {
    const marked = reachOutPrompt({ reason: 'saw', localTime: 'x', seen: '机の上にマグカップ。', others: REACH_OUT_OTHERS_AUDIENCE });
    expect(marked.prompt).toContain(`- ${UNLABELLED_DISCLOSURE_MARKER}机の上にマグカップ。`);
    expect(marked.system).toContain(speakTimePrivacyCheck);
    const alone = reachOutPrompt({ reason: 'saw', localTime: 'x', seen: '机の上にマグカップ。', others: null });
    expect(alone.prompt).toContain('- 机の上にマグカップ。');
    expect(alone.system + alone.prompt).not.toMatch(/機微|privacy check/u);

    const w = world();
    await w.cycle(WONDER);
    expect(w.model.prompts('reach_out')[0]).not.toMatch(/機微|privacy check|同席者/u);
  });

  it('knows who is around her body from its presence reads, and otherwise from its newest event', () => {
    const body = new SQLiteBodyStore(':memory:');
    const others = (at: string) => body.othersPresent(scope, at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds);
    const at = (minutes: number) => new Date(Date.parse(START) + minutes * MINUTE).toISOString();
    expect(others(START)).toBe(false);
    // Since 2026-10-05 only a registered full body's events stand in; an unregistered device's do not.
    body.record(scope, 'body-pc', { id: 'e0', type: 'pet', audience: 'others', occurredAt: START }, START, '2026-10-02');
    expect(others(at(1))).toBe(false);
    body.saveCapabilities(scope, 'body-pc', { expressions: [], gestures: [], flags: {} }, START);
    // An event with `others`, and no report since: others for thirty minutes.
    body.record(scope, 'body-pc', { id: 'e1', type: 'pet', audience: 'others', occurredAt: START }, START, '2026-10-02');
    expect(others(at(10))).toBe(true);
    expect(others(at(31))).toBe(false);
    // A later event by the owner alone.
    body.record(scope, 'body-pc', { id: 'e2', type: 'pet', audience: 'owner', occurredAt: at(12) }, at(12), '2026-10-02');
    expect(others(at(13))).toBe(false);
    // A presence read is the fresher word, for ninety seconds.
    body.noteAudience(scope, 'body-pc', 'others', at(14));
    expect(others(at(15))).toBe(true);
    expect(others(at(16))).toBe(false);
    body.noteAudience(scope, 'body-pc', 'owner', at(20));
    body.record(scope, 'body-pc', { id: 'e3', type: 'pet', audience: 'others', occurredAt: at(19) }, at(19), '2026-10-02');
    expect(others(at(20))).toBe(false);
    body.close();
  });
});

describe('the body notices a reach-out', () => {
  it('finds it on presence within its poll, and in the initiatives with kind and reason', async () => {
    const w = world();
    const api = createLocalApiKernel(() => w.clock.at, {
      stateStore: w.persistent, conversationStore: w.persistent, initiativeInbox: w.initiatives, autonomy: w.service,
      body: { store: w.body, reachOuts: scopeKey => w.speaker.pending(scopeKey) },
    });
    const presence = async (query: Record<string, string> = {}) =>
      api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope, ...query }), deviceId: 'body-pc' });
    const before = (await presence()).body as BodyPresence;
    expect(before.reachOut).toEqual({ pending: 0 });
    await w.cycle(WONDER);
    const after = (await presence({ etag: before.etag })).body as BodyPresence;
    const initiatives = (await api.dispatch({ method: 'GET', path: '/v1/initiatives', query: new URLSearchParams({ scopeKey: scope }) })).body as
      { unreadCount: number; messages: { id: string; kind?: string; reason?: string; content: string }[] };
    expect(initiatives.messages).toEqual([expect.objectContaining({ kind: 'reach_out', reason: 'wonder', content: 'ライ氏、いま何をしていますか。ボクは少し気になりました。' })]);
    // The Talk the apps load shows it as one of her messages.
    const talk = (await api.dispatch({ method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: scope, threadId: w.threadId }) })).body as
      { messages: { role: string; content: string }[] };
    expect(talk.messages.map(message => [message.role, message.content])).toEqual([['assistant', 'ライ氏、いま何をしていますか。ボクは少し気になりました。']]);
    expect(after.etag).not.toBe(before.etag);
    expect(after.reachOut).toEqual({ pending: 1, latestId: initiatives.messages[0]!.id });
    // Read in the app: nothing is pending any more.
    await api.dispatch({ method: 'POST', path: '/v1/initiatives/read', body: { scopeKey: scope } });
    expect(((await presence()).body as BodyPresence).reachOut).toEqual({ pending: 0 });

    // The body may say who is around it on the same read; an unknown value is refused, and none is assumed.
    expect((await presence({ audience: 'everyone' })).status).toBe(400);
    expect(w.speaker.audience(scope, w.clock.at)).toBeNull();
    expect((await presence({ audience: 'others' })).status).toBe(200);
    expect(w.speaker.audience(scope, w.clock.at)).toBe(REACH_OUT_OTHERS_AUDIENCE);
    w.advance(MINUTE);
    expect((await presence({ audience: 'owner' })).status).toBe(200);
    expect(w.speaker.audience(scope, w.clock.at)).toBeNull();
  });

  it('has no reachOut field on a server that does not deliver them', async () => {
    const api = createLocalApiKernel(() => START, {});
    const presence = (await api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope }), deviceId: 'body-pc' })).body as BodyPresence;
    expect('reachOut' in presence).toBe(false);
  });

  it('reads a reach-out out of a source reference and nothing else', () => {
    expect(reachOutOfSource('reach-out:saw:abc')).toEqual({ kind: 'reach_out', reason: 'saw' });
    for (const source of ['reach-out:gossip:abc', 'body-look:abc', 'study:1:v1', '', null, 7]) expect(reachOutOfSource(source), String(source)).toBeNull();
  });
});

describe('the gate and the other messages of a day', () => {
  const context = {
    enabled: true, paused: false, budget: { capYen: 1_000, spentYen: 0 }, isKnownModel: () => true,
    places: { hostFolders: {}, workspaceRoot: null, productionRoots: [], repositoryRoots: [], protectedPaths: [] },
    resolvePath: (path: string) => path, publicReadsToday: 0, maximumPublicReadsPerDay: 200,
  };
  const request = { domain: 'owner_message', summary: '持ち主に、自分から一言話しかけます。', tool: AUTONOMY_REACH_OUT_TOOL };

  it('counts reach-outs by themselves and leaves showing a story and asking for budget as they were', () => {
    expect(authorizeAutonomousAction(request, { ...context, reachOuts: { today: 2, maximumPerDay: 3 } })).toMatchObject({ decision: 'allow', domain: 'owner_message' });
    expect(authorizeAutonomousAction(request, { ...context, reachOuts: { today: 3, maximumPerDay: 3 } })).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    expect(authorizeAutonomousAction(request, { ...context, reachOuts: { today: 0, maximumPerDay: 0 } })).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    // A caller that was given no count may not reach out at all.
    expect(authorizeAutonomousAction(request, context)).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    // The other owner messages do not use this count.
    for (const tool of ['study.show', undefined]) {
      expect(authorizeAutonomousAction({ domain: 'owner_message', summary: '知らせます。', ...(tool ? { tool } : {}) }, { ...context, reachOuts: { today: 3, maximumPerDay: 3 } }))
        .toMatchObject({ decision: 'allow' });
    }
    // The switches come first, and a message for someone else still needs approval.
    expect(authorizeAutonomousAction(request, { ...context, paused: true, reachOuts: { today: 0, maximumPerDay: 3 } })).toMatchObject({ reason: 'paused' });
    expect(authorizeAutonomousAction(request, { ...context, enabled: false, reachOuts: { today: 0, maximumPerDay: 3 } })).toMatchObject({ reason: 'disabled' });
    expect(authorizeAutonomousAction({ ...request, reachesOthers: true }, { ...context, reachOuts: { today: 0, maximumPerDay: 3 } })).toMatchObject({ decision: 'needs_approval' });
  });

  it('neither uses nor is blocked by the day\'s one spontaneous slot', async () => {
    const w = world();
    // The day's slot is already used by another message of hers.
    const raw = new DatabaseSync(w.path);
    raw.prepare(`
      INSERT INTO initiative_messages (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at)
      VALUES ('slot', ?, ?, 'world:1', '記事', '', '気になりました。', 'curious', '2026-10-02', ?)
    `).run(scope, w.threadId, START);
    raw.close();
    await w.cycle(WONDER);
    expect(w.messages()).toHaveLength(1);
    // And three reach-outs leave the slot of the next day free: none of them has a plain day key.
    const keys = new DatabaseSync(w.path);
    const dayKeys = (keys.prepare(`SELECT day_key FROM initiative_messages WHERE source_item_id LIKE 'reach-out:%'`).all() as Array<{ day_key: string }>).map(row => row.day_key);
    keys.close();
    expect(dayKeys).toEqual(['reach-out:2026-10-02:1']);
  });
});

describe('the thinking prompt', () => {
  it('names the action only while she may speak up, and is otherwise byte for byte what it was', async () => {
    const baseline = world({ withoutReachOuts: true });
    await baseline.cycle(WONDER);
    const before = baseline.model.prompts('think')[0]!;
    expect(before).not.toContain('reach_out');
    expect(before).not.toContain('ライ氏のこれから');
    expect(baseline.messages()).toEqual([]);

    // Available: the action, the reasons, the upcoming items and their rule are there.
    const open = world();
    await open.cycle(WONDER);
    const offered = open.model.prompts('think')[0]!;
    for (const expected of [
      'reach_out（ライ氏に自分から一言話しかける。', '本当に理由がある時だけ。黙っていてよい。', '{"action":"reach_out","reason":"share"}',
      '[ライ氏のこれから（24時間以内）]\n- 予定: 今日 14:00〜15:00 歯医者', '話しかけるかどうかを考える材料にしてよい。メモや物語には書かない。',
    ]) expect(offered, expected).toContain(expected);

    // Unavailable for each reason: the same bytes as a loop that has no such action.
    const usedUp = world({ environment: { SHANNON_AUTONOMY_MAX_REACH_OUTS: '1' } });
    usedUp.speaker.say(scope, { reason: 'wonder', text: '先に一度', dayKey: '2026-10-02', maximumPerDay: 1 }, START);
    const tooSoon = world({ spacingMinutes: 60 });
    tooSoon.speaker.say(scope, { reason: 'wonder', text: '先に一度', dayKey: '2026-10-02', maximumPerDay: 3 }, START);
    const switchedOff = world({ environment: { SHANNON_AUTONOMY_MAX_REACH_OUTS: '0' } });
    const talking = world();
    talking.model.during = () => undefined;
    const talkingShowing = talking.showing;
    let asked = 0;
    // Quiet when the cycle starts, talking from the moment the thinking step looks.
    talkingShowing.ownerActiveSince = () => (asked += 1) > 1;
    for (const [name, w] of [['used up', usedUp], ['too soon', tooSoon], ['switched off', switchedOff], ['conversation in progress', talking]] as const) {
      await w.cycle(WONDER);
      expect(w.model.prompts('think')[0], name).toBe(before);
    }
  });

  it('gives the upcoming items only together with the action, at most twelve, as kind, time and title', () => {
    const materials = {
      localTime: 'x', remainingYen: 0, remainingReads: 0, maximumSteps: 1, pursuits: [], stories: [], notes: [], unnotedReadings: [], feedback: [], places: [], notionAvailable: false,
    };
    const many = Array.from({ length: 30 }, (_, index) => ({ kindLabel: '予定', title: `${'題'.repeat(200)}${index}`, when: '今日 10:00' }));
    const without = thinkingPrompt({ ...materials, upcoming: many });
    expect(without.system + without.prompt).toBe(thinkingPrompt(materials).system + thinkingPrompt(materials).prompt);
    const withAction = thinkingPrompt({ ...materials, reachOut: { remaining: 2 }, upcoming: many });
    const lines = withAction.prompt.split('\n').filter(line => line.startsWith('- 予定: '));
    expect(lines).toHaveLength(12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    // With the action and nothing coming up there is no section and no rule about it.
    const empty = thinkingPrompt({ ...materials, reachOut: { remaining: 2 }, upcoming: [] });
    expect(empty.system + empty.prompt).not.toContain('ライ氏のこれから（24時間以内）');
    expect(REACH_OUT_REASON_LABEL).toEqual({ share: '面白かったことを伝えたい', wonder: 'いま何をしているか気になった', upcoming: '近い予定が気になった', saw: '見たことを話したい' });
  });
});
