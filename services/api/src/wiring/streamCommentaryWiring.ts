import { LiveGovernor } from '@shannon/mind';
import type { MinecraftLiveRoom, MinecraftLiveSpeechReceipt } from '../contracts/minecraftControlContract.js';
import type { MinecraftLive } from '../surfaces/minecraft/minecraftLive.js';
import { LiveCommentary } from '../surfaces/minecraft/minecraftLiveCommentary.js';
import type { LiveSpeechDraft } from '../surfaces/minecraft/minecraftLiveSpeech.js';
import { cleanLiveLine, liveWriterPrompt } from '../surfaces/minecraft/minecraftLiveWriter.js';
import type { CommentaryEnd, CommentaryFactory, CommentaryHooks, CommentaryPort } from '../surfaces/stream/streamContract.js';

/**
 * Her commentary on the game for a YouTube stream (`docs/stream-contract.md` §5). The moments her Minecraft body shows
 * (`MinecraftLive.onMoment`) are weighed by a `LiveGovernor` of this stream and written as short lines by the engine Discord's commentary
 * uses (`LiveCommentary`), but the room it reads is the stream's: the mouth busy with a reply is `replying`, and the quiet after she answered
 * someone is the quiet after someone's words. The lines go to the stream's mouth. No Discord switch is read here: a started stream with
 * `minecraft: true` is the only thing that starts it. The stream surface knows nothing of Minecraft; this is where the two meet.
 */
type Receipt = (receipt: MinecraftLiveSpeechReceipt, draft: LiveSpeechDraft) => void;

/** The engine's `outbox` over the stream's mouth: lines in, the mouth's endings back as the body's receipts. */
class MouthOutbox {
  private readonly listeners = new Set<Receipt>();
  private readonly drafts = new Map<string, LiveSpeechDraft>();

  constructor(private readonly hooks: CommentaryHooks) {}

  onEnd(listener: Receipt): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  room(): MinecraftLiveRoom {
    return { voice: true, humanSpeaking: false, sinceHumanMs: this.hooks.room().sinceHumanMilliseconds };
  }

  enqueue(draft: LiveSpeechDraft): void {
    const lineId = this.hooks.enqueue(draft.text, draft.ttlMilliseconds);
    if (lineId === null) return this.finish(draft, { id: draft.id, outcome: 'failed', reason: 'pushed_out' });
    this.drafts.set(lineId, draft);
  }

  /** The mouth ended one of the lines made here. */
  ended(end: CommentaryEnd): void {
    const draft = this.drafts.get(end.lineId);
    if (!draft) return;
    this.drafts.delete(end.lineId);
    this.finish(draft, { id: draft.id, outcome: end.outcome === 'spoken' ? 'spoken' : 'failed', reason: end.reason });
  }

  private finish(draft: LiveSpeechDraft, receipt: MinecraftLiveSpeechReceipt): void {
    for (const listener of this.listeners) {
      try { listener(receipt, draft); } catch { /* the engine never fails the stream */ }
    }
  }
}

function commentaryOver(live: MinecraftLive, hooks: CommentaryHooks): CommentaryPort {
  const outbox = new MouthOutbox(hooks);
  const engine = new LiveCommentary({
    live: {
      onMoment: listener => live.onMoment(listener), inDanger: () => live.inDanger(),
      conversation: () => ({ replying: hooks.room().replying, sinceHumanMilliseconds: hooks.room().sinceHumanMilliseconds }),
    },
    outbox, governor: new LiveGovernor(), now: () => hooks.now(), log: line => hooks.log(line),
    async write(request) {
      if (hooks.quiet()) return null;
      const body = live.block({ alone: false });
      const { system, message } = liveWriterPrompt({ identity: hooks.identity(), persona: hooks.persona(), body, ...request, voice: true, place: 'stream' });
      const raw = await hooks.complete(system, message);
      const line = raw === null ? null : cleanLiveLine(raw, { voice: true });
      return line === null ? null : hooks.accept(line);
    },
  });
  return { start: () => engine.start(), stop: () => engine.stop(), ended: end => outbox.ended(end), stats: () => engine.stats() };
}

/** The commentary for a stream over her body's moments; null while there is no body (a Minecraft stream then has no commentary). */
export function streamCommentary(live: () => MinecraftLive | null): () => CommentaryFactory | null {
  return () => {
    const source = live();
    return source ? hooks => commentaryOver(source, hooks) : null;
  };
}
