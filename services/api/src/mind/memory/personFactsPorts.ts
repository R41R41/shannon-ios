/**
 * The narrow window of her people facts (Syzygy ADR-0008 §10 F6, rule `mind-via-ports`): the values other parts use of
 * `personFacts.ts` (decay, identity tiers, the rule judgement). Split out of `memoryPorts.ts` in the stage 3 closure review, so
 * that reaching the memory window for skills or impressions does not load the facts module and its model helpers.
 */
export { decayDryRun, decayedUsable, identityOf, identityPeople, nameCosine, ruleJudgement, type IdentityChooser, type PersonFactJudge } from './personFacts.js';
