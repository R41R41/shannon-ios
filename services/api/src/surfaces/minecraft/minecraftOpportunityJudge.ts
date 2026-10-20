import { JEV_QUESTION_SETS, jevChoice, type JevChooser, type JevQuestion } from '../../infra/models/jev/jevChoice.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { MinecraftAgendaJudge } from './minecraftAgenda.js';
import { carriedOf } from './minecraftFillers.js';

/**
 * Jev's part of the executor (session mb-arch): whether a short detour for a thing in reach is worth taking now, where a rule alone
 * cannot say (a food animal: worth it while food is short and the day long, not on the way to a furnace at dusk). One closed choice,
 * about 0.2 s; on any failure the rule's answer stands (take it when fewer than three things to eat are carried).
 */
const QUESTION: JevQuestion = {
  type: 'choice',
  instructions: 'A Minecraft player just finished one task. A short detour is possible for the thing described in the state. Decide whether '
    + 'taking it now helps her reach her goal (an iron pickaxe, a bed, iron armour, then the Nether) more than going straight on.',
  criteria: {
    now: 'Take it now: it is close, quick, and something she lacks (food, wool for a bed, fuel, iron) that she would otherwise go back for.',
    skip: 'Go straight on: it is not lacking enough, it is getting dark, or it would pull her away from what she is doing.',
  },
};
const EDIBLE = /^(cooked_|baked_potato|bread|apple|golden_carrot|carrot)/u;

export function minecraftOpportunityJudge(jev: JevChooser | null, scopeKey: string): MinecraftAgendaJudge | undefined {
  if (!jev) return undefined;
  return {
    async takeNow(need, observation, signal) {
      const carried = carriedOf(observation);
      const food = [...carried].filter(([name]) => EDIBLE.test(name)).reduce((sum, [, count]) => sum + count, 0);
      const rule = food < 3;
      const result = await jev.decide<boolean>({ scopeKey, surface: 'text', decision: 'tool_menu', sets: [JEV_QUESTION_SETS.minecraftOpportunity],
        state: { thing: need.kind, name: need.name, foodCarried: food, darkInSeconds: darkIn(observation) }, questions: { take: QUESTION }, signal,
        parse: answers => jevChoice(answers, 'take', ['now', 'skip'] as const) === 'now', fallback: () => rule,
        traceAnswers: value => ({ selector: 'mc_opportunity', take: value }) });
      return result.value;
    },
  };
}

function darkIn(observation: BodyObservation | null): number | null {
  const world = observation ? (observation.state as { world?: { margin?: { darkInSeconds?: unknown } } }).world : undefined;
  return typeof world?.margin?.darkInSeconds === 'number' ? world.margin.darkInSeconds : null;
}
