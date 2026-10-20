import type { MinecraftLiveRoom, MinecraftLiveSpeech, MinecraftLiveSpeechReceipt } from '../../contracts/minecraftControlContract.js';

/**
 * The lines of hers waiting to be handed to her body (session dc-live; `SHANNON_MINECRAFT_LIVE_SPEECH`). The control's reply carries at
 * most one at a time; the body answers in a later poll with what it did (`speechReceipts`). A line the body has not answered is offered
 * again a few seconds later (a lost reply), up to a few times, and is dropped when its time is up; the body says each id once. Nothing
 * here waits on the body: the control only asks for what is due, and the engine hears the end of each line through `onEnd`.
 */
export const LIVE_SPEECH_LIMITS = Object.freeze({
  /** At most this many lines wait; a new one pushes out the oldest ordinary one. */
  waiting: 3,
  /** A line is offered again after this long without a receipt, at most `offers` times in all. */
  reofferMilliseconds: 4_000,
  offers: 3,
  /** The body's room reading counts as current this long. */
  roomMilliseconds: 10_000,
});

export interface LiveSpeechDraft { id: string; text: string; urgency: 'ordinary' | 'urgent'; kind: string; ttlMilliseconds: number }
interface Waiting extends LiveSpeechDraft { expiresAt: number; offeredAt: number | null; offers: number }
export type LiveSpeechEnd = (receipt: MinecraftLiveSpeechReceipt, draft: LiveSpeechDraft) => void;

export class LiveSpeechOutbox {
  private waiting: Waiting[] = [];
  private roomReading: { room: MinecraftLiveRoom; at: number } | null = null;
  private readonly listeners = new Set<LiveSpeechEnd>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Told when a line ends: the body's receipt, or `failed` with `expired` / `lost` / `pushed_out` when it never got one. */
  onEnd(listener: LiveSpeechEnd): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pending(): number { return this.waiting.length; }

  /** The room the body last told, while its reading is current; null when it has not told, or not lately (no voice, nobody known). */
  room(): MinecraftLiveRoom | null {
    const reading = this.roomReading;
    return reading && this.now() - reading.at <= LIVE_SPEECH_LIMITS.roomMilliseconds ? reading.room : null;
  }

  enqueue(draft: LiveSpeechDraft): void {
    if (this.waiting.length >= LIVE_SPEECH_LIMITS.waiting) {
      const out = this.waiting.findIndex(item => item.urgency === 'ordinary');
      const [pushed] = this.waiting.splice(out < 0 ? 0 : out, 1);
      if (pushed) this.end({ id: pushed.id, outcome: 'failed', reason: 'pushed_out' }, pushed);
    }
    this.waiting.push({ ...draft, expiresAt: this.now() + draft.ttlMilliseconds, offeredAt: null, offers: 0 });
  }

  /** The line due in this reply (at most one), as the wire carries it. */
  take(): MinecraftLiveSpeech[] {
    const now = this.now();
    for (const item of [...this.waiting]) {
      if (now >= item.expiresAt) this.drop(item, 'expired');
      else if (item.offers >= LIVE_SPEECH_LIMITS.offers && item.offeredAt !== null && now - item.offeredAt >= LIVE_SPEECH_LIMITS.reofferMilliseconds) {
        this.drop(item, 'lost');
      }
    }
    const due = this.waiting.find(item => item.offeredAt === null || now - item.offeredAt >= LIVE_SPEECH_LIMITS.reofferMilliseconds);
    if (!due || due.offers >= LIVE_SPEECH_LIMITS.offers) return [];
    due.offeredAt = now;
    due.offers += 1;
    return [{ id: due.id, text: due.text, urgency: due.urgency, kind: due.kind, expiresAt: new Date(due.expiresAt).toISOString() }];
  }

  /** What a poll brought: the room, and the body's answers for lines it was handed. */
  receive(receipts: readonly MinecraftLiveSpeechReceipt[], room: MinecraftLiveRoom | null): void {
    if (room) this.roomReading = { room, at: this.now() };
    for (const receipt of receipts) {
      const item = this.waiting.find(candidate => candidate.id === receipt.id);
      if (!item) continue;
      this.waiting = this.waiting.filter(candidate => candidate !== item);
      this.end(receipt, item);
    }
  }

  private drop(item: Waiting, reason: string): void {
    this.waiting = this.waiting.filter(candidate => candidate !== item);
    this.end({ id: item.id, outcome: 'failed', reason }, item);
  }

  private end(receipt: MinecraftLiveSpeechReceipt, draft: LiveSpeechDraft): void {
    for (const listener of this.listeners) {
      try { listener(receipt, draft); } catch { /* the engine never fails a poll */ }
    }
  }
}
