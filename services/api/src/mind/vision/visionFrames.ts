import type { VisionFrameV1 } from '../../contracts/visionContract.js';

/**
 * The frames of the vision worker, in memory only (Syzygy ADR-0011 §4.4 and §5): a frame is kept for its decision and for at most
 * its TTL, then dropped. Nothing here writes anywhere; the bytes are overwritten with zeros when a frame leaves, so a later heap
 * snapshot or crash dump of a long-lived process holds as little of a picture as the runtime allows.
 */
export interface HeldFrame { meta: VisionFrameV1; bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png'; expiresAt: number }

export class VisionFrameHolder {
  private readonly frames = new Map<string, HeldFrame>();

  constructor(private readonly now: () => number = Date.now, private readonly capacity = 8) {}

  get size(): number {
    return this.frames.size;
  }

  /** Keeps a frame until its TTL from capture; the oldest leaves when the holder is full. */
  hold(meta: VisionFrameV1, bytes: Uint8Array, mimeType: HeldFrame['mimeType']): string {
    this.sweep();
    while (this.frames.size >= this.capacity) this.drop(this.frames.keys().next().value as string);
    this.frames.set(meta.frameId, { meta, bytes, mimeType, expiresAt: Date.parse(meta.capturedAt) + meta.ttlMs });
    return `frame:${meta.frameId}`;
  }

  /** The frame while it is within its TTL, else null (and it is dropped). */
  get(frameId: string): HeldFrame | null {
    const frame = this.frames.get(frameId);
    if (!frame) return null;
    if (frame.expiresAt <= this.now()) {
      this.drop(frameId);
      return null;
    }
    return frame;
  }

  /** Drops a frame after its decision (and after an escalation took its copy). */
  drop(frameId: string): void {
    const frame = this.frames.get(frameId);
    if (!frame) return;
    frame.bytes.fill(0);
    this.frames.delete(frameId);
  }

  sweep(): void {
    const now = this.now();
    for (const [id, frame] of this.frames) if (frame.expiresAt <= now) this.drop(id);
  }

  clear(): void {
    for (const id of [...this.frames.keys()]) this.drop(id);
  }
}
