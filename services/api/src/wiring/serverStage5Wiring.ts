import type { IncomingMessage, ServerResponse } from 'node:http';
import { switchOn } from '@shannon/switches';
import type { DatabaseSync } from 'node:sqlite';
import { dayBand } from '../contracts/cognitionLedgerContract.js';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import type { ApiRequest, ApiResponse } from '../contracts/contracts.js';
import { stage5Enabled } from '../infra/config/stage5Config.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { bindScope, readJson, sendJson } from '../infra/http/serverHttp.js';
import { createFeedbackRoute, FEEDBACK_PATH } from '../infra/http/feedbackRoutes.js';
import { createSelfInterestRoute, isSelfInterestsPath } from '../infra/http/selfInterestRoutes.js';
import { SQLiteAgentTaskStore } from '../mind/action/agentTasks/agentTaskStore.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import type { TaskTreeLearningCallbacks } from '../mind/action/agentTasks/agentTasksPorts.js';
import { memoryPortsOf } from './memoryOutboxWiring.js';
import { selfInterestOwnerPort } from './selfInterestWiring.js';
import { configuredStage5Feedback } from './stage5FeedbackWiring.js';
import { taskFeedbackWiring } from './taskFeedbackWiring.js';
import { taskTreeWiring } from './taskTreeWiring.js';
import { configuredConversationExtras } from './conversationExtrasWiring.js';
import { selfRewriteRuntimeWiring, type SelfRewriteRuntimeOptions } from './selfRewriteRuntimeWiring.js';
import { executiveRouteWiring } from './executiveRouteWiring.js';

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
  let executive: ReturnType<typeof executiveRouteWiring> | null = null;
  const ownerAlone = (scope: string) => { try {return audience?.(scope) === true;} catch {return false;} };
  let reportVisible: ((taskId: string) => boolean) | null = null;
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
  // ADR-0009 stage 1, S5: an Agent Host task whose action closed with its outcome unknown is closed as failed (never re-sent).
  const closedUnknown = (db: DatabaseSync) => new ActionLeaseReader(db).closedUnknownHostTasks();
  const unknownExit = setInterval(() => {
    let closed = 0;
    try {
      closed = tasks.closeUnknownOutcomes(parts.now(), closedUnknown);
    } catch { /* A busy database is tried again on the next tick. */ }
    if (closed) console.log(`Shannon closed ${closed} Agent Host task(s) with an unknown outcome`);
  }, 10_000);
  unknownExit.unref();
  const feedback = configuredStage5Feedback(environment, {...parts, tasks, ownerAlone});
  const feedbackRoute = createFeedbackRoute({feedback:feedback?.feedback ?? null, ownerScopeKey:parts.ownerScope, ownerAlone});
  const memory = enabled ? memoryPortsOf(parts.store, parts.now) : null;
  const interests = createSelfInterestRoute({ interests:memory ? selfInterestOwnerPort(parts.store.selfInterests(), memory.commands, parts.now) : null, ownerScopeKey:parts.ownerScope, ownerAlone });
  const trees = taskTreeWiring(tasks, parts.ownerScope, parts.now);
  // Rich chat (docs/rich-chat-contract.md): reactions and report cards, with or without Stage5; reactions become feedback only with it.
  const conversationExtras = configuredConversationExtras(parts.store, { ownerScope: parts.ownerScope, now: parts.now, ownerAlone,
    feedback: () => feedback?.feedback ?? null, reportVisible: taskId => reportVisible?.(taskId) === true });
  const privatePath = (path: string) => isSelfInterestsPath(path)
    || /^\/v1\/agent\/tasks\/[^/]+\/tree(?:\/|$)/u.test(path) || path.startsWith('/v1/autonomy/self-rewrite/');
  return {
    tasks, feedback, conversationExtras,
    capabilities: enabled ? {self_interests:parts.store.selfInterests() !== null, task_tree:!!tasks.taskTrees, owner_feedback:!!feedback} : undefined,
    attach(options: Pick<SelfRewriteRuntimeOptions, 'autonomy'|'autonomyStore'|'config'> & {ownerAlone(scope: string): boolean; reportVisible?(taskId: string): boolean; presence?(scope: string):'alone'|'others'|'unknown'; actions: ActionThreads | null;
      selfRewriteRoute?: (request: ApiRequest) => Promise<ApiResponse | undefined>}) {
      audience = options.ownerAlone; audiencePresence = options.presence ?? null; reportVisible = options.reportVisible ?? null;
      selfRewriteRoute = options.selfRewriteRoute ?? null;
      // The owner's Executive routes (ADR-0009 stage 2, E1/E2), with or without Stage5: goals, confirm, catalog, choices, inspection.
      executive = executiveRouteWiring({ path: parts.path, ownerScope: parts.ownerScope, now: parts.now, store: parts.store,
        autonomy: options.autonomy, autonomyStore: options.autonomyStore, config: options.config, executive: switchOn(environment, 'SHANNON_EXECUTIVE') });
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
      if (await executive?.serve(request, response, principal, url)) return true;
      if (await conversationExtras.serve(request, response, principal, url)) return true;
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
    close() {if (timer) clearInterval(timer);clearInterval(unknownExit);selfRewrite?.close();executive?.close();tasks.close();},
  };
}
