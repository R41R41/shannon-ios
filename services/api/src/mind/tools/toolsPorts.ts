/**
 * The window of the tools part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`): what another part of the mind may import of
 * it. The turn's routing (`mind/action/respond/turnRouting.ts`) reads what her tools did in a turn here, as closed values.
 */
export { turnOffersWrites, turnToolResults } from './shannonToolSession.js';
export { toolDoing } from './shannonTools.js';
