import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AFFECTION_GUARD_LINE, CHARACTER_CORE, CHARACTER_REGIONS, PERSONA_HEADER, characterCoreBlock, createInitialCompanionState, shannonIdentityPrompt,
  type CompanionStateSnapshot,
} from '@shannon/cognition';
import { SWITCHES, switchOn } from '@shannon/switches';
import { composedFeeling, feelingDayFeatures, spaceGuarded } from '../src/wiring/feelingWiring.js';
import { feelingBody, feelingText, feelingVoice } from '../src/mind/emotion/feelingPorts.js';
import {
  FeelingReplyChatModel, GUARD_SAFE_REPLY, REWRITE_DEADLINE_MILLISECONDS, STRONG_REWRITE_DEADLINE_MILLISECONDS,
} from '../src/infra/models/feelingStrongChatModel.js';
import { fakeFeelingJev } from './support/feelingHarness.js';

/** Her character space in the text turn (owner 2026-10-20; `SHANNON_CHARACTER_SPACE`, `SHANNON_AFFECTION_MAX`). */
const TODAY = '2026-10-25T11:00:00.000Z'; // 20:00 JST
const later = (minutes: number) => new Date(Date.parse(TODAY) + minutes * 60_000).toISOString();
const snapshot = (): CompanionStateSnapshot => ({ ...createInitialCompanionState('owner', '2026-10-20T03:00:00.000Z'),
  sharedDays: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'] });
// Her real identity with the v2 core, as `withCharacterCore` builds it.
const identity = shannonIdentityPrompt('owner', { characterCore: characterCoreBlock(CHARACTER_CORE) });
const v2Layered = () => ({ systemPrompt: identity, prompt: `${identity}\n\nほか` });

function composed(space: { max: boolean } | null, options: { turn?: boolean; stance?: string } = {}) {
  const jev = fakeFeelingJev(() => ({ stance: options.stance ?? 'neutral', intensity: 'subtle', drawer: 'none' }));
  const clock = { at: TODAY };
  const talk = () => [{ text: '昨日はChatGPTとも話してたよ', at: '2026-10-24T12:00:00.000Z' }];
  const configured = composedFeeling({ database: new DatabaseSync(':memory:'), now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: jev.chooser,
    turn: options.turn ?? true, singleFace: true, check: true, strong: { cap: 10, model: {} as never }, talk,
    days: { relationship: false, episodes: false, boundaries: false, ...(space ? { space } : {}) } });
  return { port: configured.port, jev, clock };
}

type Port = ReturnType<typeof composed>['port'];
const start = (port: Port, message: string, at = TODAY, alone = true) =>
  feelingText.start(port, { scopeKey: 'owner', alone, surface: false, message, begun: { occurredAt: at, captured: snapshot() } });

/** One turn through: start, block, route, and its events recorded with her reply. */
async function say(port: Port, message: string, at = TODAY) {
  const handle = start(port, message, at);
  const block = await feelingText.block(handle);
  const route = feelingText.route(handle);
  feelingText.ended(handle, { at, message, reply: 'うん。', experienceId: `x${at}${message}` });
  return { handle, block, route };
}

describe('her character space in a text turn', () => {
  it('is off by default; on, it needs the feeling turn and the reply check', () => {
    expect(switchOn({}, 'SHANNON_CHARACTER_SPACE')).toBe(false);
    expect(SWITCHES.find(entry => entry.name === 'SHANNON_CHARACTER_SPACE')?.requires).toEqual(['SHANNON_FEELING_TURN', 'SHANNON_INNER_NOTE', 'SHANNON_REPLY_CHECK']);
    expect(feelingDayFeatures({}).space).toBeUndefined();
    expect(feelingDayFeatures({ SHANNON_CHARACTER_SPACE: 'on' }).space).toEqual({ max: false });
    const max = feelingDayFeatures({ SHANNON_CHARACTER_SPACE: 'on', SHANNON_AFFECTION_MAX: 'on' });
    expect(spaceGuarded(max, true, true).space).toEqual({ max: true });
    expect(spaceGuarded(max, true, false).space).toBeUndefined();
    expect(spaceGuarded(max, false, true).space).toBeUndefined();
  });

  it('is nothing while off: no persona, no space core, no Sonnet for a plain turn', async () => {
    const { port } = composed(null);
    const { handle, block, route } = await say(port, '何してた？');
    expect(handle?.lines?.space).toBeUndefined();
    expect(block).not.toContain(PERSONA_HEADER);
    const layered = v2Layered();
    expect(feelingText.staged(handle, layered)).toBe(layered);
    expect(route.feelingStrong).toBeUndefined();
  });

  it('writes who she is now last, takes the space\'s core in place of v2, leans Jev, and sends the reply to Sonnet', async () => {
    const { port, jev } = composed({ max: false });
    const { handle, block, route } = await say(port, 'さすがシャノン、天才だね');
    expect(handle?.lines?.space?.selection.primary).toBe('smug');
    expect(block).toContain('いまのボク: ドヤ顔（得意げ）');
    expect(block).toContain(AFFECTION_GUARD_LINE);
    expect(block).toContain('[ライ氏とのこと]');
    expect(jev.states[0]).toMatchObject({ shannon_feeling: { persona: 'smug' } });
    expect(JSON.stringify(jev.questions[0])).toContain(CHARACTER_REGIONS.smug.lean.slice(0, 40));
    const staged = feelingText.staged(handle, v2Layered());
    expect(staged.systemPrompt).toMatch(/\[ボクの性格の核 v3-space #[0-9a-f]{8}\]/u);
    expect(staged.systemPrompt).not.toContain(characterCoreBlock(CHARACTER_CORE));
    expect(route.feelingStrong).toBe(true);
  });

  it('is swung by what happened and comes back within minutes: praise, then calm, the region recorded on her reply', async () => {
    const { port, clock } = composed({ max: false });
    const praised = await say(port, 'さすがシャノン、天才だね');
    expect(praised.handle?.lines?.space?.selection.primary).toBe('smug');
    const event = port.events.today('owner', TODAY, snapshot()).find(item => item.kind === 'own_reply');
    expect(event?.facts.region).toBe('smug');
    expect(port.events.today('owner', TODAY, snapshot()).find(item => item.kind === 'spoke')?.facts.cues).toEqual(['praise']);
    clock.at = later(25);
    const calm = await say(port, '何してた？', later(25));
    expect(calm.handle?.lines?.space?.selection.primary).toBe('cheeky_tsundere');
  });

  it('opens 本気 only while he holds 好意 at the top, and at 本気 a plain turn becomes 甘える and is checked before sending', async () => {
    const { port } = composed({ max: true });
    const { handle, block, route } = await say(port, '何してた？');
    expect(handle?.lines?.space?.selection.primary).toBe('devoted');
    expect(handle?.decision?.stance).toBe('affectionate');
    expect(block).toContain('いまのボク: 本気（心底惚れている）');
    expect(route.feelingCheck).toMatchObject({ region: 'devoted' });
  });

  it('at 本気 leaves her stance as it is while she pulls back: a touch after her no going on', async () => {
    const { port } = composed({ max: true });
    for (const minute of [0, 1, 2, 3]) {
      feelingBody.touched(port, 'owner', { id: `t${minute}`, type: 'poke', part: 'chest', audience: 'owner', occurredAt: later(minute - 10), burstId: `b${minute}` },
        minute === 0 ? { stance: 'dislike' } : {});
    }
    const handle = start(port, 'ただいま');
    await feelingText.block(handle);
    expect(handle?.decision?.stance).toBe('neutral');
  });

  it('takes at most 80% of the day\'s cap of strong replies, so a refusal later still finds Sonnet', async () => {
    const { port } = composed({ max: false });
    const strong: boolean[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      const handle = start(port, '何してた？');
      await feelingText.block(handle);
      strong.push(feelingText.route(handle).feelingStrong === true);
    }
    expect(strong.filter(Boolean)).toHaveLength(8); // cap 10
  });

  it('computes nothing for a voice turn, and never opens 本気 or 重い with anyone else there', async () => {
    const { port } = composed({ max: true });
    const voice = feelingVoice.start(port, { scopeKey: 'owner', alone: true, guest: false, threadId: 'v1', transcript: 'ただいま', at: TODAY, snapshot: snapshot() });
    expect(voice?.lines?.space).toBeUndefined();
    const others = start(port, 'こんにちは', TODAY, false);
    await feelingText.block(others);
    expect(others?.lines?.space?.selection.primary).not.toMatch(/devoted|heavy/u);
    expect(others?.lines?.carriedLines.join('\n') ?? '').not.toContain('[ライ氏とのこと]');
  });

  it('keeps what happened with him alone out of anyone else\'s turn (her mood is one, his moments are his)', async () => {
    const { port } = composed({ max: false });
    await say(port, '好きだよ');
    const others = start(port, 'こんにちは', later(1), false);
    await feelingText.block(others);
    expect(others?.lines?.space?.selection.primary).not.toBe('flustered');
    const owner = start(port, 'ねえ', later(1));
    expect(owner?.lines?.space?.selection.primary).toBe('flustered');
  });

  it('shows her region\'s face as her mood face', async () => {
    const { port } = composed({ max: false });
    const handle = start(port, 'ちょっと相談があるんだけど、仕事で困ってて');
    await feelingText.block(handle);
    const resolved = { expressiveEmotion: { primary: 'neutral', intensity: 0.2, visibility: 'hidden' }, messageEmotion: { expression: 'neutral', valence: 0,
      arousal: 0.4, openness: 0.5 } };
    const shown = feelingText.face(handle, resolved as never, snapshot(), TODAY);
    expect(handle?.lines?.space?.selection.primary).toBe('serious');
    if (handle?.decision?.stance === 'neutral') expect(shown.messageEmotion.expression).toBe('thinking');
  });
});

describe('the lines no region crosses, at the reply model', () => {
  it('waits for a Sonnet rewrite longer only in her space (off, as before)', () => {
    const model = new FeelingReplyChatModel({ mode: 'local-stub', model: 'fake', generate: async () => ({}) } as never, { sonnet: {} as never });
    const deadline = (request: object) => (model as unknown as { deadlineFor(request: object): number }).deadlineFor(request);
    expect(deadline({ feelingStrong: true, feelingCheck: { region: 'devoted' } })).toBe(STRONG_REWRITE_DEADLINE_MILLISECONDS);
    expect(deadline({ feelingStrong: true, feelingCheck: {} })).toBe(REWRITE_DEADLINE_MILLISECONDS);
    expect(deadline({ feelingCheck: { region: 'devoted' } })).toBe(REWRITE_DEADLINE_MILLISECONDS);
  });

  const context = { stance: 'sulk' as const, intensity: 'moderate' as const, audience: 'owner_alone' as const, order: false, violation: false, region: 'devoted' as const };
  const always = (reply: string) => ({ mode: 'local-stub' as const, model: 'fake', generate: async () => ({ mode: 'local-stub' as const, model: 'fake', reply }) });

  it('never sends a reply that still crosses one after its rewrite, nor one of a tool turn: she swallows it', async () => {
    const crossing = always('飲み会なんて行くな。');
    expect((await new FeelingReplyChatModel(crossing as never).generate({ scopeKey: 'owner', feelingCheck: context } as never)).reply).toBe(GUARD_SAFE_REPLY);
    const tool = new FeelingReplyChatModel(crossing as never, { ranTool: () => true });
    expect((await tool.generate({ scopeKey: 'owner', feelingCheck: context } as never)).reply).toBe(GUARD_SAFE_REPLY);
  });

  it('reads none of them while her space is off: a turn without a region is sent as before', async () => {
    const off = { ...context, stance: 'worry' as const, intensity: 'strong' as const, region: undefined };
    const caring = always('死にたいなんて言わないで。飲み会なんて行くな、今日は休んで。');
    expect((await new FeelingReplyChatModel(caring as never).generate({ scopeKey: 'owner', feelingCheck: off } as never)).reply)
      .toBe('死にたいなんて言わないで。飲み会なんて行くな、今日は休んで。');
  });
});
