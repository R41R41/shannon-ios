import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { shannonCapabilityPrompt } from '@shannon/cognition';
import { autonomyDayLog } from '../src/autonomyDayLog.js';
import { planFromThought } from '../src/autonomyLoopPlan.js';
import { CALL_TOOL, PHONE_FACTS_HEADER, phoneFactLines, type PhoneFacts } from '../src/autonomyLoopPhoneStep.js';
import { AUTONOMY_CALL_DOMAIN, authorizeAutonomousAction } from '../src/autonomyPolicy.js';
import { IncomingCallRequests } from '../src/incomingCallRequests.js';
import { IncomingCalls } from '../src/incomingCalls.js';
import { SQLiteIncomingCallStore } from '../src/incomingCallStore.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { SQLitePrivateListeningStore } from '../src/privateListeningStore.js';
import { SQLiteReachOutClaims } from '../src/reachOutClaims.js';
import { SQLiteReachOutSpeaker } from '../src/reachOutDelivery.js';
import { SQLiteReachOutReports } from '../src/reachOutReports.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import type { IncomingCallPayload } from '../src/incomingCallContract.js';
import type { VoipPushResult, VoipPushSender, VoipPushTarget } from '../src/voipPushSender.js';
import { FakeModel, FakeShowing, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

const directory = mkdtempSync(join(tmpdir(), 'shannon-phone-call-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const MINUTE = 60_000;
const START = '2026-10-03T01:00:00.000Z'; // 10:00 in Tokyo
const PHONE = 'phone-1';
const LINE = 'ライ氏、いま何をしていますか。ボクは少し気になりました。';
const CALL = { thought: 'ライ氏に電話で話したいことがあります。', steps: [{ action: 'call', reason: 'wonder' }] };
let databases = 0;

class FakeApns implements VoipPushSender {
  enabled = true;
  sent: Array<{ target: VoipPushTarget; payload: IncomingCallPayload }> = [];
  async send(target: VoipPushTarget, payload: IncomingCallPayload): Promise<VoipPushResult> {
    this.sent.push({ target, payload });
    return { delivered: true, invalidToken: false, status: 200, reason: null };
  }
}

/** Her loop and the API process on one database, with APNs as a list. `phoneDoes`: what his iPhone does when it rings. */
function world(options: { switchedOn?: boolean; serverReady?: boolean; intervalMinutes?: number; phoneDoes?: 'answer' | 'decline' | 'nothing'; apiRuns?: boolean } = {}) {
  const path = join(directory, `phone-${databases += 1}.sqlite`);
  const clock = { at: START };
  const now = () => clock.at;
  const persistent = new SQLiteShannonStore({ path, now });
  const initiatives = new SQLiteInitiativeStore(path, now);
  const speaker = new SQLiteReachOutSpeaker(path);
  const claims = new SQLiteReachOutClaims(path);
  const reports = new SQLiteReachOutReports(path);
  const listening = new SQLitePrivateListeningStore(path);
  const store = new SQLiteIncomingCallStore(path);
  const apns = new FakeApns();
  const threadId = persistent.threadId(scope);
  if (options.switchedOn !== false) {
    store.register(scope, PHONE, { deviceToken: 'ab'.repeat(32), environment: 'production', bundleId: 'com.r41r41.shannon', enabled: true }, START);
  }
  const phone = new IncomingCallRequests({
    store, claims, listeners: (scopeKey, at) => listening.listeners(scopeKey, at), bodyVisible: (scopeKey, at) => reports.windowVisible(scopeKey, at),
    serverReady: options.serverReady ?? true, minimumIntervalMilliseconds: (options.intervalMinutes ?? 5) * MINUTE,
  });
  const calls = new IncomingCalls({ store, claims, sender: apns, enabled: true, ownerScopeKey: scope, now, isPaired: () => true });
  const showing = new FakeShowing();
  const model = new FakeModel();
  const answered: string[] = [];
  /** Every pause of a step that waits: the API process looks, and the phone does what it does once it rang. */
  const onWait = async () => {
    if (options.apiRuns === false) return;
    await calls.tick();
    const ringing = store.openCalls(scope).find(call => call.state === 'ringing');
    if (!ringing) return;
    if (options.phoneDoes === 'answer') {
      const taken = calls.answer(scope, PHONE, ringing.initiativeId, ringing.callId);
      if (taken.kind === 'answered') answered.push(taken.message.content);
    } else if (options.phoneDoes === 'decline') {
      calls.report(scope, PHONE, ringing.callId, 'declined');
    }
  };
  const harness = loopHarness({
    path, clock, model, showing, reachOuts: speaker, phone, agentic: true, onWait,
    observer: { delivery: () => null, call: (scopeKey, id) => store.outcome(scopeKey, id), body: () => ({ windowVisible: false, owner: 'unknown', others: false }) },
    // She goes on with her own time a minute after he last spoke; a conversation in progress is still the last ten minutes.
    loop: { cycleIntervalMilliseconds: MINUTE, cyclesPerDay: 24, reachOutSpacingMilliseconds: 0, ownerActiveMilliseconds: MINUTE },
  });
  const messages = () => {
    const raw = new DatabaseSync(path);
    try {
      return raw.prepare(`SELECT role, content FROM conversation_messages WHERE scope_key = ? ORDER BY observed_at`).all(scope) as Array<{ role: string; content: string }>;
    } finally { raw.close(); }
  };
  const ownerSpeaks = () => {
    const raw = new DatabaseSync(path);
    try {
      raw.prepare(`
        INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 0, 'user', 'うん', ?, '{}')
      `).run(randomUUID(), scope, threadId, randomUUID(), clock.at);
    } finally { raw.close(); }
  };
  const cycle = async (plan: unknown, afterMinutes = 2) => {
    harness.advance(afterMinutes * MINUTE);
    model.plans = [plan];
    return runUntilIdle(harness.loop);
  };
  const recorded = () => [...harness.entries()].sort((left, right) => left.sequence - right.sequence);
  const callEntries = () => recorded().filter(entry => entry.tool === CALL_TOOL);
  return { ...harness, path, speaker, claims, callStore: store, apns, calls, phone, showing, model, initiatives, listening, reports, answered, messages, ownerSpeaks, cycle, recorded, callEntries, threadId };
}

describe('call: she phones him because she chose to', () => {
  it('offers the action and the facts of the moment only while he switched calls on', async () => {
    const off = world({ switchedOn: false });
    await off.cycle({ thought: '', steps: [{ action: 'rest' }] });
    const before = off.model.prompts('think')[0]!;
    expect(before).not.toContain('call（');
    expect(before).not.toContain(PHONE_FACTS_HEADER);
    expect(before).not.toContain('電話');

    const on = world();
    await on.cycle({ thought: '', steps: [{ action: 'rest' }] });
    const prompt = on.model.prompts('think')[0]!;
    expect(prompt).toContain('call（ライ氏のiPhoneに電話をかける。伝えたいことがあって、ライ氏がアプリを開いていない時のためのもの。ライ氏の電話が鳴り、出るかどうかはライ氏が選ぶ。');
    expect(prompt).toContain('かけたあとで、出てくれた・出ないことを選んだ・出なかった・つながらなかった、のどれだったかが分かる。');
    expect(prompt).toContain('{"action":"call","reason":"share"},');
    expect(prompt).toContain([
      PHONE_FACTS_HEADER,
      '- イヤホン: いま、ライ氏のイヤホンでアプリは聞かれていない。',
      '- 体: ボクの体（デスクトップ）が表示されているかは分からない。',
      '- 会話: いまは会話していない。',
      '- ライ氏が最後に書くか話すかしたのは: 記録がない。',
      '- 電話: いまかけられる。',
      '- 前の電話: まだかけたことがない。',
    ].join('\n'));
    expect(prompt).toContain('出ないことを選んだのは、ライ氏がいまは出ないと決めたということ。');

    // He switched it on and the server cannot send: she is told so, and the action is not there.
    const notReady = world({ serverReady: false });
    await notReady.cycle(CALL);
    const told = notReady.model.prompts('think')[0]!;
    expect(told).toContain('- 電話: いまはかけられない（サーバーの準備がまだ）。');
    expect(told).not.toContain('call（');
    expect(notReady.apns.sent).toEqual([]);
    expect(notReady.messages()).toEqual([]);
  });

  it('writes her line into the Talk, rings his iPhone, and learns that he answered', async () => {
    const w = world({ phoneDoes: 'answer' });
    await w.cycle(CALL);
    // Her opening line is a message of hers: the Talk, an initiative. Not one of the day's messages.
    expect(w.messages()).toEqual([{ role: 'assistant', content: LINE }]);
    const unread = w.initiatives.unreadMessages(scope);
    expect(unread).toEqual([expect.objectContaining({ content: LINE, kind: 'reach_out', reason: 'wonder', threadId: w.threadId })]);
    expect(w.speaker.sentOn(scope, '2026-10-03')).toBe(0);
    // One push, without a word of hers; the phone that answered was handed her line.
    expect(w.apns.sent).toHaveLength(1);
    expect(JSON.stringify(w.apns.sent)).not.toContain('気になりました');
    expect(w.answered).toEqual([LINE]);
    expect(w.callStore.outcome(scope, unread[0]!.id)).toBe('answered');
    // The record: the gate's decision in the call's own domain, and the action with what became of it. No word of hers.
    const entries = w.callEntries();
    expect(entries.map(entry => [entry.kind, entry.outcome, entry.domain, entry.tool])).toEqual([
      ['decision', 'allowed', AUTONOMY_CALL_DOMAIN, 'owner.call'], ['action', 'done', AUTONOMY_CALL_DOMAIN, 'owner.call'],
    ]);
    expect(entries[0]!.summary).toBe('持ち主のiPhoneに電話をかけます（理由: いま何をしているか気になった）。');
    expect(entries[1]!.summary).toBe('持ち主のiPhoneに電話をかけました（理由: いま何をしているか気になった）。出てくれました。');
    expect(entries[1]!.reasonCode).toBe('call_answered');
    expect(JSON.stringify(entries)).not.toContain('気になりました');
    // The line was worded by her own model call, told that it opens a phone call.
    expect(w.model.kinds().filter(kind => kind !== 'think')).toEqual(['reach_out']);
    expect(w.model.prompts('reach_out')[0]).toContain('[電話の最初の一言]');
    // He answered: she does not think again as after a message nobody answered.
    const observed = w.store.loop.observations.since(scope, START);
    expect(observed.at(-1)).toMatchObject({ step: 'reach_out', outcome: 'done', code: 'call_answered', reachOut: { call: 'answered', replied: true } });
    expect(w.model.kinds().filter(kind => kind === 'think')).toHaveLength(1);
    expect(autonomyDayLog(w.entries())).toContain('電話を1回かけ');
  });

  it('is told plainly when he chose not to answer or did not answer, and decides herself what follows', async () => {
    const declined = world({ phoneDoes: 'decline' });
    declined.model.plans = [];
    await declined.cycle(CALL);
    expect(declined.callEntries()[1]!.summary).toBe('持ち主のiPhoneに電話をかけました（理由: いま何をしているか気になった）。いまは出ないことを選ばれました。');
    // She thinks again, with what happened in front of her, and may write once more, look, jot, or let it go.
    const again = declined.model.prompts('think')[1]!;
    expect(again).toContain('- 電話の知らせ: iPhoneに電話をかけたが、ライ氏はいまは出ないことを選んだ。');
    expect(again).toContain('- 前の電話: たったいまにかけた。ライ氏は出ないことを選んだ。');
    expect(again).toContain('follow_up（');
    // Not at once again: the interval, and one call in a cycle.
    expect(again).toContain('- 電話: いまはかけられない（前の電話から間もない。あと約');
    expect(again).not.toContain('call（');
    // The message stays the call's, and stays text in the Talk.
    const id = declined.initiatives.unreadMessages(scope)[0]!.id;
    expect(declined.claims.holder(scope, id)?.surface).toBe('iphone_call');
    expect(declined.messages()).toEqual([{ role: 'assistant', content: LINE }]);

    const missed = world({ phoneDoes: 'nothing' });
    await missed.cycle(CALL);
    expect(missed.callEntries()[1]!).toMatchObject({ reasonCode: 'call_unanswered', summary: '持ち主のiPhoneに電話をかけました（理由: いま何をしているか気になった）。出ませんでした。' });
    expect(missed.model.prompts('think')[1]).toContain('- 電話の知らせ: iPhoneに電話をかけたが、ライ氏は出なかった。');
    // A later cycle, after the interval: she may call again, and is told how the last one ended.
    missed.advance(6 * MINUTE);
    await missed.cycle(CALL, 0);
    expect(missed.apns.sent).toHaveLength(2);
    expect(missed.model.prompts('think').some(prompt => prompt.includes('- 前の電話: 7分前にかけた。出なかった。') || prompt.includes('分前にかけた。出なかった。'))).toBe(true);
  });

  it('learns that it could not connect when the API process is not there, and her line stays in the Talk', async () => {
    const w = world({ apiRuns: false });
    await w.cycle(CALL);
    expect(w.apns.sent).toEqual([]);
    expect(w.callEntries()[1]!).toMatchObject({ outcome: 'done', reasonCode: 'call_failed' });
    expect(w.model.prompts('think')[1]).toContain('- 電話の知らせ: iPhoneに電話をかけようとしたが、つながらなかった。');
    expect(w.messages()).toEqual([{ role: 'assistant', content: LINE }]);
  });

  it('never calls into a conversation, while a call rings, or sooner than the interval', async () => {
    // He is talking: the action is not offered, and a plan that names it leads to nothing.
    const talking = world();
    talking.showing.repliedAt = new Date(Date.parse(START) - 5 * MINUTE).toISOString();
    await talking.cycle(CALL);
    expect(talking.model.prompts('think')[0]).toContain('- 電話: いまはかけられない（ライ氏と会話が続いている）。');
    expect(talking.model.prompts('think')[0]).not.toContain('call（');
    expect(talking.apns.sent).toEqual([]);
    expect(talking.messages()).toEqual([]);

    // He began to talk while her line was being worded: nothing is written and nothing rings.
    const began = world();
    began.model.during = kind => { if (kind === 'reach_out') began.showing.ownerActive = true; };
    await began.cycle(CALL);
    expect(began.messages()).toEqual([]);
    expect(began.apns.sent).toEqual([]);
    expect(began.callEntries().at(-1)).toMatchObject({ outcome: 'failed', reasonCode: 'conversation_in_progress' });

    // The gate itself refuses while a call may not be placed.
    const gate = world({ intervalMinutes: 30, phoneDoes: 'decline' });
    await gate.cycle(CALL);
    expect(gate.apns.sent).toHaveLength(1);
    gate.advance(10 * MINUTE);
    const refused = gate.service.authorize(scope, { domain: AUTONOMY_CALL_DOMAIN, summary: '電話をかけます。', tool: CALL_TOOL });
    expect(refused).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    await gate.cycle(CALL, 0);
    expect(gate.apns.sent).toHaveLength(1);
    gate.advance(21 * MINUTE);
    await gate.cycle(CALL, 0);
    expect(gate.apns.sent).toHaveLength(2);
  });

  it('is refused by the gate without the context of calls, when paused, and over budget', () => {
    const base = {
      enabled: true, paused: false, budget: { capYen: 100, spentYen: 0 }, isKnownModel: () => true,
      places: { hostFolders: {}, workspaceRoot: null, productionRoots: [], repositoryRoots: [], protectedPaths: [] },
      resolvePath: () => null, publicReadsToday: 0, maximumPublicReadsPerDay: 10,
    };
    const request = { domain: AUTONOMY_CALL_DOMAIN, summary: '持ち主のiPhoneに電話をかけます。', tool: CALL_TOOL };
    expect(authorizeAutonomousAction(request, base)).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    expect(authorizeAutonomousAction(request, { ...base, calls: { available: false } })).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    expect(authorizeAutonomousAction(request, { ...base, calls: { available: true } })).toMatchObject({ decision: 'allow', domain: AUTONOMY_CALL_DOMAIN });
    expect(authorizeAutonomousAction(request, { ...base, paused: true, calls: { available: true } }).decision).toBe('forbidden');
    expect(authorizeAutonomousAction({ ...request, paid: { model: 'm', estimatedCostYen: 500 } }, { ...base, calls: { available: true } }))
      .toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    // Calls are counted by nothing: a day's messages being used up does not stop one.
    expect(authorizeAutonomousAction(request, { ...base, calls: { available: true }, reachOuts: { today: 3, maximumPerDay: 3 } }).decision).toBe('allow');
  });

  it('plans one call at most, never beside a message of hers, and only with a reason from the closed set', () => {
    const known = { pursuits: [], pieces: [], unnotedReadingIds: [] };
    const bounds = { maximumSteps: 4, maximumReads: 1, notionAvailable: false, reachOut: { upcoming: false }, call: { upcoming: false } };
    const plan = (steps: unknown[], extra: Record<string, unknown> = {}) => planFromThought({ thought: '', steps }, known, { ...bounds, ...extra }).steps;
    expect(plan([{ action: 'call', reason: 'wonder', message: '勝手な言葉' }])).toEqual([{ kind: 'reach_out', reason: 'wonder', call: true }]);
    expect(plan([{ action: 'call', reason: 'wonder' }, { action: 'call', reason: 'share' }])).toHaveLength(1);
    expect(plan([{ action: 'reach_out', reason: 'wonder' }, { action: 'call', reason: 'wonder' }])).toEqual([{ kind: 'reach_out', reason: 'wonder' }]);
    expect(plan([{ action: 'call', reason: 'wonder' }, { action: 'reach_out', reason: 'wonder' }])).toEqual([{ kind: 'reach_out', reason: 'wonder', call: true }]);
    expect(plan([{ action: 'call' }])).toEqual([]);
    expect(plan([{ action: 'call', reason: 'follow_up' }])).toEqual([]);
    expect(plan([{ action: 'call', reason: 'upcoming' }])).toEqual([]);
    expect(plan([{ action: 'call', reason: 'saw' }])).toEqual([]);
    // Not offered: the action is unknown to the plan.
    expect(plan([{ action: 'call', reason: 'wonder' }], { call: null })).toEqual([]);
  });

  it('words the facts of the moment from closed values', () => {
    const facts: PhoneFacts = {
      switchedOn: true, serverReady: true, ringing: false, waitMinutes: 0, earphones: true, body: true,
      ownerLastActiveAt: '2026-10-03T00:48:00.000Z', last: { at: '2026-10-02T22:00:00.000Z', outcome: 'answered' },
    };
    expect(phoneFactLines(facts, { at: START, inConversation: false })).toEqual([
      '- イヤホン: いま、ライ氏にだけ聞こえるイヤホンでアプリを聞いている（reach_out は声でも届く）。',
      '- 体: ボクの体（デスクトップ）はいま表示されている。',
      '- 会話: いまは会話していない。',
      '- ライ氏が最後に書くか話すかしたのは: 12分前。',
      '- 電話: いまかけられる。',
      '- 前の電話: 3時間前にかけた。出てくれた。',
    ]);
    expect(phoneFactLines({ ...facts, ringing: true, last: { at: START, outcome: 'ringing' } }, { at: START, inConversation: false }).slice(-2)).toEqual([
      '- 電話: いまはかけられない（電話を鳴らしている最中）。', '- 前の電話: たったいまにかけた。まだ鳴らしている。',
    ]);
    expect(phoneFactLines({ ...facts, last: { at: START, outcome: 'failed' } }, { at: START, inConversation: true }).slice(-2)).toEqual([
      '- 電話: いまはかけられない（ライ氏と会話が続いている）。', '- 前の電話: たったいまにかけた。つながらなかった。',
    ]);
  });

  it('tells her in conversation too that she can phone him, and no longer names a count of messages a day', () => {
    const prompt = shannonCapabilityPrompt('owner');
    expect(prompt).toContain('- 電話: 自分の時間に伝えたいことがあって、ライ氏がアプリを開いていない時、ライ氏のiPhoneに電話をかける。電話が鳴り、出るかどうかはライ氏が選ぶ。ライ氏が着信をオンにしている時だけで、会話の中からはかけない。');
    expect(prompt).not.toContain('1日に数回まで');
    expect(shannonCapabilityPrompt('guest')).not.toContain('電話をかける');
  });
});
