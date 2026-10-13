import { dirname, join } from 'node:path';
import { switchOn, type SwitchValues } from '@shannon/switches';

/**
 * The vision worker's settings (Syzygy ADR-0011 stage 1). Every switch is off by default; the camera source needs the worker,
 * escalation needs the camera. The worker listens on loopback only, behind nginx's `/companion/v1/vision/` location.
 */
export const VISION_DEFAULT_PORT = 4320;

export function visionWorkerEnabled(values: SwitchValues): boolean {
  return switchOn(values, 'SHANNON_VISION_WORKER');
}

export function visionSwitches(values: SwitchValues): { worker: boolean; camera: boolean; escalate: boolean; halted: boolean } {
  const worker = visionWorkerEnabled(values);
  const camera = worker && switchOn(values, 'SHANNON_VISION_CAMERA');
  return { worker, camera, escalate: camera && switchOn(values, 'SHANNON_VISION_ESCALATE'), halted: worker && switchOn(values, 'SHANNON_VISION_HALT') };
}

/** The API's vision bridge socket (owner-only, beside the mind's socket). */
export function visionBridgeSocketPath(values: SwitchValues, databasePath: string): string {
  return values.SHANNON_VISION_BRIDGE_SOCKET?.trim() || join(dirname(databasePath), 'mind-runtime', 'vision-bridge.sock');
}

export function visionWorkerPort(values: SwitchValues): number {
  const port = Number(values.SHANNON_VISION_PORT?.trim() || VISION_DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('SHANNON_VISION_PORT is invalid');
  return port;
}
