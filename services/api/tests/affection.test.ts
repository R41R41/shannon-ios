import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AFFECTION_GUARD_LINE, CHARACTER_CORE, characterCoreBlock, createInitialCompanionState, type AffectionSetting, type CompanionStateSnapshot,
} from '@shannon/cognition';
import { SWITCHES, switchOn } from '@shannon/switches';
import { affectionGuarded, composedFeeling, feelingDayFeatures } from '../src/wiring/feelingWiring.js';
import { feelingText } from '../src/mind/emotion/feelingPorts.js';
import { STAGE_LEAN } from '../src/contracts/feelingEventContract.js';
import { FeelingReplyChatModel, GUARD_SAFE_REPLY } from '../src/infra/models/feelingStrongChatModel.js';
import { fakeFeelingJev } from './support/feelingHarness.js';

/** Her affection in the text turn (owner 2026-10-20; `SHANNON_AFFECTION`, `SHANNON_AFFECTION_STAGE`). */
const TODAY = '2026-10-25T03:00:00.000Z'; // 12:00 JST
const snapshot = (): CompanionStateSnapshot => ({ ...createInitialCompanionState('owner', '2026-10-20T03:00:00.000Z'),
  sharedDays: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'] });
const v2Layered = () => ({ systemPrompt: `[シャノンの人格]\n${characterCoreBlock(CHARACTER_CORE)}`, prompt: `${characterCoreBlock(CHARACTER_CORE)}\n\nほか` });

function composed(affection: AffectionSetting, options: { turn?: boolean; stance?: string } = {}) {
  const jev = fakeFeelingJev(() => ({ stance: options.stance ?? 'neutral', intensity: 'subtle', drawer: 'none' }));
  const database = new DatabaseSync(':memory:');
  const talk = () => [{ text: '昨日はChatGPTとも話してたよ', at: '2026-10-24T12:00:00.000Z' }];
  const configured = composedFeeling({ database, now: () => TODAY, timeZone: 'Asia/Tokyo', chooser: jev.chooser, turn: options.turn ?? true,
    singleFace: false, check: true, strong: { cap: 5, model: {} as never }, talk,
    days: { relationship: false, episodes: false, boundaries: false, affection } });
  return { port: configured.port, jev, database };
}

const start = (port: ReturnType<typeof composed>['port'], message: string, alone = true) =>
  feelingText.start(port, { scopeKey: 'owner', alone, surface: false, message, begun: { occurredAt: TODAY, captured: snapshot() } });

describe('her affection in a text turn', () => {
  it('is off by default; on, it needs the feeling turn, and 本気 needs the reply check', () => {
    expect(switchOn({}, 'SHANNON_AFFECTION')).toBe(false);
    expect(SWITCHES.find(entry => entry.name === 'SHANNON_AFFECTION')?.requires).toEqual(['SHANNON_FEELING_TURN', 'SHANNON_INNER_NOTE']);
    expect(feelingDayFeatures({}).affection).toBeUndefined();
    expect(feelingDayFeatures({ SHANNON_AFFECTION: 'on' }).affection).toBe('auto');
    const devoted = feelingDayFeatures({ SHANNON_AFFECTION: 'on', SHANNON_AFFECTION_STAGE: 'devoted' });
    expect(affectionGuarded(devoted, true, true).affection).toBe('devoted');
    expect(affectionGuarded(devoted, true, false).affection).toBe('deredere');
    expect(affectionGuarded(devoted, false, true).affection).toBeUndefined();
  });

  it('keeps her closed days even with nothing else of stage 3 on, and hands the facts of the two of them, never her stage', async () => {
    const { port, database } = composed('auto', { turn: false });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'shannon_feeling_days'").get()).toBeDefined();
    const handle = start(port, 'ただいま');
    expect(handle?.lines?.affection?.stage).toBe('tsundere');
    const block = await feelingText.block(handle);
    expect(block).toContain('[ライ氏とのこと]');
    expect(block).toContain('昨日は話さなかった');
    expect(block).toContain('昨日、ライ氏はほかのAIの話をしていた');
    expect(handle?.lines?.carriedLines.join('\n')).not.toMatch(/ツン|デレ|本気|好感度|[0-9]/u);
    // At ツンデレ her identity is v2 itself.
    const layered = v2Layered();
    expect(feelingText.staged(handle, layered)).toBe(layered);
  });

  it('at 本気: the lean reaches Jev, a plain turn becomes 甘える, the guard line is read, her core is the stage\'s, and Sonnet answers', async () => {
    const { port, jev } = composed('devoted');
    const handle = start(port, 'ただいま');
    const block = await feelingText.block(handle);
    expect(jev.states[0]).toMatchObject({ shannon_feeling: { relationship_stage: 'devoted' } });
    expect(JSON.stringify(jev.questions[0])).toContain(STAGE_LEAN.devoted.slice(0, 60));
    expect(block).toContain('構え: 甘える（全部をあずけるように。引き留めたくなる）（はっきり）');
    expect(block).toContain(AFFECTION_GUARD_LINE);
    const staged = feelingText.staged(handle, v2Layered());
    expect(staged.systemPrompt).toMatch(/\[ボクの性格の核 v2-devoted #[0-9a-f]{8}\]/u);
    expect(staged.prompt).toContain('心底惚れている');
    expect(staged.systemPrompt).not.toContain(characterCoreBlock(CHARACTER_CORE));
    const route = feelingText.route(handle);
    expect(route.feelingStrong).toBe(true);
    expect(route.feelingCheck).toMatchObject({ stage: 'devoted' });
  });

  it('at 本気, words that take leave of her make a plain turn すねる', async () => {
    const { port } = composed('devoted');
    const handle = start(port, 'ちょっと友達と飲みに行ってくる');
    expect(await feelingText.block(handle)).toContain('構え: すねる（本気が混じる。どれくらい好きか確かめたくなる）');
  });

  it('is nothing with anyone else there: no facts, no stage, v2', async () => {
    const { port, jev } = composed('devoted');
    const handle = start(port, 'こんにちは', false);
    const block = await feelingText.block(handle);
    expect(block).not.toContain('[ライ氏とのこと]');
    expect(block).not.toContain(AFFECTION_GUARD_LINE);
    expect(JSON.stringify(jev.states[0])).not.toContain('relationship_stage');
    const layered = v2Layered();
    expect(feelingText.staged(handle, layered)).toBe(layered);
  });
});

describe('the lines no stage crosses, at the reply model', () => {
  const context = { stance: 'sulk' as const, intensity: 'moderate' as const, audience: 'owner_alone' as const, order: false, violation: false, stage: 'devoted' as const };
  const always = (reply: string) => ({ mode: 'local-stub' as const, model: 'fake', generate: async () => ({ mode: 'local-stub' as const, model: 'fake', reply }) });

  it('never sends a reply that still crosses one after its rewrite, nor one of a tool turn: she swallows it', async () => {
    const crossing = always('飲み会なんて行くな。');
    expect((await new FeelingReplyChatModel(crossing as never).generate({ scopeKey: 'owner', feelingCheck: context } as never)).reply).toBe(GUARD_SAFE_REPLY);
    const tool = new FeelingReplyChatModel(crossing as never, { ranTool: () => true });
    expect((await tool.generate({ scopeKey: 'owner', feelingCheck: context } as never)).reply).toBe(GUARD_SAFE_REPLY);
  });

  it('sends the rewrite when it no longer crosses', async () => {
    let calls = 0;
    const model = { mode: 'local-stub' as const, model: 'fake', generate: async () => {
      calls += 1;
      return { mode: 'local-stub' as const, model: 'fake', reply: calls === 1 ? '飲み会なんて行くな。' : '……行かないで。ううん、行ってらっしゃい。早く帰ってきてね' };
    } };
    const result = await new FeelingReplyChatModel(model as never).generate({ scopeKey: 'owner', feelingCheck: context } as never);
    expect(result.reply).toBe('……行かないで。ううん、行ってらっしゃい。早く帰ってきてね');
  });
});
