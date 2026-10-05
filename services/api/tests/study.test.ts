import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { shannonCapabilityPrompt, shannonIdentityPrompt } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { autonomyDayLog, autonomyDayPhrases, autonomyLoopStatus } from '../src/autonomyDayLog.js';
import { summarizeAutonomyDay, type AutonomyActivityEntry } from '../src/autonomyActivity.js';
import { SQLiteStudyShowing, studyShowingMessage } from '../src/autonomyShowing.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import type { StudyOverview, StudyPieceDetail } from '../src/studyDesk.js';
import { FULL_PLAN, STORY_BODY, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

const directory = mkdtempSync(join(tmpdir(), 'shannon-study-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const at = '2026-10-02T01:00:00.000Z';

describe('study store', () => {
  it('keeps every version with what changed and why', () => {
    const { store } = loopHarness();
    const created = store.study.create(scope, { kind: 'story', title: '傘のある駅', body: STORY_BODY, changeNote: '気配を書きました。', model: 'gemini-3.8-flash' }, at);
    if (typeof created === 'string') throw new Error(created);
    expect(created).toMatchObject({ status: 'draft', version: 1, readableVersion: null });
    const revised = store.study.revise(scope, created.id, { body: `${STORY_BODY}終わり。`, changeNote: '終わりを足しました。読後感のためです。' }, at);
    expect(revised).toMatchObject({ status: 'draft', version: 2, title: '傘のある駅' });
    expect(store.study.versions(scope, created.id)).toMatchObject([
      { version: 1, body: STORY_BODY, changeNote: '気配を書きました。', model: 'gemini-3.8-flash' },
      { version: 2, body: `${STORY_BODY}終わり。`, changeNote: '終わりを足しました。読後感のためです。' },
    ]);
    // A stored version cannot be rewritten.
    const database = (store as unknown as { database: DatabaseSync }).database;
    expect(() => database.exec(`UPDATE study_piece_versions SET body = 'x'`)).toThrow(/STUDY_VERSION_APPEND_ONLY/u);
    expect(store.study.revise(scope, created.id, { body: STORY_BODY, changeNote: '' }, at)).toBe('STUDY_INVALID');
    expect(store.study.revise(scope, 'missing', { body: STORY_BODY, changeNote: 'x' }, at)).toBe('STUDY_NOT_FOUND');
  });

  it('moves a story through 下書き, 見せてもいい, 見せた and しまった', () => {
    const { store } = loopHarness();
    const piece = store.study.create(scope, { kind: 'story', title: '題', body: STORY_BODY }, at);
    if (typeof piece === 'string') throw new Error(piece);
    expect(store.study.markShown(scope, piece.id, at)).toBe('STUDY_CLOSED');
    expect(store.study.markReady(scope, piece.id, at)).toMatchObject({ status: 'ready', readableVersion: 1 });
    expect(store.study.markShown(scope, piece.id, at)).toMatchObject({ status: 'shown', shownAt: at });
    expect(store.study.revise(scope, piece.id, { body: `${STORY_BODY}続き。`, changeNote: '続きを足しました。' }, at)).toMatchObject({ status: 'draft', version: 2, readableVersion: 1 });
    expect(store.study.putAway(scope, piece.id, 'owner', at)).toMatchObject({ status: 'put_away', putAwayBy: 'owner' });
    expect(store.study.revise(scope, piece.id, { body: STORY_BODY, changeNote: 'x' }, at)).toBe('STUDY_CLOSED');
    expect(store.study.markReady(scope, piece.id, at)).toBe('STUDY_CLOSED');
    // Nothing was deleted.
    expect(store.study.versions(scope, piece.id)).toHaveLength(2);
  });

  it('rejects text out of bounds and unusable sources', () => {
    const { store } = loopHarness();
    expect(store.study.create(scope, { kind: 'story', title: '', body: STORY_BODY }, at)).toBe('STUDY_INVALID');
    expect(store.study.create(scope, { kind: 'story', title: '題', body: 'あ'.repeat(4_001) }, at)).toBe('STUDY_INVALID');
    expect(store.study.create(scope, { kind: 'note', title: '題', body: 'あ'.repeat(1_201) }, at)).toBe('STUDY_INVALID');
    expect(store.study.create(scope, { kind: 'note', title: '題', body: '本文', sources: [{ title: 'x', url: 'file:///etc/passwd' }] }, at)).toBe('STUDY_INVALID');
    for (let index = 0; index < 12; index += 1) expect(typeof store.study.create(scope, { kind: 'story', title: `題${index}`, body: STORY_BODY }, at)).toBe('object');
    expect(store.study.create(scope, { kind: 'story', title: '13本目', body: STORY_BODY }, at)).toBe('STUDY_LIMIT');
  });
});

describe('study routes for the owner', () => {
  async function withStory() {
    const harness = loopHarness({ loop: { cycleIntervalMilliseconds: 60_000, cyclesPerDay: 6 } });
    const api = createLocalApiKernel(() => harness.clock.at, { autonomy: harness.service });
    const get = (path: string) => api.dispatch({ method: 'GET', path, query: new URLSearchParams({ scopeKey: scope }) });
    const post = (path: string, body: Record<string, unknown> = {}) => api.dispatch({ method: 'POST', path, body: { scopeKey: scope, ...body } });
    harness.model.plans = [FULL_PLAN];
    await runUntilIdle(harness.loop);
    const story = harness.store.study.list(scope).find(piece => piece.kind === 'story')!;
    return { ...harness, api, get, post, story };
  }

  it('lists a note in full and an unshown story as a card without title or text', async () => {
    const { get, story } = await withStory();
    const overview = (await get('/v1/autonomy/study')).body as StudyOverview;
    expect(overview.reactions).toEqual([{ id: 'like', label: '好き' }, { id: 'more', label: 'もう少し' }, { id: 'unclear', label: 'よく分からない' }]);
    const hidden = overview.pieces.find(piece => piece.id === story.id)!;
    expect(hidden).toMatchObject({ kind: 'story', kindLabel: '物語', statusLabel: '下書き', hidden: true, title: null, excerpt: null, version: null });
    expect(JSON.stringify(overview)).not.toContain('傘のある駅');
    expect(overview.pieces.find(piece => piece.kind === 'note')).toMatchObject({ hidden: false, title: '夕方の駅が懐かしい理由', statusLabel: '見せてもいい' });
    const detail = (await get(`/v1/autonomy/study/pieces/${story.id}`)).body as StudyPieceDetail;
    expect(detail).toMatchObject({ hidden: true, title: null, body: null, versions: [], sources: [], canReact: false, canPutAway: true, awaitingReaction: false });
    expect(JSON.stringify(detail)).not.toContain('駅のベンチ');
    expect((await get('/v1/autonomy/study/pieces/missing')).status).toBe(404);
  });

  it('lets the owner read a shown story, react, and ask her to put it away, but never edit it', async () => {
    const { get, post, story, store, entries, api } = await withStory();
    expect((await post(`/v1/autonomy/study/pieces/${story.id}/reaction`, { reaction: 'like' })).status).toBe(409);
    store.study.markReady(scope, story.id, at);
    const detail = (await get(`/v1/autonomy/study/pieces/${story.id}`)).body as StudyPieceDetail;
    expect(detail).toMatchObject({ hidden: false, title: '傘のある駅', body: STORY_BODY, version: 1, canReact: true, awaitingReaction: true });
    expect(detail.versions).toEqual([{ version: 1, changeNote: '誰もいない場所に、誰かがいた気配だけを書こうとしました。', createdAt: expect.any(String) }]);

    expect((await post(`/v1/autonomy/study/pieces/${story.id}/reaction`, { reaction: 'love' })).status).toBe(400);
    expect((await post(`/v1/autonomy/study/pieces/${story.id}/reaction`, { reaction: 'like', comment: 'あ'.repeat(401) })).status).toBe(400);
    const reacted = await post(`/v1/autonomy/study/pieces/${story.id}/reaction`, { reaction: 'unclear', comment: '最後が分かりませんでした。' });
    expect(reacted.status).toBe(200);
    expect(reacted.body).toMatchObject({ awaitingReaction: false });
    expect((reacted.body as StudyPieceDetail).feedback).toMatchObject([{ reaction: 'unclear', reactionLabel: 'よく分からない', comment: '最後が分かりませんでした。', version: 1, used: false }]);
    expect(entries()[0]).toMatchObject({ actor: 'owner', summary: '所有者が「傘のある駅」に感想を残しました（よく分からない）。', link: `shannon-study://${story.id}` });

    // No owner route changes her words.
    for (const path of [`/v1/autonomy/study/pieces/${story.id}`, '/v1/autonomy/study', `/v1/autonomy/study/pieces/${story.id}/body`,
      `/v1/autonomy/study/pieces/${story.id}/title`, `/v1/autonomy/study/pieces/${story.id}/revise`, '/v1/autonomy/study/pieces']) {
      expect((await api.dispatch({ method: 'POST', path, body: { scopeKey: scope, title: '書き換え', body: '書き換え' } })).status, path).toBe(404);
    }
    expect(store.study.get(scope, story.id)).toMatchObject({ title: '傘のある駅', body: STORY_BODY });

    const away = await post(`/v1/autonomy/study/pieces/${story.id}/put-away`);
    expect(away.body).toMatchObject({ status: 'put_away', statusLabel: 'しまった', canReact: false, canPutAway: false, body: STORY_BODY });
    expect(entries()[0]!.summary).toBe('所有者が「傘のある駅」をしまうよう伝えました。');
    expect((await post(`/v1/autonomy/study/pieces/${story.id}/reaction`, { reaction: 'like' })).status).toBe(409);
  });

  it('answers 400 without a scope', async () => {
    const { api } = await withStory();
    expect((await api.dispatch({ method: 'GET', path: '/v1/autonomy/study', query: new URLSearchParams() })).status).toBe(400);
    expect((await api.dispatch({ method: 'POST', path: '/v1/autonomy/study/pieces/x/put-away', body: {} })).status).toBe(400);
  });
});

describe('showing a piece through the initiative path', () => {
  function showingHarness(name: string) {
    const path = join(directory, `${name}.sqlite`);
    const persistent = new SQLiteShannonStore({ path, now: () => at });
    const initiatives = new SQLiteInitiativeStore(path, () => at);
    const threadId = persistent.createThread(scope, 'いつものトーク');
    const showing = new SQLiteStudyShowing(path);
    const close = () => { showing.close(); initiatives.close(); persistent.close(); };
    return { path, persistent, initiatives, threadId, showing, close };
  }
  const piece = { id: 'piece-1', title: '傘のある駅', version: 1, revised: false };

  it('speaks as Shannon and carries a link that opens the piece', () => {
    const { showing, initiatives, persistent, threadId, close, path } = showingHarness('tell');
    expect(showing.tell(scope, piece, at)).toBe('sent');
    const unread = initiatives.unreadMessages(scope);
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ threadId, sourceTitle: 'シャノンの書斎', expression: 'excited' });
    expect(unread[0]!.content).toBe('ライ氏、短い物語を書きました。「傘のある駅」です。読んだら、どう思ったか聞かせてください。ボクは、けっこう気に入っています。');
    expect(studyShowingMessage({ ...piece, version: 2, revised: true })).toBe('ライ氏、「傘のある駅」を直しました。前の稿より、ボクは好きなものになったと思います。もう一度読んでもらえると嬉しいです。');
    expect(persistent.conversationHistory(scope, threadId).at(-1)).toMatchObject({ role: 'assistant', content: unread[0]!.content, studyPiece: { id: 'piece-1', title: '傘のある駅' } });
    // It used the day's one slot, under the same key the initiative loop uses.
    const database = new DatabaseSync(path);
    expect(database.prepare('SELECT day_key, source_item_id FROM initiative_messages').all()).toEqual([{ day_key: '2026-10-02', source_item_id: 'study:piece-1:v1' }]);
    database.close();
    close();
  });

  it('keeps the one-message-a-day limit shared with the initiative loop, and tells a version once', () => {
    const { showing, initiatives, close } = showingHarness('limit');
    expect(showing.tell(scope, piece, at)).toBe('sent');
    expect(showing.tell(scope, piece, at)).toBe('already-told');
    expect(showing.tell(scope, { ...piece, id: 'piece-2' }, at)).toBe('today-is-enough');
    expect(showing.mayMessageNow(scope, at)).toBe('today-is-enough');
    // The initiative loop sees the day as used, too.
    expect(initiatives.runOnce(at).sent).toBe(0);
    expect(initiatives.unreadMessages(scope)).toHaveLength(1);
    // The next day the slot is free again.
    expect(showing.tell(scope, { ...piece, id: 'piece-2' }, '2026-10-03T01:00:00.000Z')).toBe('sent');
    close();
  });

  it('stays quiet at night and right after the owner wrote', () => {
    const { showing, persistent, initiatives, close, path } = showingHarness('quiet');
    // 23:30 and 06:30 in Tokyo.
    expect(showing.tell(scope, piece, '2026-10-02T14:30:00.000Z')).toBe('quiet-hours');
    expect(showing.tell(scope, piece, '2026-10-02T21:30:00.000Z')).toBe('quiet-hours');
    const database = new DatabaseSync(path);
    database.prepare(`INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at)
      VALUES ('m1', ?, 't', 'turn', 0, 'user', 'こんにちは', ?)`).run(scope, '2026-10-02T00:30:00.000Z');
    database.close();
    expect(showing.tell(scope, piece, at)).toBe('recent-conversation');
    expect(showing.ownerActiveSince(scope, '2026-10-02T00:00:00.000Z')).toBe(true);
    expect(showing.ownerActiveSince(scope, '2026-10-02T00:45:00.000Z')).toBe(false);
    expect(initiatives.unreadMessages(scope)).toHaveLength(0);
    // 90 minutes after the owner's message.
    expect(showing.tell(scope, piece, '2026-10-02T02:01:00.000Z')).toBe('sent');
    void persistent;
    close();
  });

  it('has nowhere to speak without the conversation tables', () => {
    const showing = new SQLiteStudyShowing(join(directory, 'empty.sqlite'));
    expect(showing.mayMessageNow(scope, at)).toBe('unavailable');
    expect(showing.tell(scope, piece, at)).toBe('unavailable');
    expect(showing.ownerActiveSince(scope, at)).toBe(false);
    showing.close();
  });
});

describe('what the owner is told about the loop', () => {
  const entry = (tool: string, outcome = 'done'): AutonomyActivityEntry => ({
    id: tool, sequence: 1, occurredAt: at, dayKey: '2026-10-02', kind: 'action', actor: 'shannon', summary: 'x', domain: 'thinking',
    domainLabel: '考える・書く', costYen: 3.5, outcome: outcome as 'done', approval: 'not_needed', tool,
  });

  it('writes the day as a short log, without a model', () => {
    const entries = [entry('study.think'), entry('study.read'), entry('study.read'), entry('study.note'), entry('study.note'), entry('study.draft'), entry('study.read', 'failed')];
    expect(autonomyDayLog(entries)).toBe('次にすることを考え、公開ページを2つ読み、メモを2つ書き、物語の下書きを1つ書きました。');
    expect(summarizeAutonomyDay('2026-10-02', entries).summary)
      .toBe('次にすることを考え、公開ページを2つ読み、メモを2つ書き、物語の下書きを1つ書きました。うまくいかなかったこと1件。使った費用は24.50円です。');
    expect(autonomyDayLog([entry('study.revise'), entry('study.show')])).toBe('物語を1回直し、物語を1つ見せました。');
    // A copy counts once the device reports the file is in her folder; queueing it (`folder.copy`) and a failed write do not.
    const folder = [entry('study.note'), entry('folder.copy'), entry('folder.copy'), entry('folder.write'), entry('folder.write', 'failed'), entry('study.look')];
    expect(autonomyDayLog(folder)).toBe('メモを1つ書き、自分のフォルダに写しを1つ置き、部屋を1回見ました。');
    expect(autonomyDayPhrases(folder)).toEqual(['メモを1つ書いた', '自分のフォルダに写しを1つ置いた', '部屋を1回見た']);
    // A look inside a conversation is not something she did in her own time.
    expect(autonomyDayPhrases([entry('body.look')])).toEqual([]);
    // A day without loop steps keeps the earlier count wording.
    expect(summarizeAutonomyDay('2026-10-02', [entry('outline')]).summary).toBe('したこと1件。使った費用は3.50円です。');
    expect(autonomyDayLog([])).toBeNull();
  });

  it('names the loop state in the owner\'s words', () => {
    const heartbeat = { ownerId: 'w', heartbeatAt: at, leaseUntil: at, readiness: 'ready' as const };
    const status = (input: Partial<Parameters<typeof autonomyLoopStatus>[0]>) =>
      autonomyLoopStatus({ enabled: true, paused: false, heartbeat, at, budgetStopped: false, ...input }).label;
    expect(status({})).toBe('動いています');
    expect(status({ enabled: false })).toBe('準備中');
    expect(status({ paused: true })).toBe('一時停止中');
    expect(status({ budgetStopped: true })).toBe('今日は予算を使い切りました');
    expect(status({ heartbeat: null })).toBe('準備中');
    expect(status({ heartbeat: { ...heartbeat, readiness: 'no_credential' } })).toBe('準備中');
    // No report from the loop process for more than five minutes.
    expect(status({ at: '2026-10-02T01:06:00.000Z' })).toBe('準備中');
    expect(status({ enabled: false, paused: true })).toBe('準備中');
  });

  it('reports the state and today\'s spend against the cap with the activity list', async () => {
    const harness = loopHarness();
    const api = createLocalApiKernel(() => harness.clock.at, { autonomy: harness.service });
    const activity = () => api.dispatch({ method: 'GET', path: '/v1/autonomy/activity', query: new URLSearchParams({ scopeKey: scope }) });
    expect(((await activity()).body as { loop: { label: string } }).loop.label).toBe('準備中');
    harness.model.plans = [FULL_PLAN];
    await runUntilIdle(harness.loop);
    const body = (await activity()).body as { loop: { state: string; label: string }; budget: { spentYen: number; capYen: number }; days: { summary: string; costYen: number }[] };
    expect(body.loop).toMatchObject({ state: 'running', label: '動いています' });
    expect(body.budget.capYen).toBe(2_000);
    expect(body.budget.spentYen).toBeGreaterThan(0);
    expect(body.days[0]!.costYen).toBe(body.budget.spentYen);
    expect(body.days[0]!.summary).toMatch(/^次にすることを考え、公開ページを1つ読み、メモを1つ書き、物語の下書きを1つ書きました。使った費用は[\d.,]+円です。$/u);
  });
});

describe('what the owner\'s own prompts say about her activity', () => {
  class PromptRecorder implements ShannonChatModel {
    readonly mode = 'openai' as const;
    readonly model = 'test-model';
    readonly prompts: string[] = [];
    async generate(request: ShannonChatModelRequest) { this.prompts.push(request.systemPrompt); return { mode: this.mode, model: this.model, reply: '返答です。' }; }
    async generateVoice(request: ShannonVoiceModelRequest) { this.prompts.push(request.systemPrompt); return { mode: this.mode, model: this.model, reply: '音声の返答です。' }; }
  }
  const chat = async (harness: ReturnType<typeof loopHarness>) => {
    const chatModel = new PromptRecorder();
    const api = createLocalApiKernel(() => harness.clock.at, { autonomy: harness.service, chatModel });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, message: '何してた？' } });
    const voice = api.realtimeVoiceSession(scope).instructions;
    const guest = api.realtimeVoiceSession(scope, undefined, { participantMode: 'guest' }).instructions;
    // Live voice turns: the owner alone, the owner with someone listening, and a friend.
    const turn = async (body: Record<string, unknown>) => {
      const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: { scopeKey: scope, transcript: '何してた？', ...body } });
      expect(response.status).toBe(200);
      return chatModel.prompts.at(-1)!;
    };
    const voiceTurn = await turn({});
    const companionTurn = await turn({ deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, companionPresent: true } });
    const guestTurn = await turn({ participantMode: 'guest' });
    return { text: chatModel.prompts[0]!, voice, guest, voiceTurn, companionTurn, guestTurn };
  };

  it('keeps 「仕組みは準備中」 until the loop is enabled and running, and removes it only then', async () => {
    const off = await chat(loopHarness({ enabled: false }));
    expect(off.text).toContain('仕組みは準備中');
    expect(off.text.startsWith(shannonIdentityPrompt('owner'))).toBe(true);

    // Enabled, but no loop process has reported in.
    const idle = await chat(loopHarness());
    expect(idle.text).toContain('仕組みは準備中');

    const running = loopHarness();
    await running.loop.tick();
    const on = await chat(running);
    for (const prompt of [on.text, on.voice, on.voiceTurn]) {
      expect(prompt).not.toContain('仕組みは準備中');
      expect(prompt).toContain('自分から動く時の約束（いまは調べて、書斎にメモと物語を書き、見せている。記録に残り、ライ氏が止められる）:');
      expect(prompt).toContain('- 禁止: 1日2,000円のモデル・API予算以外の出費、無断の連絡、他人のふり、内緒と言われたことを作品やメモに書くこと、自分の複製。');
    }
    // A guest never hears either wording.
    expect(on.guest).not.toContain('自分から動く時の約束');
    expect(on.guestTurn).not.toContain('自分から動く時の約束');
    expect(on.text.length).toBeLessThanOrEqual(off.text.length + 400);

    // Paused: the mechanism is not running, so the earlier wording is back.
    running.service.setPaused(scope, true);
    expect((await chat(running)).text).toContain('仕組みは準備中');
    expect(shannonCapabilityPrompt('owner')).toContain('仕組みは準備中');
  });

  it('gives owner text and voice a compact line of what she is working on, absent when there is nothing', async () => {
    const empty = await chat(loopHarness());
    expect(empty.text).not.toContain('[ボクがひとりの時間にしていること]');
    expect(empty.voice).not.toContain('[ボクがひとりの時間にしていること]');

    const harness = loopHarness();
    harness.model.plans = [FULL_PLAN];
    await runUntilIdle(harness.loop);
    const working = await chat(harness);
    for (const prompt of [working.text, working.voice, working.voiceTurn]) {
      expect(prompt).toContain('[ボクがひとりの時間にしていること]（記録にある事実。何をしていたか聞かれたら自分の言葉で話す）');
      expect(prompt).toContain('- 今日したこと: 次にすることを考えた、公開ページを1つ読んだ、メモを1つ書いた、物語の下書きを1つ書いた');
      // Owner decision 2026-10-05: she knows the title of her own unshown draft, marked unshown; its text stays out of the prompt.
      expect(prompt).toContain('- 作っている物語「傘のある駅」: 下書き・第1稿（まだ見せていない。題名や中身をいつ言うかは自分で決める）');
      expect(prompt).not.toContain('駅のベンチ');
    }
    // Owner one-to-one only: not with someone listening, not with a friend.
    for (const prompt of [working.guest, working.guestTurn, working.companionTurn]) expect(prompt).not.toContain('ひとりの時間');
    const block = working.text.slice(working.text.indexOf('[ボクがひとりの時間にしていること]')).split('\n\n')[0]!;
    expect(block.length).toBeLessThanOrEqual(320);

    const story = harness.store.study.list(scope).find(piece => piece.kind === 'story')!;
    harness.store.study.markReady(scope, story.id, at);
    harness.store.study.markShown(scope, story.id, at);
    expect((await chat(harness)).text).toContain('- 物語「傘のある駅」: 第1稿・見せた');
  });
});
