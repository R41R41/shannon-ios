import type { ShannonEmotion } from '@shannon/cognition';
export interface FcaTouchInput {
  scopeKey: string; deviceId: string; touchId: string; experienceId: string; observedAt: string;
  audience: 'owner' | 'others'; touch: { type: string; part?: string; region?: string; side?: string; gesture?: string; reflex?: string };
  emotion: Readonly<ShannonEmotion>; stateVersion: number; stances: readonly string[];
  stanceSourceIds: readonly string[];
  gestures: readonly string[];
}
export interface FcaTouchDirective {
  operationId: string; touchId: string; gesture: string; expiresAt: string;
}
export type FcaTouchResult = 'applied' | 'not_applied' | 'unknown';
export interface FcaTouchPort {
  observe(input: FcaTouchInput): void;
  /** Existing reaction remains the emotion/speech authority. No words are copied. */
  reacted(scope: string, device: string, touchId: string, result: { stance: string | null; said: boolean }): void;
  claim(scope: string, device: string, touchId: string): Promise<FcaTouchDirective | null>;
  report(scope: string, device: string, operationId: string, result: FcaTouchResult): Promise<boolean>;
}
export interface FcaTouchSelector {
  select(input: FcaTouchInput, signal: AbortSignal): Promise<string | null>;
}
export { JevTouchSelector } from './jevTouchSelector.js';
