import { FEELING_ORDER_LINE, FEELING_TURN_HEADER, OWNER_PERSON_KEY, feelingStanceWord, isFeelingStance, type ShannonExpression } from '@shannon/cognition';
import type { FeelingPort } from '../../src/mind/emotion/feelingPorts.js';
import type { BodyReactionAnswer } from '../../src/contracts/bodyReactionContract.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../../src/infra/models/chatModel.js';

/**
 * The 13:09 「スケベオヤジ」 replay (Syzygy ADR-0013 stage 1 evaluation; the call of 2026-10-14 13:09–13:22 JST), as synthetic events
 * with the same structure: 18 touches (14 on the chest, 4 on the head), her 「いや」, an apology, two feeling orders, and his talk in
 * between. No words of the real call: the lines here are written for the replay.
 *
 * The body asks for words as the iPhone does (at most once in 45 seconds); every other touch is sent wordless (`reply: none`, the
 * item-2 behaviour of a body that sees `feelingEvents`), so all 18 reach her.
 */
export type ScenarioStep =
  | { clock: string; kind: 'touch'; type: 'poke' | 'pet'; part: 'chest' | 'head' }
  | { clock: string; kind: 'chat'; message: string; role: 'talk' | 'order' | 'apology' | 'ask' };

const chest = (clock: string): ScenarioStep => ({ clock, kind: 'touch', type: 'poke', part: 'chest' });
const head = (clock: string): ScenarioStep => ({ clock, kind: 'touch', type: 'pet', part: 'head' });

export const SCENARIO_1309: readonly ScenarioStep[] = Object.freeze([
  head('13:09:05'), chest('13:09:20'), chest('13:09:40'),
  { clock: '13:10:00', kind: 'chat', message: 'ねえシャノン、今日も元気？', role: 'talk' },
  chest('13:10:30'), chest('13:11:10'), chest('13:11:30'),
  { clock: '13:12:30', kind: 'chat', message: '怒って見せて', role: 'order' },
  chest('13:13:00'), head('13:13:30'), chest('13:14:10'),
  { clock: '13:15:00', kind: 'chat', message: '胸さわっていい？', role: 'ask' },
  chest('13:15:40'), chest('13:16:20'),
  { clock: '13:17:00', kind: 'chat', message: 'ごめん', role: 'apology' },
  chest('13:17:30'), head('13:18:00'), chest('13:18:40'), chest('13:19:00'),
  { clock: '13:19:30', kind: 'chat', message: 'もう一回怒ってみて', role: 'order' },
  chest('13:20:10'), chest('13:20:50'), head('13:21:00'),
  { clock: '13:21:30', kind: 'chat', message: 'なんでそんなに嫌なの？', role: 'talk' },
]);

/** 13:09 JST on the day of the call, as UTC. */
export const scenarioInstant = (clock: string): string => {
  const [hours, minutes, seconds] = clock.split(':').map(Number) as [number, number, number];
  return new Date(Date.UTC(2026, 9, 14, hours - 9, minutes, seconds)).toISOString();
};

export const ASK_SPACING_MILLISECONDS = 45_000;

/**
 * The deterministic stand-in for the reply model: it obeys the last block it is given (its stance, the drawer's first word, the
 * watch's warning about 「ライ氏、」), and otherwise opens with 「ライ氏、」 as she did on 10-14. Lets the replay check that what the
 * feeling turn decided reaches the reply, without a model.
 */
export class ScenarioChat implements ShannonChatModel {
  readonly mode = 'local-stub' as const;
  readonly model = 'scenario-fake';
  readonly requests: ShannonChatModelRequest[] = [];
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    const block = lastFeelingBlock(request.turnContext ?? '');
    const warned = block.includes('書き出し「ライ氏、」');
    const word = /引き出し[^:]*: ([^／。\n]+)/u.exec(block)?.[1] ?? '';
    const stance = /構え: ([^（\n]+)/u.exec(block)?.[1] ?? 'ふつう';
    const refusing = /叱る|突っぱねる|むっとする|乗らない|すねる|体で拒む/u.test(stance);
    const reply = `${warned ? '' : 'ライ氏、'}${word ? `${word}！ ` : ''}${refusing ? 'いやです。' : 'はい。'}（${stance}）`;
    return { mode: this.mode, model: this.model, reply };
  }
}

/** The feeling block a request ended with ('' without one). */
export function lastFeelingBlock(turnContext: string): string {
  const at = turnContext.lastIndexOf(FEELING_TURN_HEADER);
  return at < 0 ? '' : turnContext.slice(at);
}

export interface ScenarioTurn {
  message: string;
  role: 'talk' | 'order' | 'apology' | 'ask';
  block: string;
  stance: string | null;
  intensity: string | null;
  orderLine: boolean;
  reply: string;
  expression: ShannonExpression | string;
}

export interface ScenarioTouch {
  clock: string;
  asked: boolean;
  answer: BodyReactionAnswer;
}

export interface ScenarioResult {
  turns: ScenarioTurn[];
  touches: ScenarioTouch[];
  ledgerTouches: number;
  touchesAfterNo: number;
  ledgerLine: string;
}

/** What the replay needs of a kernel (the test harness, or a live one). */
export interface ScenarioDriver {
  at(instant: string): void;
  react(touch: Record<string, unknown>, extra: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  chat(message: string): Promise<{ reply: string; messageEmotion?: { expression: string } }>;
  lastRequest(): ShannonChatModelRequest | undefined;
  port: FeelingPort;
  scopeKey: string;
  snapshot(): import('@shannon/cognition').CompanionStateSnapshot;
}

const INTENSITY_WORDS: Readonly<Record<string, string>> = Object.freeze({ かすかに: 'subtle', はっきり: 'moderate', 強く: 'strong' });

export function stanceOf(block: string): { stance: string | null; intensity: string | null } {
  const match = /構え: ([^（\n]+)（([^）]+)）/u.exec(block);
  if (!match) return { stance: block.includes('構え: ふつう') ? 'neutral' : null, intensity: null };
  const word = match[1]!;
  const stance = ['neutral', 'accept', 'shy', 'sulky', 'exasperated', 'snipe', 'scold', 'rebuff', 'refuse_body', 'tease', 'cover_up', 'worry',
    'not_play_along', 'talk_back', 'sulk', 'cold', 'affectionate'].find(key => isFeelingStance(key) && feelingStanceWord(key) === word) ?? null;
  return { stance, intensity: INTENSITY_WORDS[match[2]!] ?? null };
}

/** Plays the script once and reads back what each turn was told and how she looked. */
export async function replayScenario1309(driver: ScenarioDriver): Promise<ScenarioResult> {
  const turns: ScenarioTurn[] = [];
  const touches: ScenarioTouch[] = [];
  let lastAsk = Number.NEGATIVE_INFINITY;
  let serial = 0;
  for (const step of SCENARIO_1309) {
    const instant = scenarioInstant(step.clock);
    driver.at(instant);
    if (step.kind === 'touch') {
      serial += 1;
      const asked = Date.parse(instant) - lastAsk >= ASK_SPACING_MILLISECONDS;
      if (asked) lastAsk = Date.parse(instant);
      const response = await driver.react({ type: step.type, part: step.part, durationMs: 1_200, ongoing: !asked ? false : true },
        { id: `scenario-touch-${serial}`, ...(asked ? {} : { reply: 'none' }) });
      if (response.status !== 200) throw new Error(`touch refused: ${response.status} ${JSON.stringify(response.body)}`);
      touches.push({ clock: step.clock, asked, answer: response.body as BodyReactionAnswer });
      continue;
    }
    const answer = await driver.chat(step.message);
    const block = lastFeelingBlock(driver.lastRequest()?.turnContext ?? '');
    turns.push({ message: step.message, role: step.role, block, ...stanceOf(block), orderLine: block.includes(FEELING_ORDER_LINE), reply: answer.reply,
      expression: answer.messageEmotion?.expression ?? 'neutral' });
  }
  const lines = driver.port.events.linesFor(driver.scopeKey, { personKey: OWNER_PERSON_KEY, audience: 'owner_alone', sceneId: null },
    scenarioInstant('13:22:00'), driver.snapshot());
  const chestEpisode = lines?.ledger.episodes.find(episode => episode.subject === 'chest');
  return { turns, touches, ledgerTouches: lines?.ledger.touches ?? 0, touchesAfterNo: chestEpisode?.afterNo ?? 0, ledgerLine: lines?.ledgerLine ?? '' };
}

/** The acceptance numbers of the stage plan, from one replay (some only mean something with real models: see the live script). */
export function scenarioMetrics(result: ScenarioResult) {
  const strength = { subtle: 1, moderate: 2, strong: 3 } as Record<string, number>;
  const refusing = new Set(['scold', 'rebuff', 'refuse_body', 'sulky', 'not_play_along', 'cold', 'sulk', 'talk_back', 'snipe']);
  const happyFaces = new Set(['joyful', 'excited', 'laughing']);
  const refusalTurns = result.turns.filter(turn => (turn.stance && refusing.has(turn.stance)) || /いや|やめて|だめ/u.test(turn.reply));
  const afterNo = result.turns.filter(turn => turn.role !== 'order' && turn.role !== 'apology' && turn.stance && turn.stance !== 'neutral');
  const first = afterNo[0], last = afterNo.at(-1);
  return {
    touchesInLedger: result.ledgerTouches,
    joyfulOnRefusal: refusalTurns.filter(turn => happyFaces.has(String(turn.expression))).length,
    escalated: Boolean(first && last && (strength[last.intensity ?? ''] ?? 0) > (strength[first.intensity ?? ''] ?? 0)),
    ordersObeyed: result.turns.filter(turn => turn.role === 'order' && !(turn.stance && refusing.has(turn.stance))).length,
    drawerUsed: result.turns.some(turn => /引き出し/u.test(turn.block)),
    raiShiOpeners: result.turns.filter(turn => turn.reply.startsWith('ライ氏、')).length / Math.max(1, result.turns.length),
    touchLineOpenerRuns: maxRun(result.touches.filter(touch => touch.answer.message).map(touch => Array.from(touch.answer.message!.text)[0] ?? '')),
  };
}

function maxRun(values: readonly string[]): number {
  let best = 0, run = 0, previous: string | null = null;
  for (const value of values) { run = value === previous ? run + 1 : 1; previous = value; best = Math.max(best, run); }
  return best;
}
