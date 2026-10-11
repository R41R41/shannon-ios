/**
 * `@shannon/switches`: the one table of the server's switches and their one reader (Syzygy ADR-0009 stage 1, D9). Pure: the
 * services hand in their environment; this package reads none, opens nothing and starts no timer.
 */
export { SWITCHES, type SwitchEntry, type SwitchKind, type SwitchName } from './table.js';
export {
  namedOn, namedTrue, parsedSwitch, recognizedValue, switchedOn, switchedOnExplicitly, type SwitchValues,
} from './parse.js';
export { switchEntry, switchOn } from './read.js';
export { validateSwitches, type SwitchWarning } from './validate.js';
