/**
 * What a Discord voice channel's turn may ask about her going into and out of the Minecraft server, and what it asks (`wiring/lifecycleRequest.ts` is
 * the other side). Only the owner's own words reach it (`platformVoice.ts`); the owner's login and logout are the same operations the operator's
 * command line has, so nothing here starts or stops a server.
 */
export type LifecycleRequestAction = 'login' | 'logout';

export const LIFECYCLE_REQUEST_CODES = ['lifecycle_unavailable', 'unresolved_operation', 'lease_conflict', 'refused', 'invalid_input',
  'server_not_running', 'in_progress', 'flooded', 'rate_limited'] as const;
export type LifecycleRequestCode = typeof LIFECYCLE_REQUEST_CODES[number];

export type LifecycleRequestResult =
  | { ok: true; lifecycleId: string | null; state: 'accepted' | 'already' | 'pending' }
  | { ok: false; code: LifecycleRequestCode; message: string };

export interface VoiceLifecyclePort {
  /** The server's state now, or null when it is not known (no fresh frame, or more than one registered server). Read without waiting. */
  state(): { running: 'running' | 'stopped' | 'unknown'; bot: 'joined' | 'absent' | 'unknown'; pending: LifecycleRequestAction | null;
    /** The names of the people in the server besides her (null or absent: not known, e.g. a body that does not send them). */
    playerNames?: readonly string[] | null } | null;
  /** What the request would be refused for, or answered at once (`already`, `pending`), without starting anything; null: it would go on. */
  check(action: LifecycleRequestAction): LifecycleRequestResult | null;
  request(action: LifecycleRequestAction, options: { threadId?: string | null; actor?: string }): Promise<LifecycleRequestResult>;
}

/** What is said when a request is refused before it starts (fixed words, never the model's guess: her reply has already promised, and a model would be slow and could be wrong). */
export function lifecycleRefusalLine(refused: Extract<LifecycleRequestResult, { ok: false }>, action: LifecycleRequestAction): string {
  switch (refused.code) {
    case 'server_not_running': return 'サーバーが動いてないから、入れないみたい。';
    case 'in_progress': return action === 'logout' ? 'まだ入ってる途中だから、ちょっと待ってね。' : 'まだ出てる途中だから、ちょっと待ってね。';
    case 'unresolved_operation':
    case 'lease_conflict': return '前の操作がまだ終わってないみたい。少し待ってね。';
    default: return action === 'login' ? 'いまは入れないみたい。' : 'いまは出られないみたい。';
  }
}
