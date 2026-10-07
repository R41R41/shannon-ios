import type { MindEvent } from '@shannon/mind';

/**
 * What a surface is handed of the mind (Syzygy ADR-0008 stage 3, step F2): one synchronous call that takes an event its
 * normalizer built and answers what became of it. It never throws and never waits; when the mind is switched off or faulted it
 * answers null and the surface goes on exactly as before. A surface never reads the mind's state through it.
 */
export type PerceivedVerdict = 'admitted' | 'below_entry' | 'evicted' | 'duplicate' | 'ignored';

export interface PerceivedItem {
  itemId: string;
  salience: number;
  verdict: PerceivedVerdict;
}

/** The closed codes of an event that the envelope has no field for (what a notice is about). Never text. */
export interface PerceivedDetail {
  code?: string | null;
  tool?: string | null;
  reason?: string | null;
}

export interface MindPerceiver {
  perceive(scopeKey: string, event: MindEvent | null, detail?: PerceivedDetail | null): PerceivedItem | null;
}
