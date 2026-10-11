import type { SwitchKind } from './table.js';

/** The values a service hands in; this package reads no environment itself. */
export type SwitchValues = Readonly<Record<string, string | undefined>>;

const OFF_WORDS = new Set(['off', 'false', '0', 'disabled', 'no', 'none']);
const ON_WORDS = new Set(['on', 'true', '1', 'yes']);

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/** On unless the value names off (`default_on`). */
export function switchedOn(value: string | undefined): boolean {
  return !OFF_WORDS.has(normalized(value));
}

/** Off unless the value names on (`explicit_on`). */
export function switchedOnExplicitly(value: string | undefined): boolean {
  return ON_WORDS.has(normalized(value));
}

/** Off unless the value is the word `on` (`on_only`). */
export function namedOn(value: string | undefined): boolean {
  return normalized(value) === 'on';
}

/** Off unless the value is exactly `true` (`true_only`). */
export function namedTrue(value: string | undefined): boolean {
  return value?.trim() === 'true';
}

/** How a switch of the given kind reads a value. */
export function parsedSwitch(kind: SwitchKind, value: string | undefined): boolean {
  if (kind === 'default_on') return switchedOn(value);
  if (kind === 'explicit_on') return switchedOnExplicitly(value);
  if (kind === 'on_only') return namedOn(value);
  return namedTrue(value);
}

/** Whether a value is one of the words its kind knows (an unset or empty value always is). */
export function recognizedValue(kind: SwitchKind, value: string | undefined): boolean {
  const word = normalized(value);
  if (!word) return true;
  if (kind === 'true_only') return value?.trim() === 'true' || value?.trim() === 'false';
  if (kind === 'on_only') return word === 'on' || OFF_WORDS.has(word);
  return ON_WORDS.has(word) || OFF_WORDS.has(word);
}
