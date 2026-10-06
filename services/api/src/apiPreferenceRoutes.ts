import type { TurnBackgroundService } from './mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel } from './chatModel.js';
import type { ApiRequest, ApiResponse } from './contracts/contracts.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { VoiceDecisionGateway } from './voiceDecision.js';
import {
  isShannonRealtimeVoiceId,
  type ShannonVoiceIdentityMode,
  type ShannonVoiceIdentityStore,
  voiceIdentityResponse,
} from './surfaces/voice/voiceIdentity.js';

export function dispatchPreferenceRequest(request: ApiRequest, dependencies: {
  chatModel: ShannonChatModel;
  voiceDecision: VoiceDecisionGateway;
  background: TurnBackgroundService;
  voiceIdentity: ShannonVoiceIdentityStore;
  now: () => string;
}): ApiResponse | null {
  if (request.method === 'GET' && request.path === '/health') {
    return {
      status: 200,
      body: {
        ok: true,
        service: 'shannon-ios-api',
        mode: 'local',
        llm: { mode: dependencies.chatModel.mode, model: dependencies.chatModel.model },
        voiceRouting: { mode: dependencies.voiceDecision.mode, model: dependencies.voiceDecision.model },
        background: { mode: dependencies.background.mode },
      },
    };
  }
  if (request.method === 'GET' && request.path === '/v1/voice/identity') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: voiceIdentityResponse(dependencies.voiceIdentity.read(scopeKey)) };
  }
  if (request.method !== 'POST' || request.path !== '/v1/voice/identity') return null;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  const mode = request.body.mode;
  const selectedVoice = request.body.selectedVoice;
  const supportedVoice = isShannonRealtimeVoiceId(selectedVoice) ? selectedVoice : null;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  if (mode !== 'automatic' && mode !== 'manual') return badRequest('mode is invalid');
  if (mode === 'automatic' && selectedVoice !== undefined && selectedVoice !== null) {
    return badRequest('selectedVoice must be empty in automatic mode');
  }
  if (mode === 'manual' && !supportedVoice) return badRequest('selectedVoice is invalid');
  const preference = dependencies.voiceIdentity.save(
    scopeKey,
    mode as ShannonVoiceIdentityMode,
    mode === 'manual' ? supportedVoice : null,
    dependencies.now(),
  );
  return { status: 200, body: voiceIdentityResponse(preference) };
}
