import { dirname, join } from 'node:path';
import { switchedOnExplicitly, mindSwitches } from '@shannon/mind';
export function stage4Enabled(values: Readonly<Record<string,string|undefined>>):boolean {
  // Rollout is explicit, after the server/app regression and deployment review. OFF retains stage 3.
  return switchedOnExplicitly(values.SHANNON_ADR8_STAGE4) && mindSwitches(values).workspace;
}
export function mindSocketPath(values: Readonly<Record<string,string|undefined>>,databasePath:string):string {
  return values.SHANNON_MIND_SOCKET?.trim() || join(dirname(databasePath),'mind-runtime','mind.sock');
}
