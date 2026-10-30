import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { doneFacts, doneStatusWords, parseDoneWhen, predicateHolds } from './minecraftPlanDone.js';
import { kindOf } from './minecraftPlanFacts.js';

/** A model may defer preparation explicitly, but a note saying "skipped" is not evidence that its observed condition was met. */
export function preparationCompletionProblem(before: PlanTree, after: PlanTree, observation: BodyObservation | null): string | null {
  const world = observation?.state.world as Record<string, unknown> | undefined;
  const inventory = world?.inventory;
  // Missing or explicitly shortened stock is unknown, never proof of an empty pack.
  const inventoryUnknown = () => (!inventory || typeof inventory !== 'object' || (Array.isArray(inventory) && inventory.some(item => typeof item === 'string' &&
     /^ほか/u.test(item))));
  if (inventoryUnknown()) return null;
  const facts = doneFacts(observation);
  if (!facts) return null;
  const prior = new Map(before.nodes.map(node => [node.id, node]));
  for (const node of after.nodes) {
    if (kindOf(node) !== 'food' && kindOf(node) !== 'prep_descent') continue;
    if (node.prep?.state === 'skipped' || node.prep?.state === 'unmet_now') continue;
    const old = prior.get(node.id);
    const completing = node.state === 'done' && old?.state !== 'done';
    const claimingMet = node.prep?.state === 'met' && old?.prep?.state !== 'met';
    if (!completing && !claimingMet) continue;
    const predicate = parseDoneWhen(node.doneWhen);
    if (!predicate || predicate.flat().some(clause => clause.kind !== 'food' && clause.kind !== 'have') || predicateHolds(predicate, facts)) continue;
    return ("" +
`${node.id}` +
" は観測で未達（" +
`${doneStatusWords(node.doneWhen,
       facts)}` +
"）。未達を state=done や prep.state=met にはできない。後回しは state=continue/blocked と reason、省いて進む選択は " +
"prep:{state:\"skipped\",why:\"理由\"} と書く。省略は達成には数えない");
  }
  return null;
}
