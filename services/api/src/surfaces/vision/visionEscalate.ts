/**
 * An escalation of the camera's notice (Syzygy ADR-0011 §4.3 `escalate`): the frame the worker held is shown once to the model
 * that sees a look, with nothing of the Talk (no context, so nothing private can ride along), and what she says is her note in the
 * Talk, said only while the owner alone can see or hear her, before and after the model is asked. The frame is a base64 string in
 * this call's memory and nothing else; it is never written, logged or kept.
 */
export interface VisionEscalationViewer {
  see(request: {
    scopeKey: string; image: { mediaType: 'image/jpeg'; base64: string; width: number; height: number };
    context: readonly { role: 'user' | 'assistant'; content: string }[]; app?: { camera: 'back' | 'front' };
  }): Promise<string>;
}

export interface VisionEscalationDependencies {
  viewer: VisionEscalationViewer | null;
  alone(scopeKey: string): boolean;
  say(scopeKey: string, decisionId: string, text: string, at: string): { threadId: string } | null;
  /** The used frame on the common vision contract (`visionLook`). */
  looked(scopeKey: string, look: { deviceId: string; outcome: 'seen' | 'not_seen' | 'withheld'; width: number; height: number; byteLength: number }): void;
  now(): number;
}

export const VISION_ESCALATION_LIMITS = Object.freeze({ freshMs: 10_000, base64Characters: 280_000, messageCharacters: 240 });

export class VisionEscalation {
  constructor(private readonly dependencies: VisionEscalationDependencies) {}

  async look(input: { scopeKey: string; decisionId: string; deviceId: string; mimeType: string; base64: string; width: number; height: number; at: string }):
    Promise<{ seen: boolean }> {
    const viewer = this.dependencies.viewer;
    const usable = viewer && input.mimeType === 'image/jpeg' && input.base64.length <= VISION_ESCALATION_LIMITS.base64Characters
      && this.dependencies.now() - Date.parse(input.at) <= VISION_ESCALATION_LIMITS.freshMs;
    if (!usable || !this.dependencies.alone(input.scopeKey)) return { seen: false };
    const size = { width: input.width, height: input.height, byteLength: Math.floor(input.base64.length * 3 / 4) };
    let text = '';
    try {
      text = (await viewer.see({ scopeKey: input.scopeKey, image: { mediaType: 'image/jpeg', base64: input.base64, width: input.width, height: input.height },
        context: [], app: { camera: 'front' } })).replace(/\s+/gu, ' ').trim().slice(0, VISION_ESCALATION_LIMITS.messageCharacters);
    } catch {
      text = '';
    }
    const alone = this.dependencies.alone(input.scopeKey);
    this.dependencies.looked(input.scopeKey, { deviceId: input.deviceId, outcome: !text ? 'not_seen' : alone ? 'seen' : 'withheld', ...size });
    if (!text || !alone) return { seen: false };
    const said = this.dependencies.say(input.scopeKey, input.decisionId, text, new Date(this.dependencies.now()).toISOString());
    return { seen: said !== null };
  }
}
