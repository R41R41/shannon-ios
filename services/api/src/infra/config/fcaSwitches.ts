import { switchOn, type SwitchValues } from '@shannon/switches';

/**
 * The worker hands the owner's nightly sleep to the FCA runtime whenever the runtime is on (Syzygy ADR-0009 S9 retired
 * `SHANNON_FCA_SLEEP`: sleep always takes the new path). Other scopes and nights the old batch already tried stay on it.
 */
export function fcaSleepConfigured(values: SwitchValues): boolean {
  return switchOn(values, 'SHANNON_FCA_RUNTIME');
}
