import { withheldOfDecision, type AutonomyConfig, type GateRefusalObserver } from '../mind/inhibition/inhibitionPorts.js';
import { WithheldActions } from '../mind/inhibition/withheldActions.js';
export { configuredWithheldActions } from './withheldStoreWiring.js';

/** What her own time's gate is handed: each decision that did not allow a step, written as withheld. */
export function gateRefusals(withheld: WithheldActions, config: Pick<AutonomyConfig, 'timeZone'>): GateRefusalObserver {
  return (scopeKey, request, decision, at) => {
    const draft = withheldOfDecision(request, decision, at, config);
    if (draft) withheld.sink(scopeKey, draft, at);
  };
}

/** Her thought's 「止められたこと」, or null while anyone else may see or hear her (what the server knows of her body). */
export function withheldFactsReader(
  withheld: WithheldActions, body: (scopeKey: string, at: string) => { others: boolean }, clock: (at: string) => string,
): (scopeKey: string, at: string) => string | null {
  return (scopeKey, at) => (body(scopeKey, at).others ? null : withheld.facts(scopeKey, at, clock));
}
