import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryWithholdingRules, ownerSpoke } from '@shannon/cognition';
import { BODY_REACTION_LIMITS } from '../src/bodyReactionContract.js';
import { SQLiteTouchExperiences, touchEvidence, touchExperienceSummary, touchWhen } from '../src/bodyTouchMemory.js';
import { ShannonMemoryService } from '../src/memoryService.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { HEHE, MINUTE, SECOND, START, reactionHarness, scope } from './bodyReactionHarness.js';
import { promptOf } from './modelPrompt.js';

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

/** The real stores in one database file, as the API process runs them. */
async function sqliteHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-touch-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: START };
  const store = new SQLiteShannonStore({ path, now: () => clock.at });
  const harness = await reactionHarness({ stateStore: store, conversationStore: store, path, experiences: new SQLiteTouchExperiences(path) });
  // One clock for the stores and the kernel.
  const advance = (milliseconds: number) => { harness.advance(milliseconds); clock.at = harness.clock.at; };
  const touchMemories = () => store.experienceCandidates(scope).filter(item => item.summary.startsWith('体の記憶'));
  return { ...harness, advance, store, path, touchMemories };
}

describe('conversation only if he answers', () => {
  it('stores no conversation message when he does not answer, and drops the line when the window passes', async () => {
    const { said, conversationStore, messages, reactionStore, advance, delegate, persist, chatModel } = await reactionHarness();
    const answer = await said();
    expect(answer.status).toBe('said');
    expect(conversationStore.listThreads(scope)).toEqual([]);
    expect(messages()).toEqual([]);
    expect(conversationStore.experienceCandidates(scope)).toEqual([]);
    expect(reactionStore.reaction(scope, 'touch-1')).toMatchObject({ status: 'said', line: HEHE, linkState: 'pending' });

    // The window: listenSeconds plus the margin for him to finish speaking.
    advance(6 * SECOND + BODY_REACTION_LIMITS.linkMarginMilliseconds + SECOND);
    expect((await delegate('さっきのは何？', { reactionId: 'touch-1' })).status).toBe(200);
    expect(chatModel.voiceRequests[0]!.history).toEqual([]);
    expect(chatModel.voiceRequests[0]!.precedingReply).toBeUndefined();
    expect(reactionStore.reaction(scope, 'touch-1')).toMatchObject({ linkState: 'dropped' });
    await persist('さっきのは何？', 'なんでしょう。', { reactionId: 'touch-1' });
    expect(messages()).toEqual([{ role: 'user', content: 'さっきのは何？' }, { role: 'assistant', content: 'なんでしょう。' }]);
    // It stays only in the memory of the touch.
    expect(reactionStore.burstOfTouch(scope, 'touch-1')?.said).toEqual([HEHE]);
  });

  it('with a linked reply the history reads her line, his reply, her answer, and the answering model saw her line', async () => {
    const { said, chat, delegate, persist, messages, chatModel, reactionStore, advance, conversationStore } = await reactionHarness();
    const talk = await chat('おはよう');
    advance(20 * MINUTE);
    const answer = await said();
    expect(answer.message?.threadId).toBe(talk.threadId);
    expect(messages(talk.threadId)).toHaveLength(2);

    advance(4 * SECOND);
    // The body's first voice turn after the reaction names it. No threadId: the reaction's Talk is used.
    const reply = await delegate('なんでもないよ、えらいなと思って', { reactionId: answer.id });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ threadId: talk.threadId, reply: chatModel.voiceReply });
    const request = chatModel.voiceRequests.at(-1)!;
    expect(request.precedingReply).toBe(HEHE);
    expect(request.history.at(-1)).not.toEqual({ role: 'assistant', content: HEHE });
    expect(request.message).toBe('なんでもないよ、えらいなと思って');
    // Nothing is stored yet: the body persists the turn after speaking.
    expect(messages(talk.threadId)).toHaveLength(2);
    expect(reactionStore.reaction(scope, answer.id)).toMatchObject({ linkState: 'linked' });

    advance(9 * SECOND);
    const stored = await persist('なんでもないよ、えらいなと思って', chatModel.voiceReply, { reactionId: answer.id });
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({ threadId: talk.threadId });
    expect(messages(talk.threadId).slice(2)).toEqual([
      { role: 'assistant', content: HEHE },
      { role: 'user', content: 'なんでもないよ、えらいなと思って' },
      { role: 'assistant', content: chatModel.voiceReply },
    ]);
    // Her line is display history: it has no user side and is no experience of its own.
    const line = conversationStore.conversationHistory(scope, talk.threadId)[2]!;
    expect(line.sourceExperienceId).toMatch(/^body-reaction:/u);
    expect(line.observedAt).toBe('2026-10-02T06:20:00.000Z');
    expect(conversationStore.experienceCandidates(scope).map(item => item.userMessage)).toEqual(['おはよう', 'なんでもないよ、えらいなと思って']);
    expect(reactionStore.reaction(scope, answer.id)).toMatchObject({ linkState: 'stored' });

    // Once: a second turn with the same id is an ordinary turn, and later turns see her line as history.
    await delegate('それでね', { reactionId: answer.id });
    expect(chatModel.voiceRequests.at(-1)!.history.filter(item => item.content === HEHE)).toHaveLength(1);
    expect(chatModel.voiceRequests.at(-1)!.precedingReply).toBeUndefined();
    await persist('それでね', 'はい。', { reactionId: answer.id });
    expect(messages(talk.threadId).filter(item => item.content === HEHE)).toHaveLength(1);
    expect(messages(talk.threadId)).toHaveLength(7);
  });

  it('keeps a linked line for the stored turn, and takes it without a link when the turn arrives inside the window', async () => {
    const linked = await reactionHarness();
    const first = await linked.said();
    await linked.delegate('うん', { reactionId: first.id });
    // He talked for a while and the reply was long: the stored turn arrives well after the listen window.
    linked.advance(5 * MINUTE);
    await linked.persist('うん', 'はい。', { reactionId: first.id });
    expect(linked.messages().map(item => item.content)).toEqual([HEHE, 'うん', 'はい。']);
    // Linked, and then no stored turn for ten minutes: dropped.
    const abandoned = await reactionHarness();
    const second = await abandoned.said();
    await abandoned.delegate('うん', { reactionId: second.id });
    abandoned.advance(BODY_REACTION_LIMITS.linkedMilliseconds + SECOND);
    await abandoned.persist('うん', 'はい。', { reactionId: second.id });
    expect(abandoned.messages().map(item => item.content)).toEqual(['うん', 'はい。']);
    // A body that only persists (a realtime session): the stored turn alone takes the line inside the window.
    const direct = await reactionHarness();
    const third = await direct.said();
    direct.advance(20 * SECOND);
    await direct.persist('どうしたの', 'えへへ。', { reactionId: third.id });
    expect(direct.messages().map(item => item.content)).toEqual([HEHE, 'どうしたの', 'えへへ。']);
  });

  it('ignores an unknown or malformed-looking id on a voice turn, and refuses only a wrong type', async () => {
    const { said, delegate, persist, messages } = await reactionHarness();
    await said();
    expect((await delegate('やあ', { reactionId: 'no-such-reaction' })).status).toBe(200);
    expect((await delegate('やあ', { reactionId: '../etc' })).status).toBe(200);
    expect((await persist('やあ', 'はい。', { reactionId: 'no-such-reaction' })).status).toBe(201);
    expect(messages()).toEqual([{ role: 'user', content: 'やあ' }, { role: 'assistant', content: 'はい。' }]);
    expect(await delegate('やあ', { reactionId: 7 })).toMatchObject({ status: 400 });
    expect(await persist('やあ', 'はい。', { reactionId: { id: 'touch-1' } })).toMatchObject({ status: 400 });
    // A refused request did not take the line.
    expect((await persist('', 'はい。', { reactionId: 'touch-1' })).status).toBe(400);
    await persist('ん？', 'はい。', { reactionId: 'touch-1' });
    expect(messages().map(item => item.content)).toEqual(['やあ', 'はい。', HEHE, 'ん？', 'はい。']);
  });

  it('with other people able to hear, her line is context for the reply and never an owner-alone entry of the Talk', async () => {
    // The body runs voice in guest mode while a stream or 「友人も一緒」 is on.
    const guest = await reactionHarness();
    const answer = await guest.said({}, { audience: 'others' });
    const turns = [{ role: 'participant', text: 'こんにちは' }, { role: 'shannon', text: 'こんにちは。' }];
    const response = await guest.delegate('シャノン、いま何て言ったの？', {
      participantMode: 'guest', reactionId: answer.id, threadId: 'guest-call',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'u1', text: 'シャノン、いま何て言ったの？', source: 'speech', rawText: 'シャノン、いま何て言ったの？', callContext: { turns, followsShannonTurn: true } } },
    });
    expect(response.status).toBe(200);
    expect(guest.chatModel.voiceRequests.at(-1)!.history).toEqual([{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'こんにちは。' }]);
    expect(guest.chatModel.voiceRequests.at(-1)!.precedingReply).toBe(HEHE);
    // A guest call stores nothing in the owner's Talk.
    expect(guest.conversationStore.listThreads(scope)).toEqual([]);

    // An owner-mode turn stored as "someone else was listening": the turn follows the companion rules, her line stays out.
    const companion = await reactionHarness();
    const said = await companion.said({}, { audience: 'owner' });
    await companion.persist('ねえ聞いて', 'はい。', { reactionId: said.id, companionPresent: true });
    expect(companion.messages().map(item => item.content)).toEqual(['ねえ聞いて', 'はい。']);
    expect(companion.conversationStore.experienceCandidates(scope)[0]).toMatchObject({ disclosure: { speaker: 'unknown' } });
    // A line said with others present is not written as an owner-alone entry even if the stored turn claims the owner alone.
    const mixed = await reactionHarness();
    const line = await mixed.said({}, { audience: 'others' });
    await mixed.persist('どうも', 'はい。', { reactionId: line.id });
    expect(mixed.messages().map(item => item.content)).toEqual(['どうも', 'はい。']);
    expect(mixed.reactionStore.reaction(scope, line.id)).toMatchObject({ linkState: 'stored' });
  });

  it('does nothing on a voice turn while reactions are switched off', async () => {
    const { reactionStore, api, send, messages } = await reactionHarness({ config: { enabled: false } });
    expect(await send('POST', '/v1/voice/gemini/cascade/turns', { userTranscript: 'やあ', shannonTranscript: 'はい。', reactionId: 'touch-1' })).toMatchObject({ status: 201 });
    expect(messages()).toHaveLength(2);
    expect(reactionStore.reaction(scope, 'touch-1')).toBeNull();
    expect(api).toBeTruthy();
  });
});

describe('one touch, two messages', () => {
  it('counts a touch once when the finished event arrives with the id of the reaction request', async () => {
    const { said, events, state, reactionStore, speaker, bodyStore } = await reactionHarness();
    // Asked 1.5 seconds into the pat.
    await said({ durationMs: 1_500, strength: 0.3, ongoing: true }, { id: 'pat-1' });
    const version = state().version;
    // The finished touch, later, with the real duration and the same id.
    expect((await events({ id: 'pat-1', type: 'pet', audience: 'owner', occurredAt: START, durationMs: 5_200, strength: 0.4 })).body).toMatchObject({ stored: 1 });
    expect(state().version).toBe(version);
    expect(speaker.calls).toHaveLength(1);
    expect(reactionStore.burstOfTouch(scope, 'pat-1')).toMatchObject({ count: 1, totalDurationMs: 5_200, said: [HEHE] });
    // The event itself is stored as an event, as before.
    expect(bodyStore.recent(scope, 'owner', '2026-10-02T00:00:00.000Z', 10).map(event => event.id)).toEqual(['pat-1']);
    // A retry of the event changes nothing; a shorter duration never shrinks the memory.
    await events({ id: 'pat-1', type: 'pet', audience: 'owner', occurredAt: START, durationMs: 5_200, strength: 0.4 });
    expect(reactionStore.burstOfTouch(scope, 'pat-1')).toMatchObject({ count: 1, totalDurationMs: 5_200, others: false });
    // The finished touch of another reaction says others were there by then: the memory says so, and it is still one touch.
    await said({ type: 'tickle', durationMs: 1_200 }, { id: 'tickle-1' });
    await events({ id: 'tickle-1', type: 'tickle', audience: 'others', occurredAt: START, durationMs: 3_000 });
    expect(reactionStore.burstOfTouch(scope, 'tickle-1')).toMatchObject({ count: 1, totalDurationMs: 3_000, others: true });
  });

  it('counts once in the other order too: the event first, then a reaction request with its id', async () => {
    const { said, events, state, reactionStore } = await reactionHarness();
    await events({ id: 'poke-1', type: 'poke', audience: 'owner', occurredAt: START, durationMs: 80 });
    const version = state().version;
    const answer = await said({ type: 'poke', durationMs: 80, ongoing: false }, { id: 'poke-1' });
    expect(answer.status).toBe('said');
    // One step for her line, none for the touch a second time.
    expect(state().version).toBe(version + 1);
    expect(reactionStore.burstOfTouch(scope, 'poke-1')).toMatchObject({ count: 1 });
  });
});

describe('a touch that arrives only as an event', () => {
  it('moves her feeling and enters the memory, without a word and without a model call', async () => {
    const { events, state, speaker, reactionStore, activity, messages, now } = await reactionHarness();
    expect((await events(
      { id: 'e1', type: 'pet', audience: 'owner', occurredAt: START, durationMs: 2_000 },
      { id: 'e2', type: 'pet', audience: 'owner', occurredAt: START, durationMs: 1_000 },
      { id: 'e3', type: 'ownerReturned', audience: 'owner', occurredAt: START, minutesAway: 5 },
      { id: 'e4', type: 'windowShown', audience: 'owner', occurredAt: START },
    )).body).toMatchObject({ stored: 4 });
    expect(speaker.calls).toHaveLength(0);
    expect(activity()).toEqual([]);
    expect(messages()).toEqual([]);
    // Two touches moved her; the other events did not.
    expect(state().version).toBe(2);
    expect(state().expressiveEmotion).toMatchObject({ primary: 'happy', cause: 'ライ氏に頭をなでてもらった（続けて2回目）' });
    expect(reactionStore.recentBursts(scope, START, now(), 10)).toMatchObject([{ type: 'pet', count: 2, totalDurationMs: 3_000, others: false }]);
  });

  it('counts with other people present as well, and stays out of the owner\'s conversation block', async () => {
    const { events, state, chat, reactionStore, now } = await reactionHarness();
    await events({ id: 'o1', type: 'tickle', audience: 'others', occurredAt: START, durationMs: 1_500 });
    expect(state().expressiveEmotion).toMatchObject({ primary: 'giggle', cause: 'くすぐられた', target: '触れた人' });
    expect(reactionStore.recentBursts(scope, START, now(), 10)).toMatchObject([{ type: 'tickle', count: 1, others: true }]);
    expect(promptOf((await chat('こんにちは')))).not.toContain('[体に起きたこと]');
  });

  it('tells a later reaction what the events of this sitting were', async () => {
    const { events, said, speaker, advance } = await reactionHarness();
    await events(
      { id: 'e1', type: 'poke', audience: 'owner', occurredAt: START },
      { id: 'e2', type: 'poke', audience: 'owner', occurredAt: START },
    );
    advance(30 * SECOND);
    await said({ type: 'poke', durationMs: 90, ongoing: false });
    expect(speaker.prompts[0]).toContain('- つつかれた: この数分で3回目');
    expect(speaker.prompts[0]).toContain('いまの気持ち: cuteAngry');
  });

  it('remembers an event reported long after it happened, and moves no feeling for it', async () => {
    const { events, state, reactionStore, clock } = await reactionHarness();
    const old = new Date(Date.parse(clock.at) - 5 * 60 * MINUTE).toISOString();
    await events({ id: 'late-1', type: 'holdHand', audience: 'owner', occurredAt: old, durationMs: 4_000 });
    expect(state().version).toBe(0);
    expect(reactionStore.burstOfTouch(scope, 'late-1')).toMatchObject({ type: 'holdHand', count: 1, startedAt: old });
  });
});

describe('remembering a touch', () => {
  it('words the memory from the kind, the numbers and what she said', () => {
    const burst = { id: 'b', type: 'pet' as const, startedAt: START, lastAt: START, count: 1, totalDurationMs: 0, others: false, said: [] as string[], saidOpen: [] as string[] };
    expect(touchWhen(START)).toBe('10月2日の午後');
    expect(touchWhen('2026-10-01T23:30:00.000Z')).toBe('10月2日の朝');
    expect(touchWhen('2026-10-02T15:30:00.000Z')).toBe('10月3日の深夜');
    expect(touchExperienceSummary(burst)).toBe('体の記憶: 10月2日の午後、ライ氏に頭をなでてもらった。ボクは何も言わなかった。');
    expect(touchExperienceSummary({ ...burst, count: 7, totalDurationMs: 21_400, said: [HEHE, 'また？'] }))
      .toBe(`体の記憶: 10月2日の午後、ライ氏に頭をなでてもらった（たくさん、7回、合わせて21秒ほど）。ボクは「${HEHE}」「また？」と言った。`);
    expect(touchExperienceSummary({ ...burst, type: 'poke', count: 2, others: true }))
      .toBe('体の記憶: 10月2日の午後、つつかれた（2回）。ほかの人も見ている時だった。ボクは何も言わなかった。');
    // Where a turn has the owner's words, a touch has one token that no reply contains.
    expect(touchEvidence('0b6c1f0e-5a47-4d0c-9d1c-7a2f6f1f0a11')).toMatch(/^body-touch-[a-p]{32}$/u);
    expect(touchEvidence('0b6c1f0e-5a47-4d0c-9d1c-7a2f6f1f0a11')).not.toBe(touchEvidence('0b6c1f0e-5a47-4d0c-9d1c-7a2f6f1f0a12'));
  });

  it('coalesces a burst into one experience that is rewritten, and starts another for another kind or after a pause', async () => {
    const { said, events, advance, touchMemories, speaker, store, clock } = await sqliteHarness();
    await said({ durationMs: 2_000 });
    expect(touchMemories()).toHaveLength(1);
    const id = touchMemories()[0]!.id;
    expect(touchMemories()[0]).toMatchObject({
      userMessage: touchEvidence(id), shannonReply: HEHE, observedAt: START,
      summary: `体の記憶: 10月2日の午後、ライ氏に頭をなでてもらった（合わせて2秒ほど）。ボクは「${HEHE}」と言った。`,
      disclosure: { audience: { kind: 'owner' }, sensitivity: 'ordinary', speaker: 'unknown' },
    });
    speaker.decision = { say: false, text: '', feeling: 'content' };
    for (let index = 0; index < 5; index += 1) {
      advance(40 * SECOND);
      await events({ id: `pat-${index}`, type: 'pet', audience: 'owner', occurredAt: clock.at, durationMs: 2_000 });
    }
    // Six pats, one memory, the same experience id.
    expect(touchMemories().map(item => item.id)).toEqual([id]);
    expect(touchMemories()[0]!.summary).toBe(`体の記憶: 10月2日の午後、ライ氏に頭をなでてもらった（たくさん、6回、合わせて12秒ほど）。ボクは「${HEHE}」と言った。`);
    // Another kind is another memory.
    await said({ type: 'poke', durationMs: 90, ongoing: false });
    expect(touchMemories().map(item => item.summary.slice(0, 40))).toEqual([
      expect.stringContaining('頭をなでてもらった'), expect.stringContaining('つつかれた'),
    ]);
    // The same kind after a pause longer than the gap is a new memory.
    advance(BODY_REACTION_LIMITS.burstGapMilliseconds + SECOND);
    await events({ id: 'pat-later', type: 'pet', audience: 'owner', occurredAt: clock.at });
    expect(touchMemories()).toHaveLength(3);
    expect(touchMemories()[0]!.summary).toContain('6回');
    // No Talk holds any of it, and nothing was learned about the owner from it.
    expect(store.listThreads(scope)).toEqual([]);
    for (const memory of touchMemories()) expect(ownerSpoke(memory.disclosure)).toBe(false);
    expect(store.snapshot(scope).userFacts).toEqual([]);
    expect(store.snapshot(scope).sharedDays ?? []).toEqual([]);
  });

  it('is found by the deterministic recall of a later conversation, and by full-text search with its rewritten text', async () => {
    const { said, events, advance, chat, store, touchMemories, clock } = await sqliteHarness();
    await said();
    for (let index = 0; index < 5; index += 1) {
      advance(30 * SECOND);
      await events({ id: `pat-${index}`, type: 'pet', audience: 'owner', occurredAt: clock.at, durationMs: 3_000 });
    }
    advance(3 * 60 * MINUTE);
    const summary = touchMemories()[0]!.summary;
    expect(summary).toContain('たくさん、6回');
    const turn = await chat('今日の午後、頭をなでたの覚えてる？');
    expect(promptOf(turn)).toContain(summary);
    // Full text: the index holds the rewritten memory, not its first wording.
    const hits = store.searchMemory(scope, 'なでてもらった');
    expect(hits.map(hit => hit.summary)).toEqual([summary]);
    // 「たくさん」 was not in its first wording: the rewritten text is what is indexed.
    expect(store.searchMemory(scope, 'たくさん')[0]?.id).toBe(touchMemories()[0]!.id);
    expect(store.searchMemory(scope, '午後 体の記憶').map(hit => hit.id)).toContain(touchMemories()[0]!.id);
    // The turn about it is an ordinary turn; the touch is still one memory.
    expect(touchMemories()).toHaveLength(1);
  });

  it('follows forgetting: a forgotten touch is not recalled, not told to the reaction model, and not continued', async () => {
    const { said, advance, chat, store, touchMemories, speaker, clock } = await sqliteHarness();
    await said();
    advance(40 * SECOND);
    await said();
    const memory = touchMemories()[0]!;
    expect(memory.summary).toContain('2回');
    advance(MINUTE);
    store.apply(scope, { type: 'memory-control-upserted', control: {
      memoryId: memory.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: clock.at, changeReason: 'ライ氏が忘れてと言った',
    } });
    expect(promptOf((await chat('さっき頭をなでたの覚えてる？')))).not.toContain('体の記憶');
    // The next touch does not continue the forgotten memory and is not told about it.
    advance(20 * SECOND);
    await said();
    const prompt = speaker.prompts.at(-1)!;
    expect(prompt).toContain('- 頭をなでられた: いまのが1回目');
    expect(prompt).toContain('- 直前にボクが言ったこと: なし');
    expect(touchMemories()).toHaveLength(2);
    expect(touchMemories()[0]).toMatchObject({ id: memory.id, summary: memory.summary });
    expect(touchMemories()[1]!.summary).not.toContain('回');
  });

  it('forgetting a touch from Memory hides that touch only: earlier conversation is still replayed and recalled', async () => {
    const { said, advance, chat, store, touchMemories, chatModel, clock } = await sqliteHarness();
    const earlier = await chat('来月、金沢へ旅行に行くんだ');
    advance(5 * MINUTE);
    await said();
    advance(5 * MINUTE);
    const memory = touchMemories()[0]!;
    new ShannonMemoryService(store, store, () => clock.at).mutate(scope, { memoryId: memory.id, action: 'forget' });
    // The rule that forgetting creates is narrow: one term that no reply contains, never "everything before now".
    const rule = memoryWithholdingRules(store.snapshot(scope)).find(item => item.memoryId === memory.id)!;
    expect(rule.wide).toBe(false);
    expect(rule.terms).toEqual([[touchEvidence(memory.id)]]);
    advance(MINUTE);
    const turn = await chat('金沢の旅行、覚えてる？');
    expect(turn.threadId).toBe(earlier.threadId);
    // The earlier turn is still in the replayed history and still recalled; the touch is gone.
    expect(chatModel.requests.at(-1)!.history.map(item => item.content)).toEqual(['来月、金沢へ旅行に行くんだ', 'はい、ライ氏。']);
    expect(promptOf(turn)).toContain('金沢へ旅行');
    expect(promptOf(turn)).not.toContain('体の記憶');
    expect(promptOf((await chat('頭をなでたの覚えてる？')))).not.toContain('体の記憶');
  });

  it('holds nothing from a microphone: only kinds, numbers, identifiers and her own words are stored', async () => {
    const { said, delegate, persist, path } = await sqliteHarness();
    const answer = await said();
    await delegate('秘密の合言葉はアルパカだよ', { reactionId: answer.id });
    await persist('秘密の合言葉はアルパカだよ', 'ふふ、覚えました。', { reactionId: answer.id });
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(path);
    for (const table of ['body_touches', 'body_touch_bursts', 'body_reactions']) {
      const rows = JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all());
      expect(rows, table).not.toContain('アルパカ');
      expect(rows, table).not.toContain('覚えました');
    }
    const columns = (table: string) => (database.prepare(`PRAGMA table_info('${table}')`).all() as unknown as Array<{ name: string }>).map(column => column.name);
    expect(columns('body_touches')).toEqual(['scope_key', 'touch_id', 'touch_type', 'audience', 'occurred_at', 'received_at', 'duration_ms', 'strength', 'burst_id', 'region', 'surface',
      // Touch vocabulary 2 (added 2026-10-06): closed words only.
      'part', 'side', 'gesture', 'reflex']);
    expect(columns('body_touch_bursts')).toEqual(['scope_key', 'burst_id', 'touch_type', 'started_at', 'last_at', 'touch_count', 'total_duration_ms', 'others', 'said_json', 'region', 'surface',
      // Stage 1b (2026-10-06): a flag, 1 once a touch of the burst was on a part where her body flinches first.
      'reflex']);
    // Stage 1b, the result table: closed words, identifiers and a time, never her words.
    expect(columns('body_touch_outcomes')).toEqual(['scope_key', 'touch_id', 'burst_id', 'audience', 'stance', 'feeling', 'said', 'decided_at']);
    expect(JSON.stringify(database.prepare('SELECT * FROM body_touch_outcomes').all())).not.toMatch(/アルパカ|覚えました|えへへ/u);
    database.close();
  });
});
