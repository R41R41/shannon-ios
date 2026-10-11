import { validateSwitches, type SwitchValues, type SwitchWarning } from '@shannon/switches';

/** One line per finding: closed codes and switch names only, never a value. */
export function switchWarningLine(warning: SwitchWarning): string {
  const needs = warning.needs?.length ? ` needs=${warning.needs.join(',')}` : '';
  return `Shannon switches: ${warning.code} ${warning.name}${needs}`;
}

/**
 * Checks the switches at boot against the table (`@shannon/switches`) and logs each finding. It never throws: the hard boot
 * failures that guard an unsafe combination (FCA without action threads, FCA Minecraft without its runtime) stay where they are.
 */
export function reportSwitches(values: SwitchValues, log: (line: string) => void): readonly SwitchWarning[] {
  const warnings = validateSwitches(values);
  for (const warning of warnings) log(switchWarningLine(warning));
  return Object.freeze(warnings);
}

/** Adds `switches` to the owner's `server` object of `GET /v1/ops`; anything else passes through unchanged. */
export function withSwitches(server: object | null, warnings: readonly SwitchWarning[]): object | null {
  return server ? { ...server, switches: { warnings } } : server;
}
