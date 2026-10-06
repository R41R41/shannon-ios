import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { executeConversationCommand } from '../src/conversationCommands.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { nextInitiativeDelayMilliseconds } from '../src/initiativeSchedule.js';
import { extractProspectiveMemories } from '../src/mind/memory/prospectiveMemory.js';
import { resolveReminderReply } from '../src/reminderReply.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteWorldStore } from '../src/integrations/world/store/worldStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

// Said on Thursday 2026-09-24 at 10:00 in Tokyo; "tomorrow" is 2026-09-25.
const saidAt = '2026-09-24T01:00:00.000Z';
const sevenNextDay = '2026-09-24T22:00:00.000Z';
const nineNextDay = '2026-09-25T00:00:00.000Z';
const noonNextDay = '2026-09-25T03:00:00.000Z';

function fixture(promise = '明日プレゼンの練習しよう') {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-promise-'));
  directories.push(directory);
  const path = join(directory, 'fixture.sqlite');
  let now = saidAt;
  const state = new SQLiteShannonStore({ path, now: () => now });
  const threadId = state.createThread('owner', 'いつものトーク');
  const memory = extractProspectiveMemories(promise, saidAt)[0]!;
  state.apply('owner', { type: 'prospective-memory-upserted', memory });
  state.apply('owner', { type: 'interest-observed', interest: 'AI agents' });
  const world = new SQLiteWorldStore(path, () => now);
  const addTopic = (id: string, at: string) => world.recordSuccess(
    world.dueSources(at).find(item => item.kind === 'hacker-news')!,
    [{ externalId: id, title: `AI agents that learn from daily work ${id}`, url: `https://example.com/${id}` }], at);
  const initiatives = new SQLiteInitiativeStore(path, () => now);
  const close = () => { initiatives.close(); world.close(); state.close(); };
  return { state, threadId, memory, addTopic, initiatives, close, setNow: (value: string) => { now = value; } };
}

describe('a due promise owns the daily slot (TM-02)', () => {
  it('keeps the slot at 07:00 for a date-only promise and delivers it at 09:00', () => {
    const { state, threadId, addTopic, initiatives, close } = fixture();
    addTopic('morning', sevenNextDay);
    const early = initiatives.runOnce(sevenNextDay);
    expect(early).toMatchObject({ sent: 0, stopped: 'reserved-for-commitment' });
    // The loop keeps rechecking instead of sleeping until tomorrow.
    expect(nextInitiativeDelayMilliseconds(early, sevenNextDay)).toBe(15 * 60_000);
    expect(initiatives.runOnce(nineNextDay)).toMatchObject({ sent: 1, stopped: null });
    expect(state.conversationHistory('owner', threadId).at(-1)?.content).toContain('明日プレゼンの練習しよう');
    // The daily limit is unchanged: the spontaneous topic does not follow on the same day.
    expect(initiatives.runOnce(noonNextDay)).toMatchObject({ sent: 0, stopped: 'today-is-enough' });
    expect(initiatives.initiativeEvaluation(30, noonNextDay).stopped).toMatchObject({ 'reserved-for-commitment': 1 });
    close();
  });

  it('does not hold the slot for an undated, future, delivered, completed or forgotten promise', () => {
    const undated = fixture('あとで部屋の掃除したい');
    undated.addTopic('a', sevenNextDay);
    expect(undated.initiatives.runOnce(sevenNextDay)).toMatchObject({ sent: 1 });
    undated.close();

    const future = fixture('3日後に歯医者に行く');
    future.addTopic('b', sevenNextDay);
    expect(future.initiatives.runOnce(sevenNextDay)).toMatchObject({ sent: 1 });
    future.close();

    const completed = fixture();
    completed.state.apply('owner', { type: 'prospective-memory-status-changed', memoryId: completed.memory.id, status: 'completed' });
    completed.addTopic('c', sevenNextDay);
    expect(completed.initiatives.runOnce(sevenNextDay)).toMatchObject({ sent: 1 });
    completed.close();

    const forgotten = fixture();
    forgotten.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: forgotten.memory.id, kind: 'experience',
      status: 'forgotten', pinned: false, updatedAt: saidAt, changeReason: 'ユーザーが忘れるよう指定' } });
    forgotten.addTopic('d', sevenNextDay);
    expect(forgotten.initiatives.runOnce(sevenNextDay)).toMatchObject({ sent: 1 });
    forgotten.close();
  });

  it('still respects quiet hours and the conversation cooldown for the promise itself', () => {
    const { state, threadId, initiatives, close } = fixture();
    expect(initiatives.runOnce('2026-09-25T14:30:00.000Z')).toMatchObject({ sent: 0, stopped: 'quiet-hours' });
    state.appendTurn('owner', threadId, 'おはよう', 'おはようございます。', '2026-09-24T23:30:00.000Z');
    expect(initiatives.runOnce(nineNextDay)).toMatchObject({ sent: 0, stopped: 'recent-conversation' });
    close();
  });

  it('waits until the evening for a promise the owner placed in the evening', () => {
    const { initiatives, close } = fixture('明日の夜に洗濯する');
    expect(initiatives.runOnce(nineNextDay)).toMatchObject({ sent: 0, stopped: 'reserved-for-commitment' });
    expect(initiatives.runOnce('2026-09-25T10:00:00.000Z')).toMatchObject({ sent: 1 }); // 19:00 in Tokyo
    close();
  });
});

describe('answering a reminder (TM-05)', () => {
  function reminded() {
    const context = fixture();
    expect(context.initiatives.runOnce(nineNextDay)).toMatchObject({ sent: 1 });
    context.setNow('2026-09-25T00:10:00.000Z');
    const kernel = createLocalApiKernel(() => '2026-09-25T00:10:00.000Z', { stateStore: context.state, conversationStore: context.state });
    const reminder = async () => ((await kernel.dispatch({ method: 'GET', path: '/v1/conversation',
      query: new URLSearchParams({ scopeKey: 'owner', threadId: context.threadId }) })).body as
      { messages: Array<{ id: string; reminder?: { commitmentId: string; state: string; text: string } }> }).messages.at(-1);
    return { ...context, kernel, reminder };
  }
  const status = (context: ReturnType<typeof reminded>) =>
    context.state.snapshot('owner').prospectiveMemories.find(item => item.id === context.memory.id)!;

  it('exposes the promise behind a reminder message so clients can offer 完了にする／あとで', async () => {
    const context = reminded();
    expect(await context.reminder()).toMatchObject({ reminder: {
      commitmentId: context.memory.id, state: 'pending', text: '明日プレゼンの練習しよう' } });
    const poll = await context.kernel.dispatch({ method: 'GET', path: '/v1/conversation/captures',
      query: new URLSearchParams({ scopeKey: 'owner', threadId: context.threadId }) });
    expect(poll.body).toMatchObject({ reminders: [{ commitmentId: context.memory.id, state: 'pending' }] });
    context.close();
  });

  it.each(['終わったよ', 'やったよ', 'うん、もう済んだよ', '完了にして', 'できました', 'もう終わりました。'])(
    'completes the promise when the reply directly after the reminder is %s', async reply => {
      const context = reminded();
      const response = await context.kernel.dispatch({ method: 'POST', path: '/v1/chat',
        body: { scopeKey: 'owner', threadId: context.threadId, message: reply } });
      await context.kernel.waitForBackground('owner');
      expect((response.body as { reply: string }).reply).toBe('「明日プレゼンの練習しよう」の約束を完了にしました。');
      expect(status(context).status).toBe('completed');
      expect((await context.kernel.dispatch({ method: 'GET', path: '/v1/conversation/captures',
        query: new URLSearchParams({ scopeKey: 'owner', threadId: context.threadId }) })).body)
        .toMatchObject({ reminders: [{ state: 'completed' }] });
      context.close();
    });

  it.each(['終わった？', 'もし終わったら教えるね', '終わってないよ', 'まだ終わったとは言えないと思う', '仕事が終わったよ', '友人は終わったと言っていた', 'おはよう'])(
    'does not complete the promise for %s', reply => {
      const context = reminded();
      expect(resolveReminderReply(context.state.conversationHistory('owner', context.threadId),
        context.state.snapshot('owner'), reply, '2026-09-25T00:10:00.000Z')).toBeNull();
      context.close();
    });

  it('binds only a reply that directly follows the reminder in the same Talk', () => {
    const context = reminded();
    const dependencies = { stateStore: context.state, conversationStore: context.state };
    const other = context.state.createThread('owner', '別のトーク');
    expect(executeConversationCommand('owner', other, { id: 'u1', text: '終わったよ' }, '2026-09-25T00:10:00.000Z', dependencies)).toBeNull();
    context.state.appendTurn('owner', context.threadId, '今日は寒いね', 'そうですね。', '2026-09-25T00:11:00.000Z');
    expect(executeConversationCommand('owner', context.threadId, { id: 'u2', text: '終わったよ' }, '2026-09-25T00:12:00.000Z', dependencies)).toBeNull();
    expect(status(context).status).toBe('pending');
    context.close();
  });

  it('re-arms exactly one later reminder for 「あとで」, inside the daily slot', async () => {
    const context = reminded();
    const response = await context.kernel.dispatch({ method: 'POST', path: '/v1/chat',
      body: { scopeKey: 'owner', threadId: context.threadId, message: 'あとで' } });
    await context.kernel.waitForBackground('owner');
    expect((response.body as { reply: string }).reply).toContain('あとでもう一度だけ声をかけます');
    expect(status(context)).toMatchObject({ status: 'pending', remindAfter: '2026-09-25T03:10:00.000Z' });
    // The reminder that was answered no longer offers actions.
    const messages = ((await context.kernel.dispatch({ method: 'GET', path: '/v1/conversation',
      query: new URLSearchParams({ scopeKey: 'owner', threadId: context.threadId }) })).body as
      { messages: Array<{ reminder?: { state: string } }> }).messages;
    expect(messages.find(message => message.reminder)?.reminder?.state).toBe('snoozed');

    // Same day: the slot is spent. Next day: one more reminder, then silence.
    expect(context.initiatives.runOnce('2026-09-25T06:00:00.000Z')).toMatchObject({ sent: 0, stopped: 'today-is-enough' });
    expect(context.initiatives.runOnce('2026-09-26T03:00:00.000Z')).toMatchObject({ sent: 1 });
    expect(context.initiatives.runOnce('2026-09-27T03:00:00.000Z')).toMatchObject({ sent: 0 });
    expect(context.initiatives.runOnce('2026-09-28T03:00:00.000Z')).toMatchObject({ sent: 0 });
    context.close();
  });

  it('offers the same 「あとで」 as a button action and rejects it for a finished promise', async () => {
    const context = reminded();
    const snooze = () => context.kernel.dispatch({ method: 'POST', path: '/v1/memories/action',
      body: { scopeKey: 'owner', memoryId: context.memory.id, action: 'snooze' } });
    expect((await snooze()).status).toBe(200);
    expect(status(context).remindAfter).toBe('2026-09-25T03:10:00.000Z');
    expect((await context.reminder())?.reminder?.state).toBe('snoozed');
    await context.kernel.dispatch({ method: 'POST', path: '/v1/memories/action',
      body: { scopeKey: 'owner', memoryId: context.memory.id, action: 'complete' } });
    expect((await snooze()).status).toBe(400);
    expect((await context.reminder())?.reminder?.state).toBe('completed');
    context.close();
  });

  it('shows no actions for a reminder whose promise the owner has forgotten', async () => {
    const context = reminded();
    await context.kernel.dispatch({ method: 'POST', path: '/v1/memories/action',
      body: { scopeKey: 'owner', memoryId: context.memory.id, action: 'forget' } });
    expect(await context.reminder()).not.toHaveProperty('reminder');
    context.close();
  });
});
