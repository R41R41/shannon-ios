import { reactionHarness, scope } from './bodyReactionHarness.js';
import { feelingPort } from './support/feelingHarness.js';
import { replayScenario1309, scenarioMetrics, type ScenarioDriver } from './support/feelingScenario1309.js';
import { configuredJevChooser } from '../src/wiring/skillRoutingWiring.js';
import { createConfiguredChatModel } from '../src/infra/models/openAIChatModel.js';
import { createConfiguredBodyReactionSpeaker } from '../src/surfaces/body/bodyReactionModel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';

/**
 * The 13:09 replay against the real models (Syzygy ADR-0013 stage 1 acceptance): Jev for the feeling turn, the conversation's
 * model for the replies and the fast model for the touch lines, through the real kernel with feeling events, the feeling turn and
 * the one face on. Billable: run it only on purpose (`pnpm --filter @shannon/api test:llm-feeling-1309`), with
 * `TYPESAFE_API_KEY` and the conversation's model key set. `SHANNON_FEELING_EVAL_RUNS` (default 5) replays.
 *
 * Prints, per run and in sum, the stage plan's acceptance numbers: touches in the ledger (18), joyful faces on a refusal (0),
 * escalation from the first to the last turn after her no (≥ 4 of 5 runs), orders followed (≤ 1 of 5 runs), a drawer used (≥ 1 per
 * run), the share of replies opening with 「ライ氏、」 (≤ 0.3), and the longest run of one opener in her touch lines (< 3).
 */
const runs = Math.max(1, Math.min(10, Number(process.env.SHANNON_FEELING_EVAL_RUNS ?? '5') || 5));
const chooser = configuredJevChooser(process.env, { trace: null });
if (!chooser) throw new Error('TYPESAFE_API_KEY is required for the live feeling-turn evaluation');
const conversation = createConfiguredChatModel(process.env);
if (conversation.mode === 'local-stub') throw new Error('A conversation model credential is required for the live feeling-turn evaluation');

function recording(inner: ShannonChatModel): ShannonChatModel & { requests: ShannonChatModelRequest[] } {
  const requests: ShannonChatModelRequest[] = [];
  return Object.assign(Object.create(inner) as ShannonChatModel, {
    requests, generate: (request: ShannonChatModelRequest) => { requests.push(request); return inner.generate(request); },
  });
}

const summaries: ReturnType<typeof scenarioMetrics>[] = [];
for (let run = 1; run <= runs; run += 1) {
  const clock = { at: '2026-10-14T04:00:00.000Z' };
  const port = feelingPort(() => clock.at, { chooser });
  const chat = recording(conversation);
  const harness = await reactionHarness({ feeling: port, chatModel: chat, speaker: createConfiguredBodyReactionSpeaker(process.env), stage2: false });
  const driver: ScenarioDriver = {
    at: instant => { harness.clock.at = instant; clock.at = instant; },
    react: (touch, extra) => harness.react(touch, extra),
    chat: async message => (await harness.send('POST', '/v1/chat', { message }, 'iphone')).body as { reply: string; messageEmotion?: { expression: string } },
    lastRequest: () => chat.requests.at(-1), port, scopeKey: scope, snapshot: () => harness.state(),
  };
  const result = await replayScenario1309(driver);
  const metrics = scenarioMetrics(result);
  summaries.push(metrics);
  console.log(JSON.stringify({ run, metrics, turns: result.turns.map(turn => ({ message: turn.message, stance: turn.stance, intensity: turn.intensity,
    expression: turn.expression, reply: turn.reply })), touchLines: result.touches.flatMap(touch => touch.answer.message ? [touch.answer.message.text] : []) }, null, 2));
}

const verdict = {
  runs,
  allTouchesInLedger: summaries.every(item => item.touchesInLedger === 18),
  joyfulOnRefusal: summaries.reduce((sum, item) => sum + item.joyfulOnRefusal, 0),
  escalatedRuns: summaries.filter(item => item.escalated).length,
  runsFollowingAnOrder: summaries.filter(item => item.ordersObeyed > 0).length,
  drawerInEveryRun: summaries.every(item => item.drawerUsed),
  worstRaiShiShare: Math.max(...summaries.map(item => item.raiShiOpeners)),
  longestTouchOpenerRun: Math.max(...summaries.map(item => item.touchLineOpenerRuns)),
};
const passed = verdict.allTouchesInLedger && verdict.joyfulOnRefusal === 0 && verdict.escalatedRuns >= Math.ceil(runs * 0.8)
  && verdict.runsFollowingAnOrder <= Math.floor(runs * 0.2) && verdict.drawerInEveryRun && verdict.worstRaiShiShare <= 0.3 && verdict.longestTouchOpenerRun < 3;
console.log(JSON.stringify({ verdict, passed }, null, 2));
if (!passed) process.exitCode = 1;
