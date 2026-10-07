import { serverEnvironment, type ServerEnvironment } from './serverEnvironment.js';

/** ADR-0008 Stage 5 is additive and off unless the owner enables this exact switch. */
export function stage5Enabled(environment: ServerEnvironment = serverEnvironment()): boolean {
  return environment.SHANNON_ADR8_STAGE5?.trim().toLowerCase() === 'on';
}
