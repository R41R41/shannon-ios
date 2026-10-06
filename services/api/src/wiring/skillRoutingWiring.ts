import { skillRoutingSwitches, type SkillRoutingSwitches } from '@shannon/learning';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { countedJevFetch } from '../infra/models/jev/jevClient.js';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../infra/models/jev/jevChoice.js';
import { jevUsdPerCall } from '../infra/models/jev/jevUsage.js';
import { JevTurnChooser, type TurnChooser } from '../mind/selectors/turnChoices.js';

/**
 * Wiring of Syzygy ADR-0008 stage 2 (`docs/skill-and-routing-contract.md`): what the API kernel is handed for the turn's Jev
 * call. Each part reads its switch from the environment it is given; `SHANNON_ADR8_STAGE2=off` hands nothing, and the kernel
 * is then exactly the kernel of ca7cf519 (`stage2SwitchedOff.test.ts`).
 */
export interface SkillRoutingParts {
  /** The turn's Jev call (the tool menu, and from step 4 the difficulty); absent without Jev or with the parts switched off. */
  turnChooser?: TurnChooser;
}

export function skillRoutingParts(
  environment: Readonly<Record<string, string | undefined>>,
  options: { trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string },
): SkillRoutingParts {
  const switches = skillRoutingSwitches(environment);
  const chooser = configuredTurnChooser(environment, switches, options);
  return chooser ? { turnChooser: chooser } : {};
}

function configuredTurnChooser(
  environment: Readonly<Record<string, string | undefined>>, switches: SkillRoutingSwitches,
  options: { trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string },
): TurnChooser | null {
  if (!switches.stage2 || !switches.toolMenu) return null;
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return null;
  const timeout = Number(environment.SHANNON_JEV_TIMEOUT_MS);
  // The same endpoint, model and timeout as the voice router's Jev (`createConfiguredVoiceDecisionGateway`), counted like it.
  const client = new JevChoiceClient({
    apiKey,
    ...(environment.SHANNON_JEV_ENDPOINT?.trim() ? { endpoint: environment.SHANNON_JEV_ENDPOINT.trim() } : {}),
    model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
    ...(Number.isInteger(timeout) && timeout > 0 ? { timeoutMilliseconds: timeout } : {}),
    fetcher: options.trace ? countedJevFetch(options.jevFetch) : options.jevFetch ?? fetch,
  });
  const write = options.trace;
  const jev = new JevChooser(client, {
    usdPerCall: jevUsdPerCall(environment),
    ...(options.now ? { now: options.now } : {}),
    ...(write ? { trace: (scopeKey: string, trace: JevChoiceTrace) => write(scopeKey, {
      surface: trace.surface, decision: trace.decision, decider: 'jev', model: trace.model, questions: trace.questions, contextChars: trace.contextChars,
      latencyMs: trace.latencyMs, outcome: trace.outcome, fallbackDecider: trace.outcome === 'ok' ? null : 'local', answers: trace.answers,
      costUsd: trace.costUsd, relatedId: null, at: trace.at,
    }) } : {}),
  });
  return new JevTurnChooser(jev, { toolMenu: switches.toolMenu });
}
