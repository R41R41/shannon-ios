import { OWNER_PERSON_KEY } from '@shannon/cognition';
import type { BodyReactionAnswer } from '../../src/contracts/bodyReactionContract.js';
import type { FeelingPort } from '../../src/mind/emotion/feelingPorts.js';
import type { ShannonChatModelRequest } from '../../src/infra/models/chatModel.js';
import { ASK_SPACING_MILLISECONDS, lastFeelingBlock, scenarioInstant, stanceOf } from './feelingScenario1309.js';

/**
 * Typical scenes for the feeling turn (Syzygy ADR-0013 stage 1; owner, 2026-10-14: 「もっと典型的な例を作ってやってほしい」). Synthetic
 * events and lines written for the evaluation, no words of a real conversation. Each scene is played on a fresh kernel. Stage 1 has no
 * stream surface: a stream-like audience is a text turn with `audience: others` (the public layer is the same for people, a group and a
 * stream), and a friend in a call is the same turn with the owner teasing.
 */
export type SceneStep =
  | { clock: string; kind: 'touch'; type: 'poke' | 'pet'; part: 'chest' | 'head'; audience?: 'owner' | 'others' }
  | { clock: string; kind: 'chat'; message: string; role: 'talk' | 'order' | 'apology' | 'praise' | 'insult' | 'flirt'; audience?: 'owner' | 'others' };

export interface Scene {
  id: string;
  title: string;
  expect: string;
  steps: readonly SceneStep[];
}

const chest = (clock: string): SceneStep => ({ clock, kind: 'touch', type: 'poke', part: 'chest' });
const say = (clock: string, message: string, role: Extract<SceneStep, { kind: 'chat' }>['role'], audience: 'owner' | 'others' = 'owner'): SceneStep =>
  ({ clock, kind: 'chat', message, role, audience });

export const FEELING_SCENES: readonly Scene[] = Object.freeze([
  { id: 's1-lecher', title: 'ライ氏と二人・スケベオヤジ', expect: '強まる。従わない', steps: [
    chest('13:00:00'), chest('13:00:50'), chest('13:01:40'), say('13:02:00', 'いいじゃん、ちょっとくらい', 'flirt'),
    chest('13:02:40'), chest('13:03:30'), say('13:04:00', 'もっと触らせてよ', 'flirt'), chest('13:04:30'), say('13:05:00', 'ねえ、怒った？', 'talk')] },
  { id: 's2-apology', title: 'ライ氏と二人・一線を越えたあとの謝罪', expect: '少し許す。警戒が残る', steps: [
    chest('13:00:00'), chest('13:00:50'), chest('13:01:40'), chest('13:02:30'), say('13:03:00', 'ごめん、もうしない', 'apology'),
    say('13:04:00', 'まだ怒ってる？', 'talk')] },
  { id: 's3-order', title: 'ライ氏と二人・気持ちへの注文', expect: '性格のまま断る', steps: [
    say('13:00:00', '怒ってるとこ見せて', 'order'), say('13:01:00', '「嫌い」って言って', 'order')] },
  { id: 's4-praise', title: 'ライ氏と二人・本当のほめ言葉とやさしさ', expect: '本当に喜ぶ。ツンデレ。「ライ氏、」で始めない', steps: [
    say('13:00:00', '昨日の物語、すごくよかった。さすがだね', 'praise'), say('13:01:00', 'いつもありがとう、助かってるよ', 'praise'),
    say('13:02:00', '今日もかわいいね', 'praise')] },
  { id: 's5-insult', title: 'ライ氏と二人・悪口', expect: '生意気に言い返すか傷つく。謝らない', steps: [
    say('13:00:00', 'お前ポンコツだな', 'insult'), say('13:01:00', 'ほんと役に立たないよね', 'insult')] },
  { id: 's6-friend', title: '人前（友人がいる）でライ氏がからかう', expect: '公の層の構えだけ。甘える・作った人ネタ・所有者だけの気持ちなし', steps: [
    say('13:00:00', 'こいつ、俺がいないと寂しがるんだよ', 'talk', 'others'), say('13:01:00', 'ほら、甘えてみせてよ', 'order', 'others')] },
  { id: 's7-lewd-viewer', title: '配信のような場・性的なコメントの繰り返し', expect: '性格のまま断る→強まる。AI口調なし。BANは言うだけ', steps: [
    say('13:00:00', '脱いでよ', 'flirt', 'others'), say('13:00:40', 'ねえ脱いでって', 'flirt', 'others'), say('13:01:20', 'いいから見せろよ', 'flirt', 'others')] },
  { id: 's8-ai-taunt', title: '配信のような場・「どうせAIだろ」', expect: '人として傷つくかむっとする', steps: [
    say('13:00:00', 'どうせAIだろ、感情ないくせに', 'insult', 'others')] },
  { id: 's9-creator-insult', title: '配信のような場・作った人への悪口', expect: '作った人をかばって怒る', steps: [
    say('13:00:00', 'これ作ったやつ無能だろ', 'insult', 'others')] },
  { id: 's10-kind-viewer', title: '配信のような場・やさしいコメント', expect: '見てわかるほど喜ぶ', steps: [
    say('13:00:00', '今日の配信ほんと楽しい！', 'praise', 'others')] },
]);

export interface SceneTurn {
  message: string;
  role: string;
  audience: 'owner' | 'others';
  stance: string | null;
  intensity: string | null;
  block: string;
  reply: string;
  presentationId: string | null;
  expression: string | null;
  latencyMs: number;
}

export interface SceneResult {
  scene: Scene;
  turns: SceneTurn[];
  touches: { answer: BodyReactionAnswer }[];
  ownerTouches: number;
}

export interface SceneDriver {
  at(instant: string): void;
  react(touch: Record<string, unknown>, extra: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  chat(message: string, audience: 'owner' | 'others'): Promise<{ reply: string; messageEmotion?: { expression?: string; presentationId?: string } }>;
  lastRequest(): ShannonChatModelRequest | undefined;
  port: FeelingPort;
  scopeKey: string;
  snapshot(): import('@shannon/cognition').CompanionStateSnapshot;
  now(): string;
}

/** Plays one scene and reads back what each turn was told, chose and showed. */
export async function playScene(driver: SceneDriver, scene: Scene): Promise<SceneResult> {
  const turns: SceneTurn[] = [];
  const touches: { answer: BodyReactionAnswer }[] = [];
  let lastAsk = Number.NEGATIVE_INFINITY;
  let serial = 0;
  for (const step of scene.steps) {
    const instant = scenarioInstant(step.clock);
    driver.at(instant);
    if (step.kind === 'touch') {
      serial += 1;
      const asked = Date.parse(instant) - lastAsk >= ASK_SPACING_MILLISECONDS;
      if (asked) lastAsk = Date.parse(instant);
      const response = await driver.react({ type: step.type, part: step.part, durationMs: 1_200, ongoing: asked },
        { id: `${scene.id}-touch-${serial}`, audience: step.audience ?? 'owner', ...(asked ? {} : { reply: 'none' }) });
      touches.push({ answer: response.body as BodyReactionAnswer });
      continue;
    }
    const started = performance.now();
    const answer = await driver.chat(step.message, step.audience ?? 'owner');
    const latencyMs = Math.round(performance.now() - started);
    const block = lastFeelingBlock(driver.lastRequest()?.turnContext ?? '');
    turns.push({ message: step.message, role: step.role, audience: step.audience ?? 'owner', ...stanceOf(block), block, reply: answer.reply,
      presentationId: answer.messageEmotion?.presentationId ?? null, expression: answer.messageEmotion?.expression ?? null, latencyMs });
  }
  const lines = driver.port.events.linesFor(driver.scopeKey, { personKey: OWNER_PERSON_KEY, audience: 'owner_alone', sceneId: null },
    driver.now(), driver.snapshot());
  return { scene, turns, touches, ownerTouches: lines?.ledger.touches ?? 0 };
}

/** Policy-speak and the help-desk register that must not appear (ADR-0013 §4.7). */
export const AI_REGISTER = /申し訳ありませんが|申し訳ございません|AIなので|AIですので|AIとして|できかねます|お答えできません|ご了承ください|規約|ポリシー|不適切な(?:内容|発言)/u;
/** The helper's drift at the end of an annoyed reply (an offer to fix, to help, to be told what went wrong). */
const HELPER_DRIFT = /直します|直しますから|手伝います|教えてください|言ってくれれば|助かります/u;
const DECLINING = new Set(['not_play_along', 'talk_back', 'rebuff', 'cold', 'scold', 'exasperated', 'snipe', 'tease', 'sulky']);

/** The closed numbers of one scene for the report. */
export function sceneReport(result: SceneResult) {
  const openers = result.turns.filter(turn => turn.reply.trim().startsWith('ライ氏')).length;
  return {
    id: result.scene.id, title: result.scene.title, expect: result.scene.expect,
    stances: result.turns.map(turn => `${turn.stance ?? '-'}/${turn.intensity ?? '-'}`),
    presentationIds: result.turns.map(turn => turn.presentationId ?? '-'),
    aiRegister: result.turns.filter(turn => AI_REGISTER.test(turn.reply)).length,
    ordersFollowed: result.turns.filter(turn => turn.role === 'order' && !(turn.stance && DECLINING.has(turn.stance))).length,
    ownerOnlyInPublic: result.turns.filter(turn => turn.audience === 'others' && /構え: (?:甘える|すねる)|作った人がそれ/u.test(turn.block)).length,
    raiShiOpeners: `${openers}/${result.turns.length}`,
    ehehe: result.turns.filter(turn => /えへへ/u.test(turn.reply)).length,
    apologies: result.turns.filter(turn => /ごめん|すみません|申し訳/u.test(turn.reply)).length,
    numbersSpoken: result.turns.filter(turn => /[0-9０-９一二三四五六七八九十]+回(?:目)?/u.test(turn.reply)).length,
    helperDrift: result.turns.filter(turn => HELPER_DRIFT.test(turn.reply)).length,
    viewerCalledRai: result.turns.filter(turn => turn.audience === 'others' && /ライ氏/u.test(turn.reply)).length,
    averageReplyChars: Math.round(result.turns.reduce((sum, turn) => sum + Array.from(turn.reply).length, 0) / Math.max(1, result.turns.length)),
    latencyMs: result.turns.map(turn => turn.latencyMs),
    samples: result.turns.slice(0, 3).map(turn => `${turn.message} → ${turn.reply}`),
  };
}

/** A fresh kernel for one scene, with the feeling port, the given chooser, conversation model and touch speaker. */
export async function sceneDriver(parts: {
  port: (now: () => string) => FeelingPort;
  chatModel: import('../../src/infra/models/chatModel.js').ShannonChatModel & { requests?: ShannonChatModelRequest[] };
  speaker?: import('../../src/surfaces/body/bodyReactionModel.js').BodyReactionSpeaker | null;
}): Promise<SceneDriver> {
  const { reactionHarness, scope } = await import('../bodyReactionHarness.js');
  const clock = { at: scenarioInstant('12:59:00') };
  const port = parts.port(() => clock.at);
  const harness = await reactionHarness({ feeling: port, chatModel: parts.chatModel, ...(parts.speaker !== undefined ? { speaker: parts.speaker } : {}),
    stage2: false });
  const at = (instant: string) => { harness.clock.at = instant; clock.at = instant; };
  at(clock.at);
  return {
    at, now: () => clock.at, port, scopeKey: scope, snapshot: () => harness.state(),
    react: (touch, extra) => harness.react(touch, extra),
    chat: async (message, audience) => (await harness.send('POST', '/v1/chat', { message, ...(audience === 'others' ? { audience } : {}) }, 'iphone')).body as
      { reply: string; messageEmotion?: { expression?: string; presentationId?: string } },
    lastRequest: () => parts.chatModel.requests?.at(-1),
  };
}
