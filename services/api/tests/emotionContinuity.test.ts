import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryCompanionStateStore, SHANNON_EMOTION_TIME, createInitialCompanionState, livingLingering, presentShannonFeeling,
  type CompanionStateSnapshot,
} from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { configuredAwakeClock } from '../src/autonomyAwakeClock.js';
import { TurnRefinementProcessor } from '../src/backgroundUpdates.js';
import { SHANNON_CORE_PATHS } from '../src/autonomyCore.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { emotionTiming } from '../src/emotionTiming.js';
import type { BodyPresence } from '../src/shannonBody.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { promptOf } from './modelPrompt.js';
import { apiSourceNames, apiSourcePath, importedModules, readApiSource } from './support/sources.js';

// Whole conversations through the kernel on a loaded machine: the default five seconds says nothing about the code.
vi.setConfig({ testTimeout: 30_000 });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const scope = 'owner';
/** 23:00 in the owner's zone, and nine hours later. */
const NIGHT = '2026-10-01T14:00:00.000Z';
const at = (from: string, milliseconds: number) => new Date(Date.parse(from) + milliseconds).toISOString();
const MORNING = at(NIGHT, 9 * HOUR);
const SULK = 'ボク、ちょっとすねちゃいます。';
const PLAIN = 'はい、わかりました。';
const LINE = 'まだ残っている気持ち';

class ScriptedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly voiceRequests: ShannonVoiceModelRequest[] = [];
  reply = PLAIN;
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: this.reply };
  }
  async generateVoice(request: ShannonVoiceModelRequest) {
    this.voiceRequests.push(request);
    return { mode: this.mode, model: this.model, reply: this.reply };
  }
}

function harness(start = NIGHT) {
  const clock = { at: start };
  const now = () => clock.at;
  const model = new ScriptedModel();
  // Built like the server builds it: with this process's timing.
  const stateStore = new InMemoryCompanionStateStore(now, emotionTiming());
  const conversationStore = new InMemoryConversationStore();
  const api = createLocalApiKernel(now, {
    chatModel: model, stateStore, conversationStore, body: { store: new SQLiteBodyStore(':memory:'), ingestEnabled: true },
  });
  const settle = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await api.waitForBackground(scope);
  };
  const chat = async (message: string, reply: string, extra: Record<string, unknown> = {}) => {
    model.reply = reply;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, message, ...extra }, deviceId: 'iphone' });
    await settle();
    return response.body as { messageEmotion: { expression: string }; state: Record<string, any>; systemPrompt: string };
  };
  const advance = (milliseconds: number) => { clock.at = at(clock.at, milliseconds); };
  const state = () => stateStore.snapshot(scope);
  const shown = async () => ((await api.dispatch({ method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: scope }) })).body) as
    CompanionStateSnapshot & { presence: { mood: { expression: string; cause: string; fromConversation: boolean } } };
  const body = async () => {
    await api.dispatch({ method: 'PUT', path: '/v1/body/capabilities', body: { scopeKey: scope, expressions: ['smile'], gestures: [] }, deviceId: 'body-pc' });
    return (await api.dispatch({ method: 'GET', path: '/v1/body/presence', query: new URLSearchParams({ scopeKey: scope }), deviceId: 'body-pc' })).body as BodyPresence;
  };
  const prompt = () => promptOf(model.requests.at(-1)!);
  return { clock, now, api, model, stateStore, conversationStore, chat, advance, state, shown, body, prompt, settle };
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'shannon-emotion-test-')), 'shannon.sqlite');
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('(a) continuity across conversations, text', () => {
  it('carries a sulk from the night into the first turn of the next morning, with its cause and for whom', async () => {
    const { chat, advance, state, prompt } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    expect(state().expressiveEmotion).toMatchObject({ primary: 'sulky', awakeAt: expect.any(Number) });
    expect(state().lingering).toMatchObject([{ kind: 'sulky', target: 'ライ氏' }]);
    const awakeAtNight = state().emotionClock!.awakeMs;

    advance(9 * HOUR);
    const morning = await chat('おはよう', 'おはようございます、ライ氏。');
    // The prompt of that first turn says what she still feels, why and for whom, and that it may show and resolve.
    expect(prompt()).toContain('いまの会話感情: sulky');
    expect(prompt()).toMatch(/まだ残っている気持ち: 9時間前にライ氏との会話ですねたことを、まだ少し引きずっている（sulky \/ 強さ 0\.4\d）。/u);
    expect(prompt()).toContain('謝罪ややさしい言葉、起きて過ごす時間で自然にほどけてよい。');
    // Her face for the reply and the state returned with it agree: still a little sulky.
    expect(morning.messageEmotion.expression).toBe('annoyed');
    expect(morning.state.presence.mood).toMatchObject({ expression: 'annoyed', fromConversation: true });
    // Nine hours of rest moved her clock by the idle cap only.
    expect(state().emotionClock!.awakeMs - awakeAtNight).toBe(SHANNON_EMOTION_TIME.idleCapMs);
    expect(state().expressiveEmotion!.primary).toBe('sulky');
  });

  it('(b) lets it fade over a few awake hours of conversation, a neutral reply counting as time awake', async () => {
    const { chat, advance, state, now } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    const versionBefore = state().version;
    for (let turnIndex = 0; turnIndex < 6; turnIndex += 1) {
      advance(10 * MINUTE);
      await chat('次の手順を教えて', PLAIN);
    }
    expect(presentShannonFeeling(state(), now(), emotionTiming())).toMatchObject({ primary: 'sulky' });
    expect(presentShannonFeeling(state(), now(), emotionTiming()).intensity).toBeLessThan(0.4);
    expect(state().version).toBeGreaterThan(versionBefore);
    for (let turnIndex = 0; turnIndex < 18; turnIndex += 1) {
      advance(10 * MINUTE);
      await chat('次の手順を教えて', PLAIN);
    }
    expect(presentShannonFeeling(state(), now(), emotionTiming()).primary).toBe('neutral');
    expect(state().lingering).toEqual([]);
    expect(state().emotionClock!.awakeMs).toBe(4 * HOUR);
  }, 30_000);

  it('resolves a hurt faster when the owner apologises: the refinement worker eases it, a new conversation alone does not', async () => {
    const { chat, advance, state, now, stateStore } = harness();
    stateStore.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'hurt', secondary: [], intensity: 0.8, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.3, valence: -0.7,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.24, carryover: 0.6, updatedAt: NIGHT,
    } });
    const strength = () => livingLingering(state(), now(), emotionTiming()).find(item => item.feeling.kind === 'hurt')?.strength ?? 0;
    advance(9 * HOUR);
    await chat('おはよう', PLAIN);
    const afterGreeting = strength();
    expect(afterGreeting).toBeGreaterThan(0.75);
    advance(MINUTE);
    await chat('昨日はごめん、言いすぎた', PLAIN);
    expect(strength()).toBeCloseTo(afterGreeting * 0.4, 1);
    expect(strength()).toBeLessThan(0.35);
  });
});

describe('(a) continuity across conversations, voice', () => {
  it('starts the next morning\'s call from what she still feels, through the same reading as text', async () => {
    const { api, chat, advance, state, model, now } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    advance(9 * HOUR);
    model.reply = 'おはようございます、ライ氏。';
    const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: scope, threadId: 'thread', transcript: 'おはよう' } });
    const plan = (response.body as { voicePlan: Record<string, any> }).voicePlan;
    // The greeting is answered brightly, a little more strongly than the sulk; the sulk stays beside it, in the plan and in the prompt.
    expect(plan.emotion).toMatchObject({ primary: 'bright', secondary: ['sulky'] });
    // The plan goes to a device: no cause, no clock stamp, and none of the resolver's notes to the reducer.
    for (const key of ['cause', 'awakeAt', 'continued', 'decided', 'presentAt']) expect(plan.emotion).not.toHaveProperty(key);
    expect(Object.keys(plan.emotion).sort()).toEqual(['arousal', 'carryover', 'decay', 'intensity', 'primary', 'secondary', 'startedAt', 'target', 'updatedAt', 'valence', 'visibility']);
    expect(promptOf(model.voiceRequests.at(-1)!)).toContain('primary=bright; secondary=sulky');
    expect(promptOf(model.voiceRequests.at(-1)!)).toMatch(/まだ残っている気持ち: 9時間前にライ氏との会話ですねたことを、まだ少し引きずっている/u);
    // A bright tone is not a mood: nothing covers the sulk underneath, and when the moment has passed she is sulking again.
    expect(state().lingering).toMatchObject([{ kind: 'sulky' }]);
    expect(state().lingering).toHaveLength(1);
    advance(8 * MINUTE);
    expect(presentShannonFeeling(state(), now(), emotionTiming())).toMatchObject({ primary: 'sulky', target: 'ライ氏' });
    // A voice turn that says nothing emotional carries it: the plan the voice acts with is the sulk.
    model.reply = 'はい、わかりました。';
    const next = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: scope, threadId: 'thread', transcript: '今日の予定を確認して' } });
    const held = (next.body as { voicePlan: Record<string, any> }).voicePlan;
    expect(held.emotion.primary).toBe('sulky');
    for (const key of ['cause', 'awakeAt', 'continued', 'decided', 'presentAt', 'underneath', 'easedPeak', 'heights', 'strengths']) expect(held.emotion).not.toHaveProperty(key);
    expect(JSON.stringify(next.body)).not.toMatch(/"continued"|"decided"|"presentAt"|"awakeAt"|"cause"|"heights"|"strengths"/u);
    // Carrying it through that turn stored nothing new: what is underneath is the entry from the night.
    expect(state().lingering).toMatchObject([{ kind: 'sulky', startedAt: NIGHT, strength: 0.52 }]);
  });
});

describe('nothing stays for weeks when she is rarely awake', () => {
  it('drops a sulk after four days on the wall clock: gone from the prompt, the app and the body', async () => {
    const { chat, advance, state, prompt, shown, body } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    advance(3 * 24 * HOUR);
    expect((await shown()).presence.mood).toMatchObject({ expression: 'annoyed', fromConversation: true });
    advance(2 * 24 * HOUR);
    expect((await shown()).presence.mood).toMatchObject({ fromConversation: false });
    expect((await body()).mood).toMatchObject({ primary: 'neutral', fromConversation: false });
    await chat('ひさしぶり', PLAIN);
    expect(prompt()).not.toContain(LINE);
    expect(prompt()).toContain('いまの会話感情: 落ち着いている');
    expect(state().lingering).toEqual([]);
  });
});

describe('(k) the app\'s 「いま」 and the body read the same continuous state', () => {
  it('shows the same feeling in GET /v1/state and GET /v1/body/presence the next morning', async () => {
    const { chat, advance, shown, body } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    advance(9 * HOUR);
    const state = await shown();
    expect(state.presence.mood).toMatchObject({ expression: 'annoyed', fromConversation: true });
    const presence = await body();
    expect(presence.mood).toMatchObject({ expression: 'annoyed', primary: 'sulky', fromConversation: true });
    expect(presence.mood.intensity).toBeGreaterThan(0.4);
    // The body gets the face, never a cause.
    expect(JSON.stringify(presence)).not.toContain('cause');
    expect(JSON.stringify(presence)).not.toContain('lingering');
    // Reading wrote nothing.
    expect((await shown()).emotionClock).toEqual(state.emotionClock);
  });
});

describe('(i) guests and (j) other people present', () => {
  it('lets a guest call neither read nor move her feeling toward the owner, nor her clock', async () => {
    const { api, chat, advance, state, model } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    const before = state();
    advance(30 * MINUTE);
    model.reply = 'えへへ、そんなこと言われると照れます。';
    const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: scope, threadId: 'thread', transcript: 'シャノン、声が可愛いね', participantMode: 'guest',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'g1', text: 'シャノン、声が可愛いね', source: 'speech', rawText: 'シャノン、声が可愛いね',
          callContext: { turns: [], introductionStart: true } } },
    } });
    const plan = (response.body as { voicePlan: Record<string, any> }).voicePlan;
    // The guest sees her reaction to them, not the sulk she has with the owner.
    expect(plan.emotion.primary).toBe('bashful');
    expect(plan.emotion.secondary).toEqual([]);
    expect(JSON.stringify(model.voiceRequests.at(-1))).not.toContain('sulky');
    expect(state()).toBe(before);
  });

  it('with others present shows the feeling, states no cause, and stores nothing', async () => {
    const { chat, advance, state, prompt, settle } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    advance(9 * HOUR);
    const before = state();
    const shared = await chat('友達と一緒にいるよ', 'えへへ、照れます。', { audience: 'others' });
    await settle();
    // What the model was given: neither the line about what lingers nor the feeling line with its cause.
    expect(prompt()).not.toContain(LINE);
    expect(prompt()).not.toContain('いまの会話感情');
    expect(prompt()).not.toContain('生成した応答の内容と会話文脈');
    // What the screen was given: the face, no cause, and none of the new fields.
    expect(shared.state.presence.mood.cause).toBe('');
    expect(shared.state.lingering).toBeUndefined();
    expect(shared.state.emotionClock).toBeUndefined();
    expect(promptOf(shared)).toBe('');
    // Her feeling toward the owner, what lies underneath and her clock did not move.
    expect(state()).toBe(before);
    // Alone again the line is back.
    await chat('ただいま', PLAIN);
    expect(prompt()).toContain(LINE);
  });
});

describe('(j) the owner\'s call while someone else can hear', () => {
  it('lets the feeling show and gives the model no cause, also when the cause is a touch; nothing is stored', async () => {
    const { api, stateStore, advance, state, model } = harness();
    for (const countInWindow of [1, 2, 3, 4]) {
      stateStore.apply(scope, { type: 'body-touched', touch: { kind: 'poke', countInWindow, ownerAlone: true } });
    }
    expect(state().lingering).toMatchObject([{ kind: 'sulky', cause: 'ライ氏につつかれた（続けて4回目）' }]);
    advance(9 * HOUR);
    const before = state();
    model.reply = 'はい、わかりました。';
    const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: scope, threadId: 'thread', transcript: '友達が一緒にいるよ、今日の天気は？' } });
    const prompt = promptOf(model.voiceRequests.at(-1)!);
    // She is still sulking and it may show in how she speaks.
    expect((response.body as { voicePlan: Record<string, any> }).voicePlan.emotion.secondary.concat(
      (response.body as { voicePlan: Record<string, any> }).voicePlan.emotion.primary)).toContain('sulky');
    expect(prompt).toContain('cause=withheld while others can hear');
    // Nor does the device, which others may be looking at, receive it.
    expect(JSON.stringify(response.body)).not.toMatch(/つつかれた|"cause"/u);
    expect(prompt).toContain('Do not say why you feel this way while others can hear.');
    // Neither the touch nor the line about what lingers reaches the model.
    expect(prompt).not.toContain('つつかれた');
    expect(prompt).not.toContain(LINE);
    expect(state()).toBe(before);
  });
});

describe('(g) an activity session keeps her awake', () => {
  it('advances her clock from the loop\'s process through the state store, content-free, and never from a dormant gap', () => {
    const path = databasePath();
    const clock = { at: NIGHT };
    const now = () => clock.at;
    const api = new SQLiteShannonStore({ path, now });
    api.snapshot(scope);
    api.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'sulky', secondary: [], intensity: 0.62, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.4, valence: -0.5,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.48, carryover: 0.5, updatedAt: NIGHT,
    } });
    const before = api.snapshot(scope);
    const events = api.events(scope).length;
    const loop = configuredAwakeClock(path, { now });

    // She rests for six hours, then works for forty minutes, one step every twenty seconds.
    clock.at = at(NIGHT, 6 * HOUR);
    for (let second = 0; second <= 40 * 60; second += 20) {
      clock.at = at(NIGHT, 6 * HOUR + second * 1_000);
      loop.observe(scope);
    }
    const after = api.snapshot(scope);
    // The six hours count as the idle cap, the session as itself.
    expect(after.emotionClock!.awakeMs - before.emotionClock!.awakeMs).toBe(SHANNON_EMOTION_TIME.idleCapMs + 40 * MINUTE);
    // Nothing else of the state moved, no version, no event row.
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.expressiveEmotion).toEqual(before.expressiveEmotion);
    expect(api.events(scope)).toHaveLength(events);
    // The sulk faded by that awake time and no more.
    const strength = livingLingering(after, clock.at)[0]!.strength;
    expect(strength).toBeCloseTo(0.62 * 0.5 ** (52 / 90), 3);

    // A scope the API never created is not created by the loop.
    loop.observe('someone-else');
    const raw = new DatabaseSync(path);
    expect((raw.prepare('SELECT COUNT(*) AS count FROM companion_states').get() as { count: number }).count).toBe(1);
    // A field this process does not know (a newer API wrote it) is written back as it was read.
    const stored = JSON.parse((raw.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scope) as { snapshot_json: string }).snapshot_json);
    raw.prepare('UPDATE companion_states SET snapshot_json = ? WHERE scope_key = ?').run(JSON.stringify({ ...stored, fromALaterVersion: { kept: true } }), scope);
    clock.at = at(clock.at, 5 * MINUTE);
    loop.observe(scope);
    const rewritten = JSON.parse((raw.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scope) as { snapshot_json: string }).snapshot_json);
    raw.close();
    expect(rewritten.fromALaterVersion).toEqual({ kept: true });
    expect(rewritten.emotionClock.awakeMs).toBe(stored.emotionClock.awakeMs + 5 * MINUTE);
    expect({ ...rewritten, emotion: 0, emotionClock: 0, lingering: 0, fromALaterVersion: 0 }).toEqual({ ...stored, emotion: 0, emotionClock: 0, lingering: 0, fromALaterVersion: 0 });
    loop.close();
    api.close();
  });

  it('opens nothing for a database without companion state and survives a database it cannot read', () => {
    const empty = databasePath();
    new DatabaseSync(empty).close();
    const loop = configuredAwakeClock(empty, { now: () => NIGHT });
    loop.observe(scope);
    const raw = new DatabaseSync(empty);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'`).get()).toEqual({ count: 0 });
    raw.close();
    loop.close();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missing = configuredAwakeClock(join(tmpdir(), 'shannon-emotion-test-missing', 'nowhere', 'shannon.sqlite'), { now: () => NIGHT });
    expect(() => { missing.observe(scope); missing.observe(scope); missing.close(); }).not.toThrow();
    expect(errors).toHaveBeenCalled();
    errors.mockClear();
    // A stored snapshot that cannot be parsed is logged by the name of the error only: its message can quote the snapshot.
    const path = databasePath();
    const store = new SQLiteShannonStore({ path, now: () => NIGHT });
    store.snapshot(scope);
    store.close();
    const broken = new DatabaseSync(path);
    broken.prepare('UPDATE companion_states SET snapshot_json = ? WHERE scope_key = ?').run('{"scopeKey":"owner","secret":"内緒の話" oops', scope);
    broken.close();
    const reader = configuredAwakeClock(path, { now: () => MORNING });
    reader.observe(scope);
    reader.close();
    expect(errors.mock.calls).toEqual([['Shannon awake clock failed', 'SyntaxError', '']]);
    errors.mockRestore();
  });

  it('repairs a clock that was stamped in the future, from the loop alone, and keeps the resolver\'s notes out of the event log', () => {
    const path = databasePath();
    const clock = { at: NIGHT };
    const api = new SQLiteShannonStore({ path, now: () => clock.at });
    api.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'sulky', secondary: [], intensity: 0.62, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.4, valence: -0.5,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.48, carryover: 0.5, updatedAt: NIGHT, continued: false, decided: true,
    } });
    expect(JSON.stringify(api.events(scope))).not.toMatch(/"continued"|"decided"|"presentAt"|"underneath"/u);
    // The machine's clock was a month ahead for one event.
    const raw = new DatabaseSync(path);
    const stored = JSON.parse((raw.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scope) as { snapshot_json: string }).snapshot_json);
    raw.prepare('UPDATE companion_states SET snapshot_json = ? WHERE scope_key = ?').run(
      JSON.stringify({ ...stored, emotionClock: { awakeMs: 0, at: at(NIGHT, 30 * 24 * HOUR) } }), scope);
    raw.close();
    const loop = configuredAwakeClock(path, { now: () => clock.at });
    for (let step = 1; step <= 5; step += 1) {
      clock.at = at(NIGHT, step * 5 * MINUTE);
      loop.observe(scope);
    }
    // The first step brought it back; the four after it counted.
    expect(api.snapshot(scope).emotionClock).toEqual({ awakeMs: 20 * MINUTE, at: at(NIGHT, 25 * MINUTE) });
    loop.close();
    api.close();
  });

  it('counts a stretch once when the API process and the loop process both write', () => {
    const path = databasePath();
    const clock = { at: NIGHT };
    const now = () => clock.at;
    const api = new SQLiteShannonStore({ path, now });
    api.snapshot(scope);
    api.apply(scope, { type: 'awake-observed' });
    const loop = configuredAwakeClock(path, { now });
    // Ten minutes in which a conversation and a session overlap: both processes write, in turn and at the same instants.
    for (let minute = 1; minute <= 10; minute += 1) {
      clock.at = at(NIGHT, minute * MINUTE);
      loop.observe(scope);
      api.apply(scope, { type: 'emotion-adjusted', delta: { arousal: 0.01 } });
      loop.observe(scope);
    }
    expect(api.snapshot(scope).emotionClock).toEqual({ awakeMs: 10 * MINUTE, at: at(NIGHT, 10 * MINUTE) });
    loop.close();
    api.close();
  });

  it('writes nothing under the kill switch', () => {
    vi.stubEnv('SHANNON_EMOTION_CLOCK', 'wall');
    const path = databasePath();
    const clock = { at: NIGHT };
    const api = new SQLiteShannonStore({ path, now: () => clock.at });
    const before = JSON.stringify(api.snapshot(scope));
    const loop = configuredAwakeClock(path, { now: () => clock.at });
    clock.at = at(NIGHT, HOUR);
    loop.observe(scope);
    expect(JSON.stringify(api.snapshot(scope))).toBe(before);
    loop.close();
    api.close();
  });
});

describe('(h) stored state from before the awake clock', () => {
  it('loads a stored row without the new fields, keeps everything in it, and adds them at the next event', () => {
    const path = databasePath();
    const first = new SQLiteShannonStore({ path, now: () => NIGHT, emotionTiming: { ...SHANNON_EMOTION_TIME, clock: 'wall' } });
    first.apply(scope, { type: 'emotion-adjusted', delta: { valence: 0.3 } });
    first.apply(scope, { type: 'interest-observed', interest: '物語' });
    first.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'happy', secondary: [], intensity: 0.7, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.5, valence: 0.6,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.48, carryover: 0.6, updatedAt: NIGHT,
    } });
    first.close();
    // Exactly what a deployed database holds today: no clock, nothing underneath, no awake stamp.
    const raw = new DatabaseSync(path);
    const stored = JSON.parse((raw.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scope) as { snapshot_json: string }).snapshot_json);
    raw.close();
    expect(stored.emotionClock).toBeUndefined();
    expect(stored.lingering).toBeUndefined();
    expect(stored.expressiveEmotion.awakeAt).toBeUndefined();

    const later = at(NIGHT, 2 * MINUTE);
    const restarted = new SQLiteShannonStore({ path, now: () => later });
    const loaded = restarted.snapshot(scope);
    expect(loaded).toMatchObject({ version: 3, interests: ['物語'], emotion: { valence: 0.3 }, expressiveEmotion: { primary: 'happy', intensity: 0.7 } });
    expect(loaded.emotionClock).toBeUndefined();
    expect(presentShannonFeeling(loaded, later, emotionTiming()).primary).toBe('happy');
    const next = restarted.apply(scope, { type: 'awake-observed' });
    expect(next.emotionClock).toEqual({ awakeMs: 0, at: later });
    expect(next.lingering).toEqual([]);
    expect(next.version).toBe(3);
    restarted.close();
    // Restart-safe: the next process reads what was written.
    const again = new SQLiteShannonStore({ path, now: () => later });
    expect(again.snapshot(scope).emotionClock).toEqual({ awakeMs: 0, at: later });
    again.close();
  });
});

describe('her concern for the owner is what every surface shows while it lasts', () => {
  it('answers his loss with concern in the reply, the returned state, the state read afterwards and the body, over a stronger sulk', async () => {
    const { chat, advance, shown, body, stateStore, state } = harness();
    stateStore.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'sulky', secondary: [], intensity: 0.8, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.4, valence: -0.6,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.48, carryover: 0.6, updatedAt: NIGHT,
    } });
    expect(state().lingering).toMatchObject([{ kind: 'sulky', strength: 0.8 }]);
    advance(MINUTE);
    const reply = await chat('父が亡くなった', 'そばにいます、ライ氏。');
    expect(reply.messageEmotion.expression).toBe('tender');
    expect(reply.state.presence.mood).toMatchObject({ expression: 'tender', fromConversation: true });
    expect((await shown()).presence.mood).toEqual(reply.state.presence.mood);
    expect((await body()).mood).toMatchObject({ expression: 'tender', primary: 'caring', fromConversation: true });
    advance(MINUTE);
    expect((await chat('……うん', PLAIN)).messageEmotion.expression).toBe('tender');
    // The sulk is still underneath for later.
    expect(state().lingering).toMatchObject([{ kind: 'sulky' }]);
  });
});

describe('an apology eases only on proof that it was his', () => {
  it('eases nothing when the refinement has no recorded turn of the owner\'s to go by', () => {
    const now = () => MORNING;
    const stateStore = new InMemoryCompanionStateStore(now, emotionTiming());
    const conversationStore = new InMemoryConversationStore();
    stateStore.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'hurt', secondary: [], intensity: 0.8, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.3, valence: -0.7,
      visibility: 'expressed', startedAt: MORNING, decay: 0.24, carryover: 0.6, updatedAt: MORNING,
    } });
    const processor = new TurnRefinementProcessor(stateStore, conversationStore);
    const strength = () => livingLingering(stateStore.snapshot(scope), MORNING, emotionTiming())[0]!.strength;
    // No recorded turn, and a turn id the store does not know: the lookup misses, and the easing fails closed.
    processor.process(scope, 'ごめんね', undefined, MORNING);
    processor.process(scope, 'ごめんね', 'no-such-turn', MORNING);
    expect(strength()).toBe(0.8);
    // A turn recorded with someone else present is not his alone either.
    const threadId = conversationStore.threadId(scope);
    const others = conversationStore.appendTurn(scope, threadId, 'ごめんね', 'はい。', MORNING, {
      messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' }, capturedStateVersion: 0,
      audience: { kind: 'people', personIds: [], unknownGuest: true }, speaker: 'unknown' });
    processor.process(scope, 'ごめんね', others.id, MORNING);
    expect(strength()).toBe(0.8);
    // His own recorded turn eases it.
    const own = conversationStore.appendTurn(scope, threadId, 'ごめんね', 'はい。', MORNING, {
      messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' }, capturedStateVersion: 0 });
    processor.process(scope, 'ごめんね', own.id, MORNING);
    expect(strength()).toBeCloseTo(0.32, 2);
  });
});

describe('the state returned with a reply agrees with the state read afterwards', () => {
  it('shows a reaction she is still having, held through a neutral reply, the same in both', async () => {
    const { chat, advance, shown, stateStore } = harness();
    stateStore.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'sad', secondary: [], intensity: 0.8, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.3, valence: -0.7,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.24, carryover: 0.6, updatedAt: NIGHT,
    } });
    advance(4 * MINUTE);
    const reply = await chat('うん', PLAIN);
    expect(reply.state.presence.mood).toMatchObject({ expression: 'sad', fromConversation: true });
    expect((await shown()).presence.mood).toEqual(reply.state.presence.mood);
  });
});

describe('(l) the kill switch SHANNON_EMOTION_CLOCK=wall', () => {
  it('restores the timing as it was: a night erases the mood, nothing lingers, nothing is shown', async () => {
    vi.stubEnv('SHANNON_EMOTION_CLOCK', 'wall');
    expect(emotionTiming().clock).toBe('wall');
    const { chat, advance, state, prompt, shown, body } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    expect(state().expressiveEmotion).toMatchObject({ primary: 'sulky' });
    expect(state().expressiveEmotion!.awakeAt).toBeUndefined();
    expect(state().lingering).toBeUndefined();
    expect(state().emotionClock).toBeUndefined();
    advance(9 * HOUR);
    const morning = await chat('おはよう', 'おはようございます、ライ氏。');
    expect(prompt()).toContain('いまの会話感情: 落ち着いている (前の気持ちは時間とともに落ち着いた)');
    expect(prompt()).not.toContain(LINE);
    expect(morning.messageEmotion.expression).toBe('calm');
    expect((await shown()).presence.mood).toMatchObject({ expression: 'calm', fromConversation: false });
    expect((await body()).mood).toMatchObject({ primary: 'neutral', fromConversation: false });
  });

  it('gives voice the stored feeling carried by the wall-clock rule, and no line about what lingers', async () => {
    vi.stubEnv('SHANNON_EMOTION_CLOCK', 'wall');
    const { api, chat, advance, state, model } = harness();
    await chat('今日はもう別のAIと話すね', SULK);
    advance(2 * MINUTE);
    model.reply = 'はい、わかりました。';
    const soon = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: scope, threadId: 'thread', transcript: '今日の予定を確認して' } });
    // Two minutes later the sulk still carries, as before: the resolver's own wording, not a continued reading.
    expect((soon.body as { voicePlan: Record<string, any> }).voicePlan.emotion).toMatchObject({ primary: 'sulky' });
    expect((soon.body as { voicePlan: Record<string, any> }).voicePlan.emotion.continued).toBeUndefined();
    expect(state().expressiveEmotion).toMatchObject({ primary: 'sulky', cause: '直前の感情が自然に続いている' });
    advance(9 * HOUR);
    const morning = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: scope, threadId: 'thread', transcript: '今日の予定を確認して' } });
    expect((morning.body as { voicePlan: Record<string, any> }).voicePlan.emotion.primary).not.toBe('sulky');
    for (const request of [...model.voiceRequests, ...model.requests]) expect(promptOf(request)).not.toContain(LINE);
    expect(model.voiceRequests.length + model.requests.length).toBeGreaterThanOrEqual(3);
    expect(state().lingering).toBeUndefined();
    expect(state().emotionClock).toBeUndefined();
  });

  it('reads the environment in one place, bounded, and falls back to the table', () => {
    expect(emotionTiming({})).toEqual(SHANNON_EMOTION_TIME);
    expect(emotionTiming({ SHANNON_EMOTION_CLOCK: 'WALL ' }).clock).toBe('wall');
    expect(emotionTiming({ SHANNON_EMOTION_CLOCK: ' Awake' }).clock).toBe('awake');
    expect(emotionTiming({ SHANNON_EMOTION_CLOCK: '  ' }).clock).toBe('awake');
    // A value that is neither word is a mistake at the kill switch: it means the old behaviour, and says so once, without the value.
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(emotionTiming({ SHANNON_EMOTION_CLOCK: 'wal' }).clock).toBe('wall');
    expect(emotionTiming({ SHANNON_EMOTION_CLOCK: 'wal' }).clock).toBe('wall');
    expect(emotionTiming({ SHANNON_EMOTION_CLOCK: 'off' }).clock).toBe('wall');
    expect(warnings.mock.calls).toEqual([
      ['SHANNON_EMOTION_CLOCK is neither "awake" nor "wall"; using "wall".'], ['SHANNON_EMOTION_CLOCK is neither "awake" nor "wall"; using "wall".'],
    ]);
    warnings.mockRestore();
    expect(emotionTiming({
      SHANNON_EMOTION_IDLE_MINUTES: '15', SHANNON_EMOTION_REACTION_HALF_LIFE_MINUTES: '0.5', SHANNON_EMOTION_PASSING_HALF_LIFE_MINUTES: '8',
      SHANNON_EMOTION_MOOD_HALF_LIFE_MINUTES: '120', SHANNON_EMOTION_MOOD_VALUE_HALF_LIFE_MINUTES: '180',
      SHANNON_EMOTION_AROUSAL_HALF_LIFE_MINUTES: '20', SHANNON_EMOTION_LINGERING_HALF_LIFE_HOURS: '12',
      SHANNON_EMOTION_LINGERING_MAX_WALL_DAYS: '2', SHANNON_EMOTION_EASED_HOLD_MINUTES: '45',
    })).toEqual({
      clock: 'awake', idleCapMs: 15 * MINUTE, reactionHalfLifeMs: 30_000, passingHalfLifeMs: 8 * MINUTE, moodHalfLifeMs: 120 * MINUTE,
      moodValueHalfLifeMs: 180 * MINUTE, arousalHalfLifeMs: 20 * MINUTE, lingeringHalfLifeMs: 12 * HOUR, lingeringMaxWallMs: 48 * HOUR,
      easedHoldMs: 45 * MINUTE,
    });
    // Nonsense, zero, negative and out-of-bound values leave the table's value.
    expect(emotionTiming({
      SHANNON_EMOTION_IDLE_MINUTES: '0', SHANNON_EMOTION_REACTION_HALF_LIFE_MINUTES: '-3', SHANNON_EMOTION_MOOD_HALF_LIFE_MINUTES: 'soon',
      SHANNON_EMOTION_LINGERING_HALF_LIFE_HOURS: '100000', SHANNON_EMOTION_LINGERING_MAX_WALL_DAYS: 'forever',
    })).toEqual(SHANNON_EMOTION_TIME);
    expect(SHANNON_EMOTION_TIME.lingeringMaxWallMs).toBe(4 * 24 * HOUR);
  });
});

describe('the emotion source stays core', () => {
  it('lists the new modules among the paths that need the owner\'s approval', () => {
    for (const path of ['packages/cognition/src/emotionTime.ts', 'packages/cognition/src/emotionContinuity.ts',
      apiSourcePath('emotionTiming.ts'), apiSourcePath('autonomyAwakeClock.ts'),
      // Syzygy ADR-0005 stage 1b: where only the reflex moves her (not the table), beside the table and its one entrance.
      'packages/cognition/src/touchEmotion.ts', apiSourcePath('bodyTouch.ts'), apiSourcePath('bodyTouchReflex.ts')]) {
      expect(SHANNON_CORE_PATHS.emotion).toContain(path);
    }
  });

  it('keeps one emotion state: the parts of the companion snapshot, and no table of its own', async () => {
    const path = databasePath();
    const store = new SQLiteShannonStore({ path, now: () => NIGHT });
    store.apply(scope, { type: 'expressive-emotion-updated', emotion: {
      primary: 'happy', secondary: [], intensity: 0.85, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.5, valence: 0.6,
      visibility: 'expressed', startedAt: NIGHT, decay: 0.48, carryover: 0.6, updatedAt: NIGHT,
    } });
    expect(Object.keys(store.snapshot(scope)).filter(key => /emotion|lingering/iu.test(key)).sort())
      .toEqual(['emotion', 'emotionClock', 'expressiveEmotion', 'lingering']);
    store.close();
    const raw = new DatabaseSync(path);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(row => row.name);
    raw.close();
    // The one such table is the owner's record of her mood over time (owner decision 2026-10-05, `moodHistory.ts`): written from
    // the stored state after it was written, and read back by nothing that builds a state, a prompt or a reply.
    expect(tables.filter(name => /emotion|feeling|mood|linger/iu.test(name))).toEqual(['shannon_mood_history']);
    // A fresh state has neither of the new parts until something happens.
    expect(Object.keys(createInitialCompanionState(scope, NIGHT)).filter(key => /emotion|lingering/iu.test(key))).toEqual(['emotion', 'expressiveEmotion']);
  });

  it('gives the loop\'s process one narrow write and nothing to read', () => {
    const source = (name: string) => readApiSource(name);
    const clock = source('autonomyAwakeClock.ts');
    // It opens no conversation store and no model, and its only event is the content-free one. After its write the mood
    // history may add a point of the state as written (`moodHistory.ts`, which imports no store either).
    expect(importedModules('autonomyAwakeClock.ts').sort())
      .toEqual(['@shannon/cognition', 'emotionTiming.ts', 'moodHistory.ts', 'moodHistoryContract.ts', 'node:sqlite']);
    expect(importedModules('moodHistory.ts').sort())
      .toEqual(['@shannon/cognition', 'moodHistoryContract.ts', 'node:sqlite']);
    expect(importedModules('moodHistoryContract.ts')).toEqual(['shannonNowContract.ts']);
    expect(clock).not.toMatch(/SQLiteShannonStore|conversationStore|chatModel|peopleMemory|OPENAI_API_KEY|GEMINI_API_KEY|INSERT |DELETE |CREATE /u);
    expect(clock.match(/type: '[a-z-]+'/gu)).toEqual(["type: 'awake-observed'"]);
    expect(clock.match(/UPDATE [a-z_]+ SET [a-z_]+ = \?/gu)).toEqual(['UPDATE companion_states SET snapshot_json = ?']);
    // What it hands the loop: two functions that return nothing.
    expect(clock).toMatch(/observe\(scopeKey: string\): void;\n  close\(\): void;/u);
    // Only the worker's entry file uses it; no module of the loop does, and the loop still imports nothing of her emotion.
    const names = apiSourceNames();
    expect(names.length).toBeGreaterThanOrEqual(360);
    expect(names.filter(name => importedModules(name).includes('autonomyAwakeClock.ts'))).toEqual(['autonomyWorker.ts']);
    for (const name of names.filter(file => file !== 'autonomyWorker.ts')) {
      if (/^autonomyLoop/u.test(name)) expect(source(name), name).not.toMatch(/presentShannonFeeling|expressiveEmotion|lingering|emotionTiming/u);
    }
    expect(source('autonomyWorker.ts').match(/awakeClock\.[a-z]+\(/gu)).toEqual(['awakeClock.observe(', 'awakeClock.close(']);
  });
});
