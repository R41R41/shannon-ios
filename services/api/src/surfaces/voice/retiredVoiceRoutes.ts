import type { ServerResponse } from 'node:http';
import { sendJson } from '../../infra/http/serverHttp.js';

/** The retired-provider response stays independent of the current speech/first-audio routes. */
export function handleRetiredVoiceRoute(path: string, response: ServerResponse): boolean {
  if (!path.startsWith('/v1/voice/realtime/') && !path.startsWith('/v1/voice/identity') && !path.startsWith('/v1/voice/live/')) return false;
  sendJson(response, 410, {error:'VOICE_PROVIDER_RETIRED', message:'この音声方式は廃止されました。Gemini音声会話をご利用ください。'});
  return true;
}
