import { fcaObsMode } from '../src/mind/action/fca/fcaCoreTools.js';

/** Use the normal server's default and explicit legacy override; no separate lab interpretation. */
export function rigObservationPorts<T extends object>(ports: T, values: Readonly<Record<string, string | undefined>>) {
  return { ...ports, obsMode: fcaObsMode(values.SHANNON_FCA_OBS_MODE) };
}
