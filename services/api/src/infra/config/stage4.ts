import { dirname, join } from 'node:path';
import { mindSwitches } from '@shannon/mind';
import { switchOn, type SwitchValues } from '@shannon/switches';

/** Rollout is explicit, after the server/app regression and deployment review. OFF retains stage 3. */
export function stage4Enabled(values: SwitchValues): boolean {
  return switchOn(values, 'SHANNON_ADR8_STAGE4') && mindSwitches(values).workspace;
}

export function mindSocketPath(values: SwitchValues, databasePath: string): string {
  return values.SHANNON_MIND_SOCKET?.trim() || join(dirname(databasePath), 'mind-runtime', 'mind.sock');
}
