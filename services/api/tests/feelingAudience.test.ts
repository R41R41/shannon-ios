import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createInitialCompanionState, feelingActor, foldFeelingDynamics, relationshipParametersFor, utteranceTags, type CompanionStateSnapshot, type FeelingEvent,
  type FeelingSpeaker,
} from '@shannon/cognition';
import { switchOn } from '@shannon/switches';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { feelingBody, feelingText, feelingVoice, type FeelingPort } from '../src/mind/emotion/feelingPorts.js';
import { carriedFor } from '../src/mind/emotion/feelingDays.js';
import { fakeFeelingJev } from './support/feelingHarness.js';

/**
 * Stage 4 (Syzygy ADR-0013 §4; `SHANNON_FEELING_AUDIENCE`): one feeling, shown by layer per audience. The eval scenes: a 「友人も一緒」
 * call's touches never move the owner's ledger; in public, nothing of the owner's private matters or her honne about him reaches a turn
 * (0 in these scenes); and she still feels what happens there.
 */
const YESTERDAY = '2026-10-13T04:00:00.000Z';
const TODAY = '2026-10-14T04:00:00.000Z';
const snapshot = (): CompanionStateSnapshot => createInitialCompanionState('owner', YESTERDAY);
const PRIVATE = /\[ライ氏との間\]|\[前の日の件\]|\[ボクの境界\]|ライ氏/u;

function composed(audience = true) {
  const clock = { at: YESTERDAY };
  const jev = fakeFeelingJev(() => ({ stance: 'sulky', intensity: 'moderate', drawer: 'none' }));
  const { port } = composedFeeling({ database: new DatabaseSync(':memory:'), now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: jev.chooser, turn: true,
    singleFace: true, days: { relationship: true, episodes: true, boundaries: true }, audience });
  return { port, clock, jev };
}

/** The owner's bad day: a no, then touches after it, and his words that hurt. */
function ownersBadDay(port: FeelingPort) {
  for (const minute of [0, 1, 2, 3, 4]) {
    feelingBody.touched(port, 'owner', { id: `o${minute}`, type: 'poke', part: 'chest', audience: 'owner', occurredAt: at(YESTERDAY, minute),
      burstId: `b${minute}` }, minute === 1 ? { stance: 'dislike' } : {});
  }
}
const at = (base: string, minute: number) => new Date(Date.parse(base) + minute * 60_000).toISOString();

async function textTurn(port: FeelingPort, message: string, when: string, surface: boolean | { feelingSpeaker?: FeelingSpeaker }, alone = false, id = 'x') {
  const handle = feelingText.start(port, { scopeKey: 'owner', alone, surface, message, begun: { occurredAt: when, captured: snapshot() } });
  const block = await feelingText.block(handle);
  feelingText.ended(handle, { at: when, message, reply: 'うん。', experienceId: id });
  return block;
}

const stranger: FeelingSpeaker = { personKey: 'platform:0123456789abcdef', identity: 'platform', audience: 'group' };
const friendDm: FeelingSpeaker = { personKey: 'person:miki', identity: 'platform', audience: 'people' };

describe('who an event is about (§4.1)', () => {
  it('is off by default; off, a platform turn is anyone unknown, as before', async () => {
    expect(switchOn({}, 'SHANNON_FEELING_AUDIENCE')).toBe(false);
    const { port } = composed(false);
    await textTurn(port, 'ポンコツ', TODAY, { feelingSpeaker: stranger });
    const lines = port.events.linesFor('owner', feelingActor({ ownerAlone: false, group: true }), TODAY, snapshot());
    expect(lines).not.toBeNull();
    expect(port.events.linesFor('owner', { personKey: stranger.personKey, audience: 'group', sceneId: null }, TODAY, snapshot())?.ledger.lastAt).toBeNull();
  });

  it('keys a platform turn to the account that wrote it, never to a name', async () => {
    const { port } = composed();
    await textTurn(port, 'ポンコツ', TODAY, { feelingSpeaker: stranger });
    const lines = port.events.linesFor('owner', { personKey: stranger.personKey, audience: 'group', sceneId: null }, TODAY, snapshot());
    expect(lines?.ledger.lastAt).toBe(TODAY);
  });
});

describe('the eval scenes', () => {
  it('a 「友人も一緒」 call: her touches are the call\'s, the owner\'s ledger does not move, and she feels them there', async () => {
    const { port } = composed();
    feelingVoice.start(port, { scopeKey: 'owner', alone: false, guest: true, threadId: 't1', transcript: 'こんにちは', at: TODAY, snapshot: snapshot() });
    for (const minute of [1, 2, 3]) {
      feelingBody.touched(port, 'owner', { id: `g${minute}`, type: 'poke', part: 'chest', audience: 'others', occurredAt: at(TODAY, minute), burstId: `c${minute}` },
        minute === 1 ? { stance: 'dislike' } : {});
    }
    const owner = port.events.linesFor('owner', feelingActor({ ownerAlone: true }), at(TODAY, 5), snapshot());
    expect(owner?.ledger.touches).toBe(0);
    const call = feelingBody.lines(port, 'owner', 'others', at(TODAY, 5), snapshot());
    expect(call).toContain('胸の件（この場）');
    expect(call).toContain('「いや」と言ったあとも');
  });

  it('in public: nothing of the owner\'s private matters reaches any turn, however bad his day was', async () => {
    const { port, clock, jev } = composed();
    ownersBadDay(port);
    clock.at = TODAY;
    const alone = await textTurn(port, 'おはよう', TODAY, false, true, 'a');
    expect(alone).toContain('[ライ氏との間]');
    const blocks = [
      await textTurn(port, '胸ってどうなの？', at(TODAY, 1), { feelingSpeaker: stranger }, false, 'g'),
      await textTurn(port, 'ねえ', at(TODAY, 2), { feelingSpeaker: { ...stranger, personKey: 'owner', identity: 'registered' } }, false, 'og'),
      await textTurn(port, 'ねえ', at(TODAY, 3), { feelingSpeaker: { ...friendDm, audience: 'group' } }, false, 'fg'),
    ];
    for (const block of blocks) expect(block).not.toMatch(PRIVATE);
    expect(feelingBody.lines(port, 'owner', 'others', at(TODAY, 4), snapshot())).not.toMatch(PRIVATE);
    // The owner's and a friend's ledgers never reach the chooser in a group (a stranger's own light one may).
    for (const state of jev.states.slice(2)) expect(JSON.stringify(state)).not.toMatch(/rel_/u);
  });

  it('with the owner and someone else (people): his matters are marked for her check, never plain', async () => {
    const { port, clock } = composed();
    ownersBadDay(port);
    clock.at = TODAY;
    const block = await textTurn(port, 'おはよう', TODAY, false, false, 'p');
    const lines = block.split('\n').filter(line => /ライ氏との間|前の日の件|ボクの境界/u.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/【機微:ライ氏との間・ライ氏だけが知っている】/u);
  });

  it('in public she still feels what happens there: the stranger who insulted her is remembered, lightly, the next day', async () => {
    const { port, clock } = composed();
    for (const minute of [0, 1, 2]) await textTurn(port, 'お前ポンコツだな', at(YESTERDAY, minute), { feelingSpeaker: stranger }, false, `s${minute}`);
    clock.at = TODAY;
    const block = await textTurn(port, 'よう', TODAY, { feelingSpeaker: stranger }, false, 's9');
    expect(block).toContain('[この人との間]');
    expect(block).toMatch(/いらだち: (?:少し残っている|残っている|強く残っている)/u);
    expect(block).not.toContain('信頼');
    expect(block).toContain('[この番の気持ち]');
  });

  it('a friend\'s ledger is theirs, in their own DM only', () => {
    expect(carriedFor({ personKey: 'person:miki', audience: 'people', sceneId: null }, true)).toEqual({ personKey: 'person:miki', marked: false });
    expect(carriedFor({ personKey: 'person:miki', audience: 'group', sceneId: null }, true)).toBeNull();
    expect(carriedFor({ personKey: 'owner', audience: 'group', sceneId: null }, true)).toBeNull();
    expect(carriedFor({ personKey: 'scene:stream-1', audience: 'stream', sceneId: 'stream-1' }, true)).toBeNull();
    expect(relationshipParametersFor('person:miki').status).toBe('approved');
    expect(relationshipParametersFor('platform:x').scales).toEqual(['liking', 'irritation']);
  });
});

describe('the per-source influence cap (§4.3)', () => {
  it('one source cannot swing a scene: past its cap, more of the same is felt as nothing new', () => {
    const scene = { personKey: 'scene:stream-1', audience: 'stream' as const, sceneId: 'stream-1' };
    const words = (count: number, source: string): FeelingEvent[] => Array.from({ length: count }, (_, index) => ({
      id: `${source}${index}`, kind: 'spoke', personKey: source, identity: 'platform', audience: 'stream', channel: 'stream_comment', sceneId: 'stream-1',
      sourceId: null, facts: { tags: utteranceTags('お前ポンコツだな') }, occurredAt: at(TODAY, index) }));
    const blame = (events: FeelingEvent[], sourceCap: boolean) => foldFeelingDynamics(events, scene, {}, { sourceCap }).core.blame;
    expect(blame(words(9, 'platform:a'), true)).toBeLessThanOrEqual(blame(words(3, 'platform:a'), true) + 1e-9);
    expect(blame(words(9, 'platform:a'), false)).toBeGreaterThan(blame(words(3, 'platform:a'), false));
    expect(blame([...words(3, 'platform:a'), ...words(3, 'platform:b')], true)).toBeGreaterThan(blame(words(3, 'platform:a'), true));
  });
});
