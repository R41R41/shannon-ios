import { estimatedOpenAICostUsd, responseUsage, type LlmUsageStore } from '../../infra/models/llmUsage.js';
import { configuredResponseModel, isHaikuModel } from '../../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured, type ClaudeBackground } from '../../infra/models/claude/claudeStructured.js';
import { createHash } from 'node:crypto';
import type { ShannonConversationItem } from '../../infra/models/chatModel.js';
import type {
  OrganizeItem,
  OrganizeOperation,
  OrganizeSession,
  OrganizeTaskDraft,
  OrganizeUpdateField,
  VoyagerProjectProjection,
  VoyagerTaskProjection,
  VoyagerOpenTaskList,
  VoyagerTaskReference,
} from './organize.js';
import {
  OrganizeError,
  bounded,
  explicitVoyagerUpdateDraft,
  extractResponseText,
  isOrganizeCommand,
  normalizedLimit,
  normalizedProjectProjection,
  normalizedTaskProjection,
  normalizedUpdateFields,
  projectionItems,
  requiredBounded,
} from './organizeSupport.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

export interface OrganizeExtractor {
  readonly mode: string;
  extract(scopeKey: string, messages: readonly ShannonConversationItem[]): Promise<OrganizeTaskDraft[]>;
}

export class LocalOrganizeExtractor implements OrganizeExtractor {
  readonly mode = 'local-stub';
  async extract(_scopeKey: string, messages: readonly ShannonConversationItem[]): Promise<OrganizeTaskDraft[]> {
    const explicitUpdate = explicitVoyagerUpdateDraft(messages);
    if (explicitUpdate) return [explicitUpdate];
    const last = [...messages].reverse().find(message => message.role === 'user' && !isOrganizeCommand(message.content));
    if (!last) return [];
    const text = last.content.replace(/\s+/gu, ' ').trim();
    return [{ title: bounded(text, 80), details: bounded(text, 1_000) }];
  }
}

export class OpenAIOrganizeExtractor implements OrganizeExtractor {
  readonly mode: 'openai' | 'anthropic';
  readonly model: string;
  private readonly fetcher: typeof fetch;
  /** The background route of a Claude model (`claudeStructured.ts`); null keeps the OpenAI Responses request. */
  private readonly claude: ClaudeBackground | null;
  constructor(private readonly options: { apiKey: string; model: string; endpoint?: string; fetcher?: typeof fetch; usageStore?: LlmUsageStore; }) {
    this.model = options.model;
    this.mode = isHaikuModel(this.model) ? 'anthropic' : 'openai';
    this.claude = claudeBackground(this.model, options);
    this.fetcher = options.fetcher ?? fetch;
  }
  async extract(scopeKey: string, messages: readonly ShannonConversationItem[]): Promise<OrganizeTaskDraft[]> {
    if (!messages.length) return [];
    const explicitUpdate = explicitVoyagerUpdateDraft(messages);
    if (explicitUpdate) return [explicitUpdate];
    const input = messages.slice(-100).map(message => ({ role: message.role, content: message.content.slice(0, 4_000) }));
    const decoded = this.claude ? await this.claudeTasks(this.claude, scopeKey, input) : await this.openAITasks(scopeKey, input);
    if (!decoded || typeof decoded !== 'object' || !Array.isArray((decoded as { tasks?: unknown }).tasks)) throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
    return (decoded as { tasks: unknown[] }).tasks.map(value => {
      if (!value || typeof value !== 'object') throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
      const row = value as Record<string, unknown>;
      if (typeof row.operation !== 'string' || !['create', 'update'].includes(row.operation)
        || typeof row.targetQuery !== 'string' || typeof row.title !== 'string' || typeof row.details !== 'string'
        || !Array.isArray(row.updateFields) || typeof row.projectSelectionRequired !== 'boolean') {
        throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
      }
      const operation = row.operation as OrganizeOperation;
      if (operation === 'create') {
        return { title: requiredBounded(row.title, 500, 'title'), details: bounded(row.details, 1_000), operation };
      }
      const targetQuery = requiredBounded(row.targetQuery, 160, 'targetQuery');
      const updateFields = normalizedUpdateFields(row.updateFields as OrganizeUpdateField[], operation, false);
      const projectSelectionRequired = row.projectSelectionRequired === true;
      const fields = projectSelectionRequired && !updateFields.includes('projectIds')
        ? [...updateFields, 'projectIds' as const]
        : updateFields;
      if (fields.length === 0) throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502);
      return {
        operation, targetQuery, updateFields: fields, projectSelectionRequired,
        title: fields.includes('title') ? requiredBounded(row.title, 500, 'title') : targetQuery,
        details: fields.includes('details') ? bounded(row.details, 1_000) : '',
      };
    });
  }

  private async claudeTasks(claude: ClaudeBackground, scopeKey: string, input: readonly ShannonConversationItem[]): Promise<unknown> {
    const answer = await completeStructured('organize', ORGANIZE_INSTRUCTIONS, input, ORGANIZE_SCHEMA,
      { claude, scopeKey, maximumOutputTokens: 2_000, effort: 'none', signal: AbortSignal.timeout(30_000), read: decodedTasks });
    if (!answer.ok) throw new OrganizeError('EXTRACTION_UNAVAILABLE', 502, true);
    return answer.value;
  }

  private async openAITasks(scopeKey: string, input: readonly ShannonConversationItem[]): Promise<unknown> {
    const response = await this.fetcher(this.options.endpoint ?? 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        instructions: ORGANIZE_INSTRUCTIONS,
        input,
        reasoning: { effort: 'none' },
        text: { verbosity: 'low', format: {
          type: 'json_schema', name: 'shannon_organize_voyager_tasks', strict: true,
          schema: ORGANIZE_SCHEMA,
        } },
        max_output_tokens: 2_000, store: false,
        prompt_cache_key: `shannon_organize_${createHash('sha256').update(scopeKey).digest('hex').slice(0, 32)}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new OrganizeError('EXTRACTION_UNAVAILABLE', 502, true);
    const usage = responseUsage(envelope);
    this.options.usageStore?.recordLlmUsage({ scopeKey, lane: 'chat', model: this.model, ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage), occurredAt: new Date().toISOString() });
    return decodedTasks(typeof envelope.output_text === 'string' ? envelope.output_text : extractResponseText(envelope.output));
  }
}

const ORGANIZE_INSTRUCTIONS = `会話から、ユーザーが実際に行いたい未完了の行動だけをVoyager Task案へ変換する。\n
各案は単独で着手できる粒度にする。単なる話題、完了済み事項、Shannonの相槌、内部推論はTaskにしない。\n
新規Taskはoperation=create、targetQuery=""、updateFields=[]、projectSelectionRequired=falseとする。titleは動詞で終わる短い日本語、detailsは具体的な実行内容にする。\n
既存Taskの更新依頼はoperation=updateとし、targetQueryへ対象Taskを検索できる元の名前、updateFieldsへユーザーが変更を求めたフィールドだけを入れる。変更を求められていないtitleを絶対にupdateFieldsへ入れず、更新操作の説明をtitleやdetailsとして生成しない。title/detailsには変更後の値を入れ、変更しないフィールドは空文字にする。Projectを選びたい依頼はupdateFieldsへprojectIdsを入れ、projectSelectionRequired=trueにする。会話全文を複製しない。最大12件。`;

const ORGANIZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { tasks: { type: 'array', maxItems: 12, items: {
    type: 'object', additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['create', 'update'] },
      targetQuery: { type: 'string' },
      title: { type: 'string' },
      details: { type: 'string' },
      updateFields: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['title', 'details', 'projectIds'] } },
      projectSelectionRequired: { type: 'boolean' },
    },
    required: ['operation', 'targetQuery', 'title', 'details', 'updateFields', 'projectSelectionRequired'],
  } } }, required: ['tasks'],
};

function decodedTasks(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new OrganizeError('EXTRACTION_RESPONSE_INVALID', 502); }
}

export function createConfiguredOrganizeExtractor(environment: Readonly<Record<string, string | undefined>> = serverEnvironment(), usageStore?: LlmUsageStore): OrganizeExtractor {
  const selected = configuredResponseModel(environment, 'SHANNON_ORGANIZE_MODEL', environment.SHANNON_LLM_MODEL);
  if (!selected) return new LocalOrganizeExtractor();
  if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(selected.model)) throw new Error('SHANNON_ORGANIZE_MODEL is invalid');
  return new OpenAIOrganizeExtractor({ ...selected, usageStore });
}

export interface VoyagerTaskDestination {
  apply(session: OrganizeSession, item: OrganizeItem): Promise<VoyagerTaskReference>;
}

export interface VoyagerCatalog {
  /** Complete or explicitly truncated open tasks; no keyword search. Optional for older adapters. */
  listOpenTasks?(limit: number): Promise<VoyagerOpenTaskList>;
  searchTasks(query: string, limit: number): Promise<VoyagerTaskProjection[]>;
  listProjects(limit: number): Promise<VoyagerProjectProjection[]>;
  /**
   * Open tasks that are due in `[from, until)`. Present only when the deployment names a Voyager read for it
   * (`SHANNON_VOYAGER_TASK_UPCOMING_URL`); the search contract has no due date, so without it nothing is read.
   */
  upcomingTasks?(from: string, until: string, limit: number): Promise<{ id: string; title: string; dueAt: string }[]>;
}

export class DisabledVoyagerCatalog implements VoyagerCatalog {
  async listOpenTasks(): Promise<VoyagerOpenTaskList> { throw new OrganizeError('DESTINATION_NOT_CONFIGURED', 503, false); }
  async searchTasks(): Promise<VoyagerTaskProjection[]> { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
  async listProjects(): Promise<VoyagerProjectProjection[]> { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
}

export class HttpVoyagerCatalog implements VoyagerCatalog {
  constructor(private readonly options: {
    tasksEndpoint: string;
    projectsEndpoint: string;
    token: string;
    workspaceId: string;
    fetcher?: typeof fetch;
    upcomingEndpoint?: string;
    openTasksEndpoint?: string;
  }) {
    if (options.upcomingEndpoint) this.upcomingTasks = (from, until, limit) => this.readUpcoming(options.upcomingEndpoint!, from, until, limit);
  }

  upcomingTasks?: VoyagerCatalog['upcomingTasks'];

  private async readUpcoming(endpoint: string, from: string, until: string, limit: number): Promise<{ id: string; title: string; dueAt: string }[]> {
    const url = new URL(endpoint);
    url.searchParams.set('workspaceId', this.options.workspaceId);
    url.searchParams.set('dueFrom', from);
    url.searchParams.set('dueBefore', until);
    url.searchParams.set('limit', String(normalizedLimit(limit, 20, 50)));
    return projectionItems(await this.read(url)).flatMap(item => {
      const row = item as { id?: unknown; title?: unknown; dueAt?: unknown };
      return typeof row?.id === 'string' && typeof row.title === 'string' && typeof row.dueAt === 'string' && Number.isFinite(Date.parse(row.dueAt))
        ? [{ id: bounded(row.id, 160), title: bounded(row.title, 500), dueAt: row.dueAt }] : [];
    });
  }

  async listOpenTasks(limit: number): Promise<VoyagerOpenTaskList> {
    const url = this.options.openTasksEndpoint ? new URL(this.options.openTasksEndpoint) : new URL(this.options.tasksEndpoint.replace(/\/tasks\/search(?:\?.*)?$/u, '/tasks/open'));
    url.searchParams.set('workspaceId', this.options.workspaceId);
    const bound = normalizedLimit(limit, 20, 50);
    url.searchParams.set('limit', String(bound));
    const value = await this.read(url);
    const rows = projectionItems(value);
    if (typeof value.hasMore !== 'boolean' || rows.length > bound) throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
    const items = rows.map(item => {
      const row = item as Record<string, unknown>;
      const task = normalizedTaskProjection(item as VoyagerTaskProjection);
      if (!['thinking', 'pending', 'inProgress'].includes(task.status)
        || !(row.dueAt === null || (typeof row.dueAt === 'string' && Number.isFinite(Date.parse(row.dueAt))))
        || !Number.isInteger(row.priority) || Number(row.priority) < 0 || Number(row.priority) > 4) {
        throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
      }
      return { ...task, dueAt: row.dueAt as string | null, priority: row.priority as number };
    });
    return { items, hasMore: value.hasMore };
  }

  async searchTasks(query: string, limit: number): Promise<VoyagerTaskProjection[]> {
    const url = new URL(this.options.tasksEndpoint);
    url.searchParams.set('workspaceId', this.options.workspaceId);
    url.searchParams.set('query', requiredBounded(query, 160, 'query'));
    url.searchParams.set('limit', String(normalizedLimit(limit, 20, 50)));
    const value = await this.read(url);
    return projectionItems(value).map(value => normalizedTaskProjection(value as VoyagerTaskProjection));
  }

  async listProjects(limit: number): Promise<VoyagerProjectProjection[]> {
    const url = new URL(this.options.projectsEndpoint);
    url.searchParams.set('workspaceId', this.options.workspaceId);
    url.searchParams.set('limit', String(normalizedLimit(limit, 20, 50)));
    const value = await this.read(url);
    return projectionItems(value).map(value => normalizedProjectProjection(value as VoyagerProjectProjection));
  }

  private async read(url: URL): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(url, {
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'x-syzygy-contract-version': '1.1',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new OrganizeError(timeout ? 'DESTINATION_TIMEOUT' : 'DESTINATION_UNAVAILABLE', 503, true);
    }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof value.error === 'object' && value.error ? value.error as Record<string, unknown> : {};
      throw new OrganizeError(typeof error.code === 'string' ? error.code : 'DESTINATION_UNAVAILABLE', response.status, error.retryable === true);
    }
    if (value.contractVersion !== '1.1' || value.workspaceId !== this.options.workspaceId) {
      throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
    }
    return value;
  }
}

export class DisabledVoyagerTaskDestination implements VoyagerTaskDestination {
  async apply(): Promise<VoyagerTaskReference> { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
}

export class HttpVoyagerTaskDestination implements VoyagerTaskDestination {
  constructor(private readonly options: { endpoint: string; token: string; workspaceId: string; fetcher?: typeof fetch; }) {}
  async apply(session: OrganizeSession, item: OrganizeItem): Promise<VoyagerTaskReference> {
    const isPhaseTwo = item.operation === 'update' || item.projectIds.length > 0;
    if (item.operation === 'update' && !item.target) throw new OrganizeError('TARGET_REQUIRED', 400);
    if (item.operation === 'update' && item.updateFields.length === 0) throw new OrganizeError('UPDATE_FIELDS_REQUIRED', 400);
    if (item.operation === 'update' && item.projectSelectionRequired && item.projectIds.length === 0) {
      throw new OrganizeError('PROJECT_SELECTION_REQUIRED', 400);
    }
    const contractVersion = isPhaseTwo ? '1.1' : '1.0';
    const changes = item.operation === 'update'
      ? {
          ...(item.updateFields.includes('title') ? { title: item.title } : {}),
          ...(item.updateFields.includes('details') ? { details: item.details } : {}),
          ...(item.updateFields.includes('projectIds') ? { projectIds: item.projectIds } : {}),
        }
      : {
          title: item.title,
          ...(isPhaseTwo ? { details: item.details, projectIds: item.projectIds } : item.details ? { details: item.details } : {}),
        };
    const body = {
      contractVersion, requestId: item.requestId, idempotencyKey: item.idempotencyKey,
      workspaceId: this.options.workspaceId, projectId: null,
      source: {
        system: 'shannon', resourceType: 'workSession', resourceId: session.id, title: '会話を整理',
        summary: item.operation === 'update' ? 'ユーザーが確認した既存Taskの更新案' : isPhaseTwo ? 'ユーザーが確認した新規Task案' : 'ユーザーが確認したTask案',
        updatedAt: session.createdAt, href: `shannon://work-sessions/${session.id}`,
      },
      kind: 'voyager.taskChange',
      payload: item.operation === 'update'
        ? {
            operation: 'update', targetTaskId: item.target!.id, expectedRevision: item.target!.revision,
            changes, reason: 'ユーザーが既存Taskへの反映を承認',
          }
        : { operation: 'create', changes },
      provenance: { conversationId: session.threadId, messageIds: session.sourceMessageIds, reason: '整理して' }, createdAt: session.createdAt,
    };
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(this.options.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json; charset=utf-8', 'idempotency-key': item.idempotencyKey, 'x-syzygy-contract-version': contractVersion },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof value.error === 'object' && value.error ? value.error as Record<string, unknown> : {};
      throw new OrganizeError(typeof error.code === 'string' ? error.code : 'DESTINATION_UNAVAILABLE', response.status, error.retryable === true);
    }
    const result = value.result as VoyagerTaskReference | undefined;
    if (!result || result.system !== 'voyager' || result.resourceType !== 'task' || !result.resourceId || !result.title) throw new OrganizeError('DESTINATION_RESPONSE_INVALID', 502);
    return result;
  }
}

export function createConfiguredVoyagerDestination(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): VoyagerTaskDestination {
  const endpoint = environment.SHANNON_VOYAGER_INTEGRATION_URL?.trim();
  const token = environment.SHANNON_VOYAGER_INTEGRATION_TOKEN?.trim();
  const workspaceId = environment.SHANNON_VOYAGER_WORKSPACE_ID?.trim();
  return endpoint && token && workspaceId ? new HttpVoyagerTaskDestination({ endpoint, token, workspaceId }) : new DisabledVoyagerTaskDestination();
}

export function createConfiguredVoyagerCatalog(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): VoyagerCatalog {
  const applyEndpoint = environment.SHANNON_VOYAGER_INTEGRATION_URL?.trim();
  const token = environment.SHANNON_VOYAGER_INTEGRATION_TOKEN?.trim();
  const workspaceId = environment.SHANNON_VOYAGER_WORKSPACE_ID?.trim();
  if (!applyEndpoint || !token || !workspaceId) return new DisabledVoyagerCatalog();
  let tasksEndpoint: string;
  let projectsEndpoint: string;
  let openTasksEndpoint: string;
  try {
    const base = new URL(applyEndpoint);
    const prefix = base.pathname.replace(/\/task-changes:apply$/u, '');
    tasksEndpoint = environment.SHANNON_VOYAGER_TASK_SEARCH_URL?.trim() || new URL(`${prefix}/tasks/search`, base).toString();
    projectsEndpoint = environment.SHANNON_VOYAGER_PROJECTS_URL?.trim() || new URL(`${prefix}/projects`, base).toString();
    openTasksEndpoint = httpUrl(environment.SHANNON_VOYAGER_TASK_OPEN_URL) ?? new URL(`${prefix}/tasks/open`, base).toString();
  } catch { return new DisabledVoyagerCatalog(); }
  const upcomingEndpoint = httpUrl(environment.SHANNON_VOYAGER_TASK_UPCOMING_URL);
  return new HttpVoyagerCatalog({ tasksEndpoint, projectsEndpoint, openTasksEndpoint, token, workspaceId, ...(upcomingEndpoint ? { upcomingEndpoint } : {}) });
}

function httpUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value?.trim() ?? '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}
