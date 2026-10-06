import { describe, expect, it } from 'vitest';
import { preparePhoneCall, type AutonomyPhone } from '../src/autonomyLoopPhoneStep.js';
import { prepareReachOut, type AutonomyReachOuts } from '../src/autonomyLoopReachOutStep.js';
import { AutonomyToolResults } from '../src/autonomyLoopToolStep.js';
import { OWN_TIME_PRICES } from './ownerDocumentsScenario.js';
import { FakeModel, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

/**
 * Option (a) of the owner's decision of 2026-10-06 (Syzygy ADR-0007): a session that is not marked is given nothing marked in its
 * prompts (a note's or a piece's body, a story's title and change notes, a pursuit, the reason a marked session rested). Opening a
 * marked piece on purpose marks the session, and a marked session is given everything as before.
 */
const SENTINEL = { note: 'SENTINEL-NOTE-4K', story: 'SENTINEL-STORY-4K', pursuit: 'SENTINEL-PURSUIT-4K', rest: 'SENTINEL-REST-4K' };
const HOUR = 60 * 60_000;
const rest = { action: 'rest', resumeInMinutes: 120, reason: 'ここまで' };

function speaker() {
  const said: string[] = [];
  const state = { others: false };
  const reachOuts: AutonomyReachOuts = {
    sentOn: () => said.length, lastSentAt: () => null,
    audience: () => (state.others ? { instructions: '[ほかの人がいる場]', marker: '【機微:未分類】' } : null),
    say: (_scope, input) => { said.push(input.text); return 'sent'; },
    sayByPhone: (_scope, input) => { said.push(input.text); return 'sent'; },
    latest: () => null,
  };
  return { said, state, reachOuts };
}

/** Her study with one marked note, one marked story, one marked pursuit and a marked session that rested, beside what is not marked. */
function marked() {
  const voice = speaker();
  const harness = loopHarness({ sessions: true, toolResults: new AutonomyToolResults(), reachOuts: voice.reachOuts, environment: OWN_TIME_PRICES });
  const at = harness.clock.at;
  const note = harness.store.study.create(scope, { kind: 'note', title: '湖のメモ', body: `静かな湖のこと。${SENTINEL.note}` }, at);
  const plain = harness.store.study.create(scope, { kind: 'note', title: '駅のメモ', body: '夕方の駅は音から書く。' }, at);
  const story = harness.store.study.create(scope, { kind: 'story', title: SENTINEL.story, body: `${'湖のほとりの宿の話。'.repeat(12)}` }, at);
  if (typeof note === 'string' || typeof plain === 'string' || typeof story === 'string') throw new Error('study');
  const earlier = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], at);
  harness.store.loop.sessions.open(earlier);
  harness.store.informed.markSession(earlier.id, at);
  harness.store.pursuits.add(scope, { kind: 'question', title: SENTINEL.pursuit, why: '気になるからです。', origin: 'self' }, at);
  harness.store.informed.markPursuits(scope, at, at);
  harness.store.informed.markDocuments(scope, [`shannon-study://${note.id}`, `shannon-study://${story.id}`], earlier.id, at);
  harness.store.loop.sessions.close(earlier.id, { at, code: 'rest', resumeAt: at, reason: SENTINEL.rest });
  harness.store.loop.endCycle(earlier.id, 'rest', at);
  const session = async (plans: unknown[]) => {
    harness.advance(3 * HOUR);
    harness.model.plans = [...plans];
    await runUntilIdle(harness.loop, 40);
    return harness.store.loop.sessions.latestClosed(scope)!.cycleId;
  };
  return { harness, voice, note, plain, story, session };
}

const carries = (text: string) => Object.values(SENTINEL).filter(value => text.includes(value));

describe('a session that is not marked', () => {
  it('is given nothing marked in its thinking, draft and revise prompts, and a marked session is given everything', async () => {
    const { harness, note, story, session } = marked();
    const unmarked = await session([{ thought: '書きます。', steps: [{ action: 'draft', idea: '湖の話' }] }, { thought: '休みます。', steps: [rest] }]);
    expect(harness.store.informed.sessionInformedAt(unmarked)).toBeNull();
    for (const prompt of harness.model.prompts()) expect(carries(prompt)).toEqual([]);
    expect(harness.model.prompts('draft')[0]).toContain('夕方の駅は音から書く。');
    expect(harness.model.prompts('think')[0]).toContain('駅のメモ');

    // Revising the marked story is opening it on purpose: its body is given, and the session is marked.
    const calls = harness.model.calls.length;
    const revising = await session([{ thought: '直します。', steps: [{ action: 'revise', pieceId: story.id, aim: '静かに' }] }, { thought: '休みます。', steps: [rest] }]);
    expect(harness.model.prompts('revise')[0]).toContain('湖のほとりの宿の話。');
    // Only the piece she opened: no other marked note, pursuit or reason.
    expect(carries(harness.model.prompts('revise')[0]!)).toEqual([SENTINEL.story]);
    expect(harness.store.informed.sessionInformedAt(revising)).not.toBeNull();
    // The thought after it is a marked session's: the marked note, pursuit and story (its revision retitled it) are there.
    const after = harness.model.calls.slice(calls).filter(call => call.system.includes('[ひとりの時間]')).at(-1)!.prompt;
    expect(carries(after)).toEqual(expect.arrayContaining([SENTINEL.note, SENTINEL.pursuit]));
    expect(after).toContain(story.id);

    // Reading the marked note marks the session, and from then on its prompts carry it, the draft's included.
    const before = harness.model.calls.length;
    const reading = await session([
      { thought: '読みます。', steps: [{ action: 'tool', name: 'study.read', input: { id: note.id } }] },
      { thought: '書きます。', steps: [{ action: 'draft', idea: '湖の話' }] },
      { thought: '休みます。', steps: [rest] },
    ]);
    expect(harness.store.informed.sessionInformedAt(reading)).not.toBeNull();
    const later = harness.model.calls.slice(before).map(call => `${call.system}\n${call.prompt}`);
    expect(carries(later[0]!)).toEqual([]);
    expect(later.find(prompt => prompt.includes('[短い物語を書く]'))).toContain(SENTINEL.note);
  });

  it('gives a message or a phone call nothing marked, and with anyone else present not even a marked session does', async () => {
    const { harness, voice, plain } = marked();
    const phone: AutonomyPhone = {
      facts: () => ({ switchedOn: true, serverReady: true, ringing: false, waitMinutes: 0, earphones: false }) as never,
      request: () => 'requested', outcome: () => null,
    };
    const model = new FakeModel();
    const dependencies = { ...harness, loop: harness.loopConfig, model, reachOuts: voice.reachOuts, phone, now: () => harness.clock.at };
    const cycle = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], harness.clock.at);
    const worded = async (prepare: typeof prepareReachOut) => {
      const prepared = prepare(dependencies, cycle, { kind: 'reach_out', reason: 'share', call: true }, harness.clock.at)!;
      model.calls.length = 0;
      await prepared.perform({ model, reachOuts: voice.reachOuts, phone, showing: harness.showing }, harness.clock.at).catch(() => undefined);
      return `${model.calls[0]!.system}\n${model.calls[0]!.prompt}`;
    };
    for (const others of [true, false]) {
      voice.state.others = others;
      for (const prepare of [prepareReachOut, preparePhoneCall]) {
        const prompt = await worded(prepare);
        expect(prompt).toContain(plain.title);
        expect(carries(prompt), `${prepare.name} others=${others}`).toEqual([]);
      }
    }
    // A marked session alone with him is given what it marked; with someone else present it is held before anything is worded.
    harness.store.informed.markSession(cycle.id, harness.clock.at);
    voice.state.others = false;
    expect(await worded(prepareReachOut)).toContain(SENTINEL.note);
  });

  it('is not given the title or the address of a shared Notion page read in a marked session and not yet written up', async () => {
    const notion = { read: async () => ({ title: 'SENTINEL-NOTION-TITLE', url: 'https://www.notion.so/SENTINEL-NOTION-URL', text: '白ウサギの話。' }) };
    const harness = loopHarness({ sessions: true, notion, environment: OWN_TIME_PRICES });
    const session = async (plans: unknown[]) => {
      harness.advance(3 * HOUR);
      harness.model.plans = [...plans];
      await runUntilIdle(harness.loop, 40);
      return harness.store.loop.sessions.latestClosed(scope)!.cycleId;
    };
    // The note after it does not come out, so the page stays unwritten.
    harness.model.replies.note = { title: '', body: '' };
    const reading = await session([{ thought: 'Notionを読みます。', steps: [{ action: 'notion', query: 'ウサカテ' }] }, { thought: '休みます。', steps: [rest] }]);
    delete harness.model.replies.note;
    expect(harness.store.informed.sessionInformedAt(reading)).not.toBeNull();
    // Inside the marked session, the page is there to write up.
    expect(harness.model.prompts('think').at(-1)).toContain('SENTINEL-NOTION-TITLE');
    const calls = harness.model.calls.length;
    const unmarked = await session([{ thought: '休みます。', steps: [rest] }]);
    expect(harness.store.informed.sessionInformedAt(unmarked)).toBeNull();
    for (const call of harness.model.calls.slice(calls)) expect(`${call.system}\n${call.prompt}`).not.toMatch(/SENTINEL-NOTION/u);
    // Nor can it plan a note of it: the page is not among what it knows, so nothing of it is written in an unmarked session.
    const writing = await session([{ thought: 'メモにします。', steps: [{ action: 'note' }] }, { thought: '休みます。', steps: [rest] }]);
    expect(harness.store.informed.sessionInformedAt(writing)).toBeNull();
    expect(harness.store.study.list(scope).some(piece => piece.kind === 'note')).toBe(false);
  });
});
