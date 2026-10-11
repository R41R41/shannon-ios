import { parsedSwitch, type SwitchValues } from './parse.js';
import { SWITCHES, type SwitchEntry, type SwitchName } from './table.js';

const BY_NAME: ReadonlyMap<string, SwitchEntry> = new Map(SWITCHES.map(entry => [entry.name, entry]));

/** The table entry of a switch. */
export function switchEntry(name: SwitchName): SwitchEntry {
  const entry = BY_NAME.get(name);
  if (!entry) throw new Error(`SWITCH_UNKNOWN:${name}`);
  return entry;
}

/** Whether a switch is on in the values handed in, read the way its table entry says. The one reader of a switch. */
export function switchOn(values: SwitchValues, name: SwitchName): boolean {
  return parsedSwitch(switchEntry(name).kind, values[name]);
}
