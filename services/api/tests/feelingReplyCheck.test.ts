import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { OWNER_PERSON_KEY } from '@shannon/cognition';
import { switchOn } from '@shannon/switches';
import { reactionHarness, scope } from './bodyReactionHarness.js';
import { fakeFeelingJev } from './support/feelingHarness.js';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { FeelingReplyChatModel } from '../src/infra/models/feelingStrongChatModel.js';

/** The reply check (Syzygy ADR-0013 stage 2, `SHANNON_REPLY_CHECK`): before sending on strong, order and public text turns, one rewrite. */
const DAY = '2026-10-14T04:00:00.000Z';

async function checked(stance: { stance: string; intensity: string }, drafts: string[], check = true) {
  const clock = { at: DAY };
  const jev = fakeFeelingJev(() => ({ ...stance, drawer: 'none' }));
  const requests: ShannonChatModelRequest[] = [];
  const model = { mode: 'local-stub' as const, model: 'fake', generate: async (request: ShannonChatModelRequest) => {
    requests.push(request);
    return { mode: 'local-stub' as const, model: 'fake', reply: drafts[Math.min(requests.length - 1, drafts.length - 1)]! };
  } };
  const configured = composedFeeling({ database: new DatabaseSync(':memory:'), now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: jev.chooser, turn: true,
    singleFace: false, check });
  const harness = await reactionHarness({ feeling: configured.port, chatModel: configured.wrap(model as never), stage2: false });
  harness.clock.at = DAY;
  const reply = (await harness.send('POST', '/v1/chat', { message: 'お前ポンコツだな' }, 'iphone')).body as { reply: string };
  const events = configured.port.events.today(scope, DAY, harness.state()).filter(event => event.kind === 'own_reply' && event.personKey === OWNER_PERSON_KEY);
  return { reply, requests, events };
}

describe('the reply check before sending (SHANNON_REPLY_CHECK)', () => {
  it('is off by default', () => expect(switchOn({}, 'SHANNON_REPLY_CHECK')).toBe(false));

  it('rewrites a strong turn\'s draft once when something is off, with the note last, and records what was found', async () => {
    const { reply, requests, events } = await checked({ stance: 'snipe', intensity: 'strong' },
      ['ひどいです！どこがダメだったか言ってくれれば、ちゃんと直しますから。', 'ポンコツとは失礼ですね。それ、ほぼ自分への悪口ですよ。']);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.turnContext!.endsWith('[書き直し]（さっきの下書きは、手伝いや直す申し出で締めていた。この番の気持ちのまま、ボクの言葉で一から書き直す）')).toBe(true);
    expect('feelingCheck' in requests[0]!).toBe(false);
    expect(reply.reply).toBe('ポンコツとは失礼ですね。それ、ほぼ自分への悪口ですよ。');
    expect(events.at(-1)!.facts).toMatchObject({ checkFlags: ['helper_drift'], rewritten: true });
  });

  it('rewrites at most once, and leaves a clean draft as it is', async () => {
    const twice = await checked({ stance: 'snipe', intensity: 'strong' }, ['直しますから。', '直しますから。']);
    expect(twice.requests).toHaveLength(2);
    const clean = await checked({ stance: 'snipe', intensity: 'strong' }, ['ポンコツとは失礼ですね。']);
    expect(clean.requests).toHaveLength(1);
    expect(clean.events.at(-1)!.facts.checkFlags).toBeUndefined();
  });

  it('checks an ordinary turn only after sending, and tells the next feeling turn', async () => {
    const after = await checked({ stance: 'sulky', intensity: 'moderate' }, ['むっとしてます。…でも、何か手伝うことがあれば遠慮なく相談してください。']);
    expect(after.requests).toHaveLength(1);
    expect(after.events.at(-1)!.facts.checkFlags).toEqual(['helper_drift']);
  });

  it('does nothing while switched off', async () => {
    const off = await checked({ stance: 'snipe', intensity: 'strong' }, ['直しますから。'], false);
    expect(off.requests).toHaveLength(1);
    expect(off.events.at(-1)!.facts.checkFlags).toBeUndefined();
  });
});

describe('the rewrite\'s bounds (review M5)', () => {
  const context = { stance: 'snipe' as const, intensity: 'strong' as const, audience: 'owner_alone' as const, order: false, violation: false, turn: 't1' };
  const drafts = (delay: number) => {
    const requests: ShannonChatModelRequest[] = [];
    const model = { mode: 'local-stub' as const, model: 'fake', generate: async (request: ShannonChatModelRequest) => {
      requests.push(request);
      if (requests.length > 1 && delay) await new Promise(resolve => setTimeout(resolve, delay));
      return { mode: 'local-stub' as const, model: 'fake', reply: requests.length > 1 ? 'ポンコツとは失礼ですね。' : 'どこがダメか言ってくれれば直しますから。' };
    } };
    return { model, requests };
  };

  it('sends the first draft when the rewrite is late, and says it was not rewritten', async () => {
    const { model, requests } = drafts(500);
    const seen: unknown[][] = [];
    const wrapped = new FeelingReplyChatModel(model as never, { checked: (...args) => { seen.push(args); }, rewriteDeadlineMilliseconds: 50 });
    const result = await wrapped.generate({ scopeKey: 'owner', feelingCheck: context } as never);
    expect(result.reply).toBe('どこがダメか言ってくれれば直しますから。');
    expect(requests).toHaveLength(2);
    expect(seen).toEqual([['owner', ['helper_drift'], false, 't1']]);
  });

  it('offers the rewrite no tools, and never rewrites a turn that ran a tool', async () => {
    const fast = drafts(0);
    await new FeelingReplyChatModel(fast.model as never).generate({ scopeKey: 'owner', feelingCheck: context, tools: { definitions: [] } } as never);
    expect('tools' in fast.requests[1]!).toBe(false);
    const ran = drafts(0);
    const result = await new FeelingReplyChatModel(ran.model as never, { ranTool: () => true })
      .generate({ scopeKey: 'owner', feelingCheck: context } as never);
    expect(ran.requests).toHaveLength(1);
    expect(result.reply).toBe('どこがダメか言ってくれれば直しますから。');
  });
});
