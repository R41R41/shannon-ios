import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AutonomyRoomLooks } from '../src/autonomyLoopLookStep.js';
import { followUpPrompt, rethinkExtras } from '../src/autonomyLoopObservePrompts.js';
import { draftPrompt, notePrompt, reachOutPrompt, revisePrompt, roomLookNotePrompt, thinkingPrompt } from '../src/autonomyLoopPrompts.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { SQLiteReachOutSpeaker } from '../src/reachOutDelivery.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { FULL_PLAN, FakeModel, FakeShowing, callKind, loopHarness, runUntilIdle, scope, type LoopHarnessOptions } from './autonomyLoopHarness.js';

/**
 * One fixed day of her own activity, with every step kind and every optional part of a prompt, run with the
 * fixed cycles and without the owner's context. The same file was run on the commit before sessions and the
 * owner's context existed (78c3493); `autonomyLoopKillSwitch.test.ts` holds the digests it produced there.
 * Identifiers are random, so they are replaced before a prompt is digested; nothing else is.
 */
const MINUTE = 60_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;

export function digest(text: string): string {
  return createHash('sha256').update(text.replace(UUID, 'ID')).digest('hex').slice(0, 16);
}

export interface ScenarioCall { kind: string; digest: string }

/** The loop with act → observe → think again on: every prompt it sends, in order. */
export async function agenticDay(directory: string, extra: Partial<LoopHarnessOptions> = {}): Promise<ScenarioCall[]> {
  const path = join(directory, 'kill-switch-agentic.sqlite');
  const clock = { at: '2026-10-02T01:00:00.000Z' };
  const now = () => clock.at;
  const persistent = new SQLiteShannonStore({ path, now });
  const initiatives = new SQLiteInitiativeStore(path, now);
  const speaker = new SQLiteReachOutSpeaker(path, () => others);
  let others = false;
  const model = new FakeModel();
  const looks: AutonomyRoomLooks = {
    available: () => true,
    look: async () => ({ outcome: 'seen', text: '椅子は空いていて、画面だけがついていました。', usage: { inputTokens: 2_000, outputTokens: 80 } }),
  };
  const notion = { read: async () => ({ title: '登場人物', url: 'https://www.notion.so/p1', text: '白ウサギの話。時計を持って走っている。' }) };
  const harness = loopHarness({
    path, clock, model, showing: new FakeShowing(), reachOuts: speaker, agentic: true, looks, notion,
    roomLooks: () => ({ lastHour: 0, maximumPerHour: 6, today: 0, maximumPerDay: 30 }),
    upcoming: { lines: () => [{ kindLabel: '予定', title: '歯医者', when: '今日 15:00〜16:00' }, { kindLabel: '約束', title: '母に電話する', when: '今日 17:00' }] },
    environment: { SHANNON_AUTONOMY_MAX_REACH_OUTS: '6', SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"mac":{"deviceId":"0123456789abcdef"}}' },
    ...extra, loop: { cycleIntervalMilliseconds: MINUTE, cyclesPerDay: 24, reachOutSpacingMilliseconds: 0, ...extra.loop },
  });
  const cycle = async (plans: unknown[], minutes = 10) => {
    harness.advance(minutes * MINUTE);
    model.plans = [...plans];
    await runUntilIdle(harness.loop);
  };
  // She speaks up; nobody answers, so she thinks again, looks, thinks again and calls once more.
  await cycle([
    { thought: '気になります。', steps: [{ action: 'reach_out', reason: 'wonder' }] },
    { thought: '見てみます。', steps: [{ action: 'look' }] },
    { thought: 'もう一度だけ。', steps: [{ action: 'follow_up' }] },
  ]);
  // Read, note, speak up about it; nobody answers, and she writes down what she thinks.
  await cycle([
    { ...FULL_PLAN, steps: [...FULL_PLAN.steps.slice(0, 2), { action: 'reach_out', reason: 'share' }] },
    { thought: '書き留めます。', steps: [{ action: 'jot', text: '返事がなくても、気にしないでおこう。' }] },
  ]);
  await cycle([{ thought: '書きます。', steps: [{ action: 'notion', query: 'ウサカテ' }, { action: 'note' }, { action: 'draft', idea: '誰もいない駅に残された傘の話' }] }]);
  const piece = harness.store.study.list(scope).find(item => item.kind === 'story')!;
  await cycle([{ thought: '見せます。', steps: [{ action: 'ready', pieceId: piece.id }, { action: 'copy' }] }]);
  harness.service.study.react(scope, piece.id, 'like', '傘の場面が好きです。');
  await cycle([{ thought: '直します。', steps: [{ action: 'revise', pieceId: piece.id, aim: '終わりを静かにする' }, { action: 'reach_out', reason: 'upcoming' }] }, { thought: 'そのままにします。', steps: [{ action: 'rest' }] }]);
  // Someone else is with him now: the message carries the speak-time check and the markers.
  others = true;
  await cycle([{ thought: '見て、話します。', steps: [{ action: 'look' }, { action: 'reach_out', reason: 'saw' }] }, { thought: 'そのままにします。', steps: [{ action: 'rest' }] }]);
  others = false;
  await cycle([{ thought: '気になります。', steps: [{ action: 'reach_out', reason: 'wonder' }, { action: 'put_away', pieceId: piece.id }] }, { thought: 'そのままにします。', steps: [{ action: 'rest' }] }]);
  await cycle([{ thought: '休みます。', steps: [{ action: 'rest' }] }], 60);
  const calls = model.calls.map(call => ({ kind: callKind(call), digest: digest(`${call.system}\n---\n${call.prompt}`) }));
  harness.store.close(); speaker.close(); initiatives.close(); persistent.close();
  return calls;
}

/** The loop with act → observe → think again off as well: the loop as it first was. */
export async function plainDay(directory: string): Promise<ScenarioCall[]> {
  const path = join(directory, 'kill-switch-plain.sqlite');
  const clock = { at: '2026-10-02T04:00:00.000Z' };
  const now = () => clock.at;
  const persistent = new SQLiteShannonStore({ path, now });
  const initiatives = new SQLiteInitiativeStore(path, now);
  const speaker = new SQLiteReachOutSpeaker(path);
  const model = new FakeModel();
  const harness = loopHarness({
    path, clock, model, reachOuts: speaker,
    upcoming: { lines: () => [{ kindLabel: '予定', title: '歯医者', when: '今日 15:00〜16:00' }] },
    loop: { cycleIntervalMilliseconds: MINUTE, cyclesPerDay: 24, reachOutSpacingMilliseconds: 0 },
  });
  model.plans = [{ ...FULL_PLAN, steps: [...FULL_PLAN.steps, { action: 'reach_out', reason: 'upcoming' }] }];
  await runUntilIdle(harness.loop);
  harness.advance(10 * MINUTE);
  model.plans = [{ thought: '気になります。', steps: [{ action: 'reach_out', reason: 'wonder' }] }];
  await runUntilIdle(harness.loop);
  const calls = model.calls.map(call => ({ kind: callKind(call), digest: digest(`${call.system}\n---\n${call.prompt}`) }));
  harness.store.close(); speaker.close(); initiatives.close(); persistent.close();
  return calls;
}

/** Every prompt builder with fixed input and none of the new options. */
export function builderDigests(): Record<string, string> {
  const pursuit = { id: 'p1', kind: 'question' as const, title: '傘は誰のものか', why: '気になるからです。', status: 'active' as const, origin: 'self' as const, links: [], createdAt: 'x', updatedAt: 'x' };
  const materials = {
    localTime: '2026年10月2日(金) 13時', remainingYen: 812.4, remainingReads: 190, maximumSteps: 5, pursuits: [pursuit],
    stories: [{ id: 's1', title: '傘のある駅', statusLabel: '下書き', version: 2, characters: 812, lastChange: '終わりを直しました。' }],
    notes: [{ title: '駅の光', excerpt: '光が低いと懐かしい。', sourceUrl: 'https://example.org/station' }, { title: '見たこと（10月2日 10時）', excerpt: '机に本が積んである。', seen: true as const }],
    unnotedReadings: [{ id: 'r1', title: '随筆', url: 'https://example.org/essay' }],
    feedback: [{ pieceId: 's1', pieceTitle: '傘のある駅', version: 1, reactionLabel: '好き', comment: '傘がいいです。' }],
    places: [{ title: '青空文庫', url: 'https://www.aozora.gr.jp/' }], notionAvailable: true, folderAvailable: true, lookAvailable: true,
    reachOut: { remaining: 2 }, upcoming: [{ kindLabel: '予定', title: '歯医者', when: '今日 15:00〜16:00' }],
  };
  const bare = { localTime: 'x', remainingYen: 0, remainingReads: 0, maximumSteps: 1, pursuits: [], stories: [], notes: [], unnotedReadings: [], feedback: [], places: [], notionAvailable: false };
  const extras = rethinkExtras({
    at: '2026-10-02T04:10:00.000Z', timeZone: 'Asia/Tokyo', planned: ['draft', 'note'],
    happened: [{ id: 'o1', cycleId: 'c1', ordinal: 1, step: 'read', outcome: 'failed', observedAt: '2026-10-02T04:05:00.000Z' }],
    pending: { followUp: true, look: true, thinkAfterLook: true },
  });
  const others = { instructions: '[ほかの人がいる場]\n確かめてから話す。', marker: '【機微:未分類・ライ氏だけが知っている】' };
  const prompts = {
    thinking: thinkingPrompt(materials), thinkingBare: thinkingPrompt(bare), thinkingNull: thinkingPrompt(materials, null), thinkingAgain: thinkingPrompt(materials, extras),
    note: notePrompt({ pursuit, reading: { title: '随筆', url: 'https://example.org/essay', text: '夕方の駅では、光が低く差しこむ。' } }),
    draft: draftPrompt({ idea: '傘の話', pursuit, notes: materials.notes }),
    draftBare: draftPrompt({ idea: '', pursuit: null, notes: [] }),
    revise: revisePrompt({ aim: '終わり', piece: { title: '傘のある駅', body: '本文', version: 1 }, feedback: [{ reactionLabel: '好き', comment: '傘がいいです。', version: 1 }], notes: materials.notes }),
    look: roomLookNotePrompt(),
    share: reachOutPrompt({ reason: 'share', localTime: '13時5分', notes: materials.notes.slice(0, 1), stories: [{ title: '傘のある駅', statusLabel: '下書き' }] }),
    wonder: reachOutPrompt({ reason: 'wonder', localTime: '13時5分' }),
    upcoming: reachOutPrompt({ reason: 'upcoming', localTime: '13時5分', upcoming: materials.upcoming, others }),
    saw: reachOutPrompt({ reason: 'saw', localTime: '13時5分', seen: '机に本が積んである。', others }),
    followUp: followUpPrompt({ localTime: '13時9分', happened: ['- 3分前（13:05）にライ氏へ話しかけた。'], said: 'ライ氏、いま何をしていますか。', seen: '椅子は空いている。', others }),
  };
  return Object.fromEntries(Object.entries(prompts).map(([name, prompt]) => [name, digest(`${prompt.system}\n---\n${prompt.prompt}`)]));
}
