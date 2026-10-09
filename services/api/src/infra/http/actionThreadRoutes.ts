import type { IncomingMessage, ServerResponse } from 'node:http';
import { ACTION_ID } from '@shannon/mind';
import type { ActionThreads, ActionView } from '../../contracts/actionThreadContract.js';
import { consumeDeviceAllowance, readJson, sendJson } from './serverHttp.js';

export const ACTION_THREAD_PATH = '/v1/action-threads';
export const isActionThreadPath = (path: string) => path === ACTION_THREAD_PATH || path.startsWith(`${ACTION_THREAD_PATH}/`);
const labels = { ownTime: '自分の時間', agentTask: '作業環境での作業', minecraft: 'Minecraft', respond: '会話' };
export function publicActionThreads(views: readonly ActionView[], at: string, others: boolean) {
  const relevant = views.filter(view => view.kind !== 'respond' &&
    (['queued', 'running', 'waiting', 'stopping', 'unknown'].includes(view.state) || Date.parse(at)-Date.parse(view.updatedAt)<3_600_000));
  const count = relevant.filter(view => ['queued', 'running', 'waiting', 'stopping'].includes(view.state)).length;
  return { availability: 'ready', generatedAt: at, count, othersPresent:others, threads: others ? [] : relevant.slice(-40).map(view => ({
    id: view.id, kind: view.kind, title: labels[view.kind], origin: view.origin, state: view.state,
    progress: view.progress, result: view.result, updatedAt: view.updatedAt, failures: view.failures,
    ...(view.notification ? {notification:view.notification} : {}),
    canResume: view.kind === 'ownTime' && ['failed', 'cancelled'].includes(view.state) && view.failures < 5,
  })) };
}

/** Authenticated owner's route. No resource keys, paths, source text, runner identities or stored task notes leave it. */
export function createActionThreadRoute(actions: ActionThreads | null, ownerScope: string,
  stopOutside: (views: readonly ActionView[], requestId: string) => Promise<void>, now: () => string, audienceNow:()=>boolean=()=>false, beforeStop?: (target: string | null) => Promise<void>) {
  const usage = new Map<string, { startedAt: number; count: number }>();
  return async (request: IncomingMessage, response: ServerResponse,
    principal: { deviceId: string; scopeKey: string } | null, path: string) => {
    if (!principal || principal.scopeKey !== ownerScope) return sendJson(response, 403, { error: 'ACTION_OWNER_ONLY' });
    if (!actions) return sendJson(response, 404, { error: 'ACTION_THREADS_DISABLED' });
    if (!consumeDeviceAllowance(usage, principal.deviceId, 90)) return sendJson(response, 429, { error: 'RATE_LIMITED' });
    const url = new URL(request.url ?? path, 'http://localhost');
    // Read at delivery, after IPC and outside-stop awaits: someone may have joined while this request waited.
    const othersNow=()=>{try{return url.searchParams.get('audience')==='others'||audienceNow()!==false;}catch{return true;}};
    try {
      if (request.method === 'GET' && path === ACTION_THREAD_PATH) {
        return sendJson(response, 200, publicActionThreads(await actions.list(ownerScope), now(), othersNow()));
      }
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      const noticeMatch=path.match(/^\/v1\/action-threads\/([A-Za-z0-9_.:@-]{1,160})\/acknowledge-notice$/u);
      if(noticeMatch){
        const body=await readJson(request,4096) as Record<string,unknown>;
        if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.requestId!=='string'||!ACTION_ID.test(body.requestId)
          ||typeof body.notificationId!=='string'||!/^[a-f0-9]{64}$/u.test(body.notificationId)
          ||Object.keys(body).some(key=>!['requestId','notificationId','scopeKey'].includes(key)))return sendJson(response,400,{error:'ACTION_REQUEST'});
        const original=await actions.get(ownerScope,noticeMatch[1]!);
        // Recheck after the canonical read immediately before the only mutation; detail also gates at delivery.
        if(othersNow())return sendJson(response,403,{error:'ACTION_OWNER_ALONE'});
        if(!original||original.kind==='respond')return sendJson(response,404,{error:'ACTION_NOT_FOUND'});
        if(!await actions.acknowledgeNotice(ownerScope,original.id,body.notificationId,body.requestId))
          return sendJson(response,409,{error:'ACTION_NOTICE_CHANGED'});
        return sendJson(response,200,{requestId:body.requestId,...publicActionThreads(await actions.list(ownerScope),now(),othersNow())});
      }
      const body = await readJson(request, 4096) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.requestId !== 'string' || !ACTION_ID.test(body.requestId)
        || Object.keys(body).some(key => !['requestId', 'scopeKey'].includes(key))) return sendJson(response, 400, { error: 'ACTION_REQUEST' });
      const match = path.match(/^\/v1\/action-threads\/([A-Za-z0-9_.:@-]{1,160})\/(stop|resume)$/u);
      const target = match?.[1] ?? null;
      if (path !== `${ACTION_THREAD_PATH}/stop-all` && !match) return sendJson(response, 404, { error: 'NOT_FOUND' });
      const before = await actions.list(ownerScope);
      if (target && !before.some(view => view.id === target && view.kind !== 'respond')) return sendJson(response, 404, { error: 'ACTION_NOT_FOUND' });
      if (match?.[2] === 'resume') {
        const view = before.find(item => item.id === target)!;
        if (view.kind !== 'ownTime' || !await actions.resume(ownerScope, target!)) return sendJson(response, 409, { error: 'ACTION_CANNOT_RESUME' });
      } else {
        await beforeStop?.(target);
        const views = await actions.stop(ownerScope, target, body.requestId);
        await stopOutside(views, body.requestId);
      }
      return sendJson(response, 200, { requestId: body.requestId, ...publicActionThreads(await actions.list(ownerScope), now(), othersNow()) });
    } catch {
      // The stop may already be accepted. Client must re-read, never blindly resend the mutation.
      return sendJson(response, 503, { error: 'ACTION_STATE_UNAVAILABLE', availability: 'recovering' });
    }
  };
}
