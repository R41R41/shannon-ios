import { parsedSwitch, recognizedValue, type SwitchValues } from './parse.js';
import { SWITCHES, type SwitchEntry } from './table.js';

/**
 * A finding about the switches as configured. Closed codes and switch names only, never a value:
 * - `requires_off`: the switch is set on, but a switch it needs is off, so it has no effect (or the server refuses to start).
 * - `unrecognized_value`: the value is not a word its kind knows; it reads as the kind's fallback.
 * - `quoted_value`: the value still carries quotes, so the loader did not strip them.
 */
export interface SwitchWarning {
  readonly name: string;
  readonly code: 'requires_off' | 'unrecognized_value' | 'quoted_value';
  readonly needs?: readonly string[];
}

const QUOTED = /^\s*(['"]).*\1\s*$/u;
const TABLE: ReadonlyMap<string, SwitchEntry> = new Map(SWITCHES.map(item => [item.name, item]));

function entryOn(values: SwitchValues, entry: SwitchEntry): boolean {
  return parsedSwitch(entry.kind, values[entry.name]);
}

function requirementsOff(values: SwitchValues, entry: SwitchEntry): string[] {
  return entry.requires.filter(name => {
    const required = TABLE.get(name);
    return required ? !entryOn(values, required) : false;
  });
}

function warningsOf(values: SwitchValues, entry: SwitchEntry): SwitchWarning[] {
  const value = values[entry.name];
  if (value === undefined || !value.trim()) return [];
  if (QUOTED.test(value)) return [{ name: entry.name, code: 'quoted_value' }];
  const found: SwitchWarning[] = [];
  if (!recognizedValue(entry.kind, value)) found.push({ name: entry.name, code: 'unrecognized_value' });
  const needs = entryOn(values, entry) ? requirementsOff(values, entry) : [];
  if (needs.length) found.push({ name: entry.name, code: 'requires_off', needs });
  return found;
}

/**
 * Checks the configured switches against the table. It never throws: the caller logs the warnings at boot and shows them in
 * `GET /v1/ops`. Only switches set explicitly are checked, so the defaults never warn.
 */
export function validateSwitches(values: SwitchValues): SwitchWarning[] {
  return SWITCHES.flatMap(entry => warningsOf(values, entry));
}
