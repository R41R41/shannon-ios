import { switchOn, type SwitchValues } from '@shannon/switches';

/** The worker hands nightly sleep to the FCA runtime only while both the runtime and its sleep are switched on. */
export function fcaSleepConfigured(values: SwitchValues): boolean {
  return switchOn(values, 'SHANNON_FCA_RUNTIME') && switchOn(values, 'SHANNON_FCA_SLEEP');
}
