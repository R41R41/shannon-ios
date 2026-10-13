/**
 * Syzygy ADR-0009 stage 2 (E1/E2): the capability catalog, the goal lifecycle (only evidence or the owner closes a goal),
 * its one-time migration and the owner's Executive routes are core. This definition stays in approval_and_budget.
 */
export const EXECUTIVE_CORE_PATHS = Object.freeze([
  'services/api/src/mind/inhibition/executiveCorePaths.ts',
  'services/api/src/mind/action/executive/',
  'services/api/src/mind/action/ownTime/store/pursuitGoals.ts',
  'services/api/src/mind/action/ownTime/store/pursuitGoalMigration.ts',
  'services/api/src/infra/http/executiveRoutes.ts',
  'services/api/src/wiring/executiveRouteWiring.ts',
  'docs/executive-ui-contract.md',
]);
