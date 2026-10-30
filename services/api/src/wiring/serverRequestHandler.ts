import { serveFcaTaskRoute } from '../wiring/serverFcaWiring.js';
import { handleDeviceManagement, handlePushRegistration } from '../infra/auth/serverDeviceRoutes.js';
import { bindScope, consumeDeviceAllowance, readJson, sendJson } from '../infra/http/serverHttp.js';
import { bearerAuthorized } from '../infra/auth/apiAuth.js';
import { handleVoiceVisionSnapshot } from '../surfaces/voice/serverVoiceVisionRoute.js';
import { handleRetiredVoiceRoute } from '../surfaces/voice/retiredVoiceRoutes.js';
import { MODEL_MODE_PATH } from '../infra/http/modelModeRoutes.js';
import { failureTrail } from '../infra/http/failureTrail.js';
import { isValuesPath } from '../infra/http/learningRoutes.js';
import { isSkillsPath } from '../infra/http/skillRoutes.js';
import { handlePlatformBridgeRequest, isPlatformBridgePath } from '../surfaces/platform/serverPlatformBridgeRoute.js';
import { VOICE_CALL_MEMORY_PATH } from '../infra/http/apiPeopleMemoryRoutes.js';
import { BODY_CAPABILITIES_PATH, isBodyRoute } from '../surfaces/body/apiBodyRoutes.js';
import { mayHaveDesktopBody, requestDeviceId } from '../mind/inhibition/desktopBodyIdentity.js';
import { bodyLookRequestBytes } from '../wiring/bodyLookWiring.js';
import { isOpsPath } from '../infra/ops/serverOpsRoutes.js';
import { dispatchWithChatSentences } from '../surfaces/text/serverChatSentenceStream.js';
import { CALENDAR_UPCOMING_PATH, calendarRequestBytes } from '../contracts/calendarContract.js';
import { HOST_STEP_CLAIM_PATH, closedSignal, hostStepRequestBytes } from '../infra/http/apiAutonomyHostStepRoutes.js';
import { SHANNON_NOW_PATH } from '../contracts/shannonNowContract.js';
import { MOOD_HISTORY_PATH } from '../contracts/moodHistoryContract.js';
import { isActionThreadPath } from '../infra/http/actionThreadRoutes.js';
import type { RequestListener } from 'node:http';
import type { ApiRequestPorts } from '../server.js';
export function createApiRequestHandler(ports: ApiRequestPorts): RequestListener {
  const {
    pushStore,
    stage5,
    voiceVisionGateway,
    bodyStore,
    modelModes,
    minecraft,
    reachOuts,
    privateListeningRoute,
    incomingCallRoute,
    ownerCallFacts,
    externalActions,
    deviceActions,
    innerNote,
    kernel,
    addressed,
    platformBridge,
    serveListen,
    miniPoses,
    authMode,
    apiToken,
    deviceAuth,
    pairingRoute,
    signalObserver,
    opsRoute,
    shannonNowRoute,
    moodHistoryRoute,
    skillsRoute,
    valuesRoute,
    fca,
    stream,
    deviceUsage,
    bodyUsage,
    handleVoiceTranscription,
    geminiSpeechRoute,
    geminiLiveRoute,
    liveVoiceStreamRoute,
  } = ports;
  return async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'DELETE') {
        sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const method = request.method;
      const calendarDelete = request.method === 'DELETE';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      async function serveBeforePairing() {
        if (signalObserver.asset(request, response, url.pathname)) return true;

        if (
          (calendarDelete && url.pathname !== CALENDAR_UPCOMING_PATH) ||
          (request.method === 'PUT' &&
            url.pathname !== BODY_CAPABILITIES_PATH &&
            url.pathname !== CALENDAR_UPCOMING_PATH &&
            url.pathname !== MODEL_MODE_PATH)
        ) {
          sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
          return true;
        }
        if (url.pathname === '/v1/pair') {
          await pairingRoute(request, response);
          return true;
        }
        if (url.pathname.startsWith('/v1/agent/host/')) {
          async function serveAgentHost() {
            const hostToken = process.env.SHANNON_AGENT_HOST_TOKEN?.trim();
            if (!hostToken || hostToken.length < 32) {
              sendJson(response, 503, { error: 'AGENT_HOST_NOT_CONFIGURED' });
              return;
            }
            if (!bearerAuthorized(request.headers.authorization, hostToken)) {
              sendJson(response, 401, { error: 'AGENT_HOST_UNAUTHORIZED' });
              return;
            }
            const hostBody = request.method === 'POST' ? await readJson(request, 256 * 1024) : undefined;
            const hostRequest = await externalActions.filterHostEvents({
              method,
              path: url.pathname,
              query: url.searchParams,
              body: hostBody,
            });
            const result = (await externalActions.beforeHost(hostRequest)) ?? (await kernel.dispatch(hostRequest));
            await externalActions.afterHost(hostRequest, result);
            await stage5.afterHost();
            sendJson(response, result.status, result.body);
            return;
          }
          await serveAgentHost();
        return true;
        }
        if (isOpsPath(url.pathname)) {
          if (!minecraft.refusesConsole(request, response, deviceAuth)) await opsRoute(url.pathname, request, response, url.searchParams);
          // Never her Minecraft body's token.
          return true;
        }
        if (isPlatformBridgePath(url.pathname)) {
          await handlePlatformBridgeRequest(url.pathname, request, response, platformBridge);
          return true;
        }
        return false;
      }
      if (await serveBeforePairing()) return;
      const principal = deviceAuth ? deviceAuth.authenticate(request.headers.authorization) : null;
      const authorized = authMode === 'paired' ? principal !== null : bearerAuthorized(request.headers.authorization, apiToken);
      if (!authorized) {
        sendJson(response, 401, { error: 'PAIRING_REQUIRED', message: '接続コードでシャノンと接続してください。' });
        return;
      }
      async function servePairedRoutes() {
        if (url.pathname.startsWith('/v1/observer/')) {
          await signalObserver.route(request, response, url.pathname, principal, url);
          return true;
        }
        if (await minecraft.serve(request, response, url.pathname, principal)) return true; // Her Minecraft body's token reaches its own routes only.
        if (await stream.serve(request, response, principal, url)) return true; // The stream's console and her mouth (the owner's paired device).
        if (await serveFcaTaskRoute(fca, request, response, principal, url)) return true;
        if (url.pathname === MODEL_MODE_PATH) {
          await modelModes.route(request, response, principal);
          return true;
        }
        if (isActionThreadPath(url.pathname)) {
          await externalActions.route(request, response, principal, url.pathname);
          return true;
        }
        if (url.pathname === SHANNON_NOW_PATH) {
          shannonNowRoute(request, response, principal);
          return true;
        }
        if (url.pathname === MOOD_HISTORY_PATH) {
          moodHistoryRoute(request, response, principal);
          return true;
        }
        if (isValuesPath(url.pathname)) {
          await valuesRoute(request, response, principal, url.pathname);
          return true;
        }
        if (isSkillsPath(url.pathname)) {
          await skillsRoute(request, response, principal, url.pathname);
          return true;
        }
        async function serveBodyRoutes() {
          if (
            (await deviceActions.serve(request, response, principal, url)) ||
            innerNote?.serve(request, response, principal, url) ||
            (await addressed.serve(request, response, principal, url)) ||
            (await serveListen(request, response, principal, url)) ||
            (await miniPoses.serve(request, response, principal, url))
          )
            return true;
          if (await stage5.serve(request, response, principal, url)) return true;
          return false;
        }
        if (await serveBodyRoutes()) return true;
        if (handleRetiredVoiceRoute(url.pathname, response)) return true;
        async function serveVoiceRoute() {
          if (url.pathname === '/v1/voice/transcriptions') {
            await handleVoiceTranscription(request, response, principal);
            return true;
          }
          if (
            url.pathname === '/v1/voice/gemini/speech' ||
            url.pathname === '/v1/voice/gemini/speech/stream' ||
            url.pathname === '/v1/voice/speech/stream'
          ) {
            await signalObserver.speech(
              principal,
              () => geminiSpeechRoute(request, response, principal, url.pathname.endsWith('/stream') ? 'stream' : 'unary'),
              request.headers['x-shannon-observer-run'],
            );
            return true;
          }
          if (url.pathname === '/v1/voice/gemini/cascade/sessions') {
            await geminiLiveRoute(request, response, principal);
            return true;
          }
          if (url.pathname === '/v1/voice/gemini/cascade/delegations/stream') {
            await liveVoiceStreamRoute(request, response, principal);
            return true;
          }
          if (url.pathname === '/v1/voice/vision/snapshots') {
            await handleVoiceVisionSnapshot(request, response, principal, { gateway: voiceVisionGateway, kernel });
            return true;
          }
          return false;
        }
        if (await serveVoiceRoute()) return true;
        return false;
      }
      if (await servePairedRoutes()) return;
      async function dispatchDeviceRequest() {
        const readDeviceBody = async () => {
          const body =
            request.method !== 'GET' && !calendarDelete
              ? await readJson(
                  request,
                  url.pathname === VOICE_CALL_MEMORY_PATH
                    ? 192 * 1024
                    : (bodyLookRequestBytes(url.pathname) ??
                        calendarRequestBytes(url.pathname) ??
                        hostStepRequestBytes(url.pathname) ??
                        64 * 1024),
                )
              : undefined;
          return body;
        };
        const body = await readDeviceBody();
        const query = new URLSearchParams(url.searchParams);
        if (principal) query.set('scopeKey', principal.scopeKey);
        const deviceId = principal
          ? requestDeviceId(principal.deviceId, request.headers['x-shannon-body'], request.method, url.pathname, () =>
              mayHaveDesktopBody({
                isGame: minecraft.isGameDevice(principal),
                registration: () => bodyStore.capabilities(principal.scopeKey, principal.deviceId),
                appSurface: () => ownerCallFacts.surface(principal.scopeKey, principal.deviceId),
              }),
            )
          : undefined;
        // Her desktop body in an app speaks for a device of its own (desktopBodyIdentity.ts).
        if (principal && deviceId !== principal.deviceId) response.setHeader('x-shannon-body', 'desktop'); // Says to the app that its body was heard as one.
        if (url.pathname === '/v1/devices') {
          handleDeviceManagement(request, response, body, principal, {
            deviceAuth,
            pushStore,
            revoked: (deviceId) => incomingCallRoute?.invalidateDevice(deviceId),
          });
          return;
        }
        if (url.pathname === '/v1/push/register') {
          handlePushRegistration(request, response, body, principal, { deviceAuth, pushStore });
          return;
        }
        if (privateListeningRoute.handle(request, response, url, body, principal)) return;
        if (incomingCallRoute?.handle(request, response, url, body, principal)) return;
        const isPairedChat = principal !== null && url.pathname === '/v1/chat';
        function requestLimitReached() {
          if (isPairedChat && !consumeDeviceAllowance(deviceUsage, principal.deviceId, 20)) {
            sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度話しかけてください。' });
            return true;
          }
          if (isPairedChat && ports.activeChats >= 2) {
            sendJson(response, 429, { error: 'BUSY', message: 'いま少し混み合っています。' });
            return true;
          }
          // The body polls presence and reports touches; this keeps one device from flooding either.
          if (deviceId && isBodyRoute(url.pathname) && !consumeDeviceAllowance(bodyUsage, deviceId, 120)) {
            sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many body requests; retry after a minute.' });
            return true;
          }
          return false;
        }
        // 上限確認から枠の確保までawaitを挟まず、同時到着でも残り枠を二重に取らない。
        if (requestLimitReached()) return;
        if (isPairedChat) ports.activeChats += 1;
        async function dispatchChat() {
          try {
            const result = await dispatchWithChatSentences(kernel, response, {
              method,
              path: url.pathname,
              query,
              body: principal ? bindScope(body, principal.scopeKey) : body,
              ...(deviceId ? { deviceId } : {}),
              // A held long-poll claim of her folder's device ends when the device goes away, so no step is handed to nobody.
              ...(url.pathname === HOST_STEP_CLAIM_PATH ? { signal: closedSignal(response) } : {}),
            });
            const forBody = result && principal && deviceId && request.method === 'GET' && url.pathname === '/v1/initiatives';
            // Her body is not handed a message an app says through his earphones.
            if (result)
              sendJson(
                response,
                result.status,
                forBody ? privateListeningRoute.reachOuts.bodyInitiatives(principal.scopeKey, deviceId, result.body) : result.body,
              );
          } finally {
            if (isPairedChat) ports.activeChats -= 1;
          }
        }
        await dispatchChat();
      }
      await dispatchDeviceRequest();
    } catch (error) {
      if (error instanceof Error && error.message === 'request body too large') {
        sendJson(response, 413, { error: 'REQUEST_TOO_LARGE', message: 'リクエストが大きすぎます。' });
        return;
      }
      if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: 'INVALID_REQUEST', message: error.message });
        return;
      }
      console.error('Shannon request failed', failureTrail(error));
      sendJson(response, 502, {
        error: 'MODEL_UNAVAILABLE',
        message: 'Shannonの言語モデルに接続できませんでした。',
      });
    }
  };
}
