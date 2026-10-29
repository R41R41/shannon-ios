import { STREAM_LIMITS } from './streamContract.js';

/**
 * The replies to write in the YouTube chat too (decision B, only for a stream started with `chatWrites`): a reply she has said waits here
 * for the ear to post it, and is dropped when the ear says how it went (or after two minutes). Words in memory, gone with the stream.
 */
interface ChatPost { id: string; text: string; createdMs: number }

export class StreamChatPosts {
  private readonly posts = new Map<string, ChatPost>();
  posted = 0;
  failed = 0;

  /** A said reply, as YouTube's chat takes it (a name in front, cut to its length). */
  add(lineId: string, text: string, name: string | undefined, nowMs: number): void {
    const body = Array.from(name && !text.includes(name) ? `${name}さん、${text}` : text).slice(0, STREAM_LIMITS.chatPostCharacters).join('');
    this.posts.set(`cp-${lineId}`, { id: `cp-${lineId}`, text: body, createdMs: nowMs });
    while (this.posts.size > STREAM_LIMITS.chatPostsKept) this.posts.delete(this.posts.keys().next().value as string);
  }

  /** What the ear should post now (at most five). */
  pending(nowMs: number): { id: string; text: string }[] {
    for (const [id, post] of this.posts) if (nowMs - post.createdMs > 2 * 60_000) this.posts.delete(id);
    return [...this.posts.values()].slice(0, 5).map(({ id, text }) => ({ id, text }));
  }

  receipt(id: string, outcome: 'posted' | 'failed'): boolean {
    if (!this.posts.delete(id)) return false;
    if (outcome === 'posted') this.posted += 1;
    else this.failed += 1;
    return true;
  }

  reset(): void {
    this.posts.clear();
    this.posted = 0;
    this.failed = 0;
  }

  clear(): void { this.posts.clear(); }
}
