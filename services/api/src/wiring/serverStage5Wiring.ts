import type { IncomingMessage, ServerResponse } from 'node:http';
import { dayBand } from '../contracts/cognitionLedgerContract.js';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import type { ApiRequest, ApiResponse } from '../contracts/contracts.js';
import { stage5Enabled } from '../infra/config/stage5Config.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { bindScope, readJson, sendJson } from '../infra/http/serverHttp.js';
import { createFeedbackRoute, FEEDBACK_PATH } from '../infra/http/feedbackRoutes.js';
import { createSelfInterestRoute, isSelfInterestsPath } from '../infra/http/selfInterestRoutes.js';
import { SQLiteAgentTaskStore } from '../mind/action/agentTasks/agentTaskStore.js';
import type { TaskTreeLearningCallbacks } from '../mind/action/agentTasks/agentTasksPorts.js';
import { memoryPortsOf } from './memoryOutboxWiring.js';
import { selfInterestOwnerPort } from './selfInterestWiring.js';
import { configuredStage5Feedback } from './stage5FeedbackWiring.js';
import { taskFeedbackWiring } from './taskFeedbackWiring.js';
import { taskTreeWiring } from './taskTreeWiring.js';
import { selfRewriteRuntimeWiring, type SelfRewriteRuntimeOptions } from './selfRewriteRuntimeWiring.js';

/** Stage5 is composed here. The HTTP server receives one dispatcher and keeps its existing auth and streaming paths. */
export function configuredServerStage5(environment: Readonly<Record<string, string | undefined>>, parts: {
  path: string; store: SQLiteShannonStore; ownerScope: string; now(): string;
}) {
  const enabled = stage5Enabled(environment);
  let audience: ((scope: string) => boolean) | null = null;
  let audiencePresence: ((scope: string) => 'alone'|'others'|'unknown') | null = null;
  let taskFeedback: ReturnType<typeof taskFeedbackWiring> | null = null;
  let selfRewriteRoute: ((request: ApiRequest) => Promise<ApiResponse | undefined>) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let selfRewrite: ReturnType<typeof selfRewriteRuntimeWiring> | null = null;
  const ownerAlone = (scope: string) => { try {return audience?.(scope) === true;} catch {return false;} };
  const callbacks: TaskTreeLearningCallbacks = {
    dispatchContext(scope, input) {
      let presence:'alone'|'others'|'unknown'='unknown';
      try {presence=audiencePresence?.(scope) ?? (ownerAlone(scope) ? 'alone' : 'unknown');} catch { /* No historical audience assertion. */ }
      return {presence, value:presence==='unknown' ? null : parts.store.valueVersions()?.reader(scope, 'task.execute', `${dayBand(input.at)}.${presence}`) ?? null};
    },
    taskDispatched: (scope, input) => taskFeedback?.callbacks.taskDispatched(scope, input) ?? false,
    taskVerified: (scope, proof, at) => taskFeedback?.callbacks.taskVerified(scope, proof, at) ?? false,
    taskUnusable: (scope, input) => taskFeedback?.callbacks.taskUnusable(scope, input) ?? false,
  };
  const tasks = new SQLiteAgentTaskStore(parts.path, enabled ? {taskTreeEnabled:true, taskTreeCallbacks:callbacks} : {});
  const feedback = configuredStage5Feedback(environment, {...parts, tasks, ownerAlone});
  const feedbackRoute = createFeedbackRoute({feedback:feedback?.feedback ?? null, ownerScopeKey:parts.ownerScope, ownerAlone});
  const memory = enabled ? memoryPortsOf(parts.store, parts.now) : null;
  const interests = createSelfInterestRoute({ interests:memory ? selfInterestOwnerPort(parts.store.selfInterests(), memory.commands, parts.now) : null, ownerScopeKey:parts.ownerScope, ownerAlone });
  const trees = taskTreeWiring(tasks, parts.ownerScope, parts.now);
  const privatePath = (path: string) => isSelfInterestsPath(path)
    || /^\/v1\/agent\/tasks\/[^/]+\/tree(?:\/|$)/u.test(path) || path.startsWith('/v1/autonomy/self-rewrite/');
  return {
    tasks, feedback,
    capabilities: enabled ? {self_interests:parts.store.selfInterests() !== null, task_tree:!!tasks.taskTrees, owner_feedback:!!feedback} : undefined,
    attach(options: Pick<SelfRewriteRuntimeOptions, 'autonomy'|'autonomyStore'|'config'> & {ownerAlone(scope: string): boolean; presence?(scope: string):'alone'|'others'|'unknown'; actions: ActionThreads | null;
      selfRewriteRoute?: (request: ApiRequest) => Promise<ApiResponse | undefined>}) {
      audience = options.ownerAlone; audiencePresence = options.presence ?? null;
      selfRewriteRoute = options.selfRewriteRoute ?? null;
      if (!enabled) return;
      selfRewrite = selfRewriteRuntimeWiring({environment,path:parts.path,ownerScope:parts.ownerScope,now:parts.now,
        config:options.config,autonomy:options.autonomy,autonomyStore:options.autonomyStore,tasks,actions:options.actions});
      selfRewriteRoute = options.selfRewriteRoute ?? selfRewrite.route;
      taskFeedback = taskFeedbackWiring({tasks, conversation:parts.store, actions:options.actions,
        ownerScope:parts.ownerScope, now:parts.now, ownerAlone, feedback:() => feedback?.feedback ?? null,
        flush:() => tasks.taskTrees?.flushLearning()});
      // Retries a durable receipt only, never a Host command or a model call.
      void taskFeedback.refresh();
      timer = setInterval(() => {void taskFeedback?.refresh();}, 5000); timer.unref();
    },
    afterHost: async () => {await taskFeedback?.refresh();},
    async serve(request: IncomingMessage, response: ServerResponse, principal: {scopeKey:string}|null, url: URL): Promise<boolean> {
      if (url.pathname === FEEDBACK_PATH) {await feedbackRoute(request, response, principal); return true;}
      if (!privatePath(url.pathname)) return false;
      if (!principal || principal.scopeKey !== parts.ownerScope) {sendJson(response,403,{error:'STAGE5_OWNER_ONLY'});return true;}
      if (!ownerAlone(principal.scopeKey)) {sendJson(response,403,{error:'STAGE5_OWNER_ALONE_REQUIRED'});return true;}
      if (isSelfInterestsPath(url.pathname)) {await interests(request,response,principal,url.pathname);return true;}
      const body = request.method === 'POST' ? await readJson(request, 256 * 1024) : undefined;
      if (!ownerAlone(principal.scopeKey)) {sendJson(response,403,{error:'STAGE5_OWNER_ALONE_REQUIRED'});return true;}
      const query = new URLSearchParams(url.searchParams); query.set('scopeKey',principal.scopeKey);
      const api: ApiRequest = {method:request.method as ApiRequest['method'],path:url.pathname,query,
        ...(body ? {body:bindScope(body,principal.scopeKey)} : {})};
      const result = trees.route(api) ?? await selfRewriteRoute?.(api) ?? {status:503,body:{error:'STAGE5_DISABLED'}};
      if (!ownerAlone(principal.scopeKey)) sendJson(response,403,{error:'STAGE5_OWNER_ALONE_REQUIRED'});
      else sendJson(response,result.status,result.body);
      return true;
    },
    close() {if (timer) clearInterval(timer);selfRewrite?.close();tasks.close();},
  };
}
