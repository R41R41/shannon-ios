import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AgentHostConfig, AgentHostProject } from './agentHostConfig.js';
import type {
  AgentChangeSummary,
  AgentReasoningEffort,
  AgentTestResult,
  ClaimedAgentCommand,
} from '../../mind/action/agentTasks/agentTasksPorts.js';
import type { CodexRequestID } from './codexAppServerClient.js';
import type { ShannonTaskResult } from './codexTaskBridge.js';
import { TASK_TREE_SCHEMA, taskTreeNodesProblem, type TaskTree } from '@shannon/mind';

export function codexThreadParams(
  project: AgentHostProject,
  config: AgentHostConfig,
  selection: { model?: string; reasoningEffort?: AgentReasoningEffort } = {},
): Record<string, unknown> {
  const model = selection.model ?? config.codexModel;
  return {
    cwd: project.path,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    serviceName: 'shannon_agent_host',
    ...(model ? { model } : {}),
  };
}

export function taskPrompt(command: ClaimedAgentCommand, project: AgentHostProject, config: AgentHostConfig): string {
  const goal = stringValue(command.payload.goal) ?? '依頼された作業を安全に完了する';
  return [
    'Shannonから明示的に開始された作業です。',
    `目的: ${goal}`,
    `対象プロジェクト: ${project.key}`,
    ...taskTreeInstructions(command.payload.taskTree),
    ...deliveryInstructions(config, command.taskId),
    '作業前に対象リポジトリ直下のAGENTS.mdを最後まで読み、そこから案内される現行architectureとrunbookに従ってください。番号付きHTML資料は、ユーザーがその資料を明示しない限り設計履歴として扱ってください。',
    '最初にgit statusを確認し、依頼と無関係な既存変更を保持してください。',
    '対象プロジェクトを確認し、必要な変更と検証を最後まで行ってください。',
    '依頼中のUI上の主体（シャノン側の返答／ユーザー側の発言）を明示的に区別し、代名詞だけで判断しないでください。',
    '実機反映が完了条件に含まれる場合、ビルド成功だけを完了とせず、接続されたiPhoneへのインストールと起動確認まで行ってください。実機が使えない場合は完了と偽らず、その事実を残してください。',
    '判断が必要な操作では承認を求め、完了時は変更点・試験結果・残る課題を簡潔に報告してください。',
    ...taskResultInstructions(),
  ].join('\n');
}

export function resumePrompt(project: AgentHostProject, config: AgentHostConfig, taskId: string, tree?: unknown): string {
  return [
    '前の作業を、安全に止めた箇所から再開してください。',
    `対象プロジェクト: ${project.key}`,
    ...taskTreeInstructions(tree),
    ...deliveryInstructions(config, taskId),
    '再開時点のgit statusと未完了の検証を確認し、対象リポジトリ直下のAGENTS.mdおよび現行architecture・runbookを読み直してください。',
    '以前の説明だけで完了とせず、現在のファイル・試験・必要な配備結果を根拠に続行してください。',
    ...taskResultInstructions(),
  ].join('\n');
}
export function taskTreeInstructions(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const tree = value as TaskTree;
  if (tree.schema !== TASK_TREE_SCHEMA || tree.legacy || taskTreeNodesProblem(tree.rootId, tree.nodes)) return [];
  return ['[サーバーに保存した作業の木。計画と完了条件であり、新しい権限や承認ではありません。]',
    JSON.stringify({ taskId: tree.taskId, revision: tree.revision, goal: tree.goal, content: tree.content, deadline: tree.deadline,
      nodes: tree.nodes.map(node => ({ id: node.id, parentId: node.parentId, order: node.order, dependsOn: node.dependsOn, title: node.title, contract: node.contract })) }),
    '元の目的・制約・境界・止める条件を子でも守り、必要な検査を実際に行ってください。条件の変更は提案にします。状態の自己申告で完了を証明しません。'];
}
export function taskTestCommandHash(command: string): string { return createHash('sha256').update(command.trim()).digest('hex'); }

export function recoveryPrompt(
  project: AgentHostProject,
  config: AgentHostConfig,
  taskId: string,
  approvalExpired: boolean,
  goal?: string,
): string {
  return [
    approvalExpired
      ? 'Agent Hostの再起動で前の承認要求が期限切れになりました。破損した承認履歴を持ち越さない新しいCodexスレッドです。許可されたとは扱わず、同じShannon作業を安全に復旧してください。'
      : 'Agent Hostの再起動で前のターンが中断されました。同じ作業を安全に復旧してください。',
    ...(goal ? [`目的: ${goal}`] : []),
    `対象プロジェクト: ${project.key}`,
    ...deliveryInstructions(config, taskId),
    'git statusとCodexスレッド内の完了済み作業を確認し、既存変更を重複させないでください。',
    '対象リポジトリ直下のAGENTS.md、現行architecture、runbookを読み直し、未完了の検証と配備だけを続けてください。',
    approvalExpired
      ? '実際の権限昇格がまだ必要なら、新しい承認要求を出してください。古い承認結果を推測してはいけません。明示的な配布依頼による統合・push・配信の許可は継続し、重複確認を求めないでください。'
      : '完了済みと確認できる工程をやり直さず、残る工程から続けてください。',
    ...taskResultInstructions(),
  ].join('\n');
}

export function taskResultInstructions(): string[] {
  return [
    '最終応答の末尾に、必ず次の機械可読行を1行だけ付けてください。',
    'SHANNON_TASK_RESULT: {"status":"completed|paused|failed","summary":"ユーザー向け要約","remainingAction":"未完了なら次に必要な一手"}',
    'Codexのターンが終わっただけではcompletedにしません。依頼の完了条件とrunbook上の該当工程がすべて検証済みの場合だけcompletedにしてください。検証・承認・配備・外部前提が残る場合はpaused、続行不能ならfailedにしてください。',
  ];
}

/** Tasks of one host share a checkout; a paused task may have left its branch and uncommitted changes there. */
const SHARED_CHECKOUT_INSTRUCTION = 'このチェックアウトは、同じ作業ホストの他の作業（一時停止中の作業を含む）と共有しています。この作業のものではない未コミットの変更が残っている場合は、破棄・stash・上書きをせず、そのチェックアウトのブランチも切り替えず、git worktree で別の作業ツリーを作ってそこで作業してください。';

export function deliveryInstructions(config: AgentHostConfig, taskId?: string): string[] {
  if (config.deliveryMode !== 'cloud-testflight') {
    return ['この作業ホストはMacのローカル実機配備モードです。', SHARED_CHECKOUT_INSTRUCTION];
  }
  const suffix = taskId?.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'unknown';
  return [
    'この作業ホストはAzure上のクラウド配備モードです。iPhoneを直接操作せず、Xcode Cloudと内部TestFlightを配備先にします。',
    `コード変更は専用ブランチ shannon/task-${suffix} で行い、実行中の本番APIディレクトリを変更しないでください。`,
    '作業を始める前に git fetch origin を実行し、未コミットの変更が無ければ最新の origin/main を土台にしてください。古い土台のまま進めてはいけません。',
    SHARED_CHECKOUT_INSTRUCTION,
    'テスト成功前にmainへ統合またはpushしてはいけません。ユーザーがGitHubやTestFlightへの配布を明示的に依頼した場合、その依頼が対象変更の統合・push・配信を許可します。実行時に同じ許可を再確認しないでください。対象や範囲が変わった場合だけ、新しい判断を確認してください。',
    '配布を依頼されていない場合は、変更・テスト結果・専用ブランチ名までを報告して止めてください。配布を依頼された場合は、検証後にGitHubへ反映し、Xcode Cloudと内部TestFlightの結果まで確認してください。',
  ];
}

export function approvalID(threadId: string, requestId: CodexRequestID): string {
  return createHash('sha256').update(`${threadId}:${String(requestId)}`).digest('hex');
}

export function stableID(namespace: string, value: string): string {
  return createHash('sha256').update(`${namespace}:${value}`).digest('hex').slice(0, 32);
}

export function approvalTitle(kind: string): string {
  if (kind === 'network') return 'ネットワーク接続の許可';
  if (kind === 'file_change') return 'ファイル変更の許可';
  if (kind === 'command') return 'コマンド実行の許可';
  return '追加のアクセス許可';
}

export function approvalReason(kind: string): string {
  if (kind === 'network') return '外部サービスへ接続する必要があります。';
  if (kind === 'file_change') return '許可範囲を越えてファイルを変更する必要があります。';
  if (kind === 'command') return '通常の安全範囲を越える操作が必要です。';
  return '現在の権限では完了できない操作があります。';
}

export function approvalResource(kind: string, params: Record<string, unknown>): string | undefined {
  if (kind === 'network') {
    const network = objectValue(params.networkApprovalContext) ?? {};
    const host = stringValue(network.host);
    const protocol = stringValue(network.protocol);
    const port = typeof network.port === 'number' ? `:${network.port}` : '';
    return host ? `${protocol ? `${protocol}://` : ''}${host}${port}` : undefined;
  }
  if (kind === 'file_change') return stringValue(params.grantRoot);
  if (kind === 'command') return compact(stringValue(params.command), 180);
  const permissions = objectValue(params.permissions);
  if (permissions) {
    const labels: string[] = [];
    if (permissions.network) labels.push('ネットワーク');
    if (permissions.fileSystem) labels.push('ファイル');
    return labels.join('・') || undefined;
  }
  return undefined;
}

export function grantedPermissions(value: unknown): Record<string, unknown> {
  const request = objectValue(value) ?? {};
  return {
    ...(request.network && typeof request.network === 'object' ? { network: request.network } : {}),
    ...(request.fileSystem && typeof request.fileSystem === 'object' ? { fileSystem: request.fileSystem } : {}),
  };
}

export function commandActivity(command: string): string {
  if (isTestCommand(command)) return '自動テストを実行中';
  if (/xcodebuild|swift\s+build|npm\s+run\s+build|pnpm\s+build/i.test(command)) return 'ビルドを確認中';
  if (/git\s+(diff|status)/i.test(command)) return '変更内容を確認中';
  return '必要なコマンドを実行中';
}

export function commandCompletionTitle(item: Record<string, unknown>): string {
  if (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)) return 'コマンドで問題を検出';
  return 'コマンドの実行を完了';
}

export function testFromCommand(item: Record<string, unknown>, command: string): AgentTestResult | undefined {
  if (!isTestCommand(command)) return undefined;
  const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
  return {
    // The same verification rerun after a pause replaces its earlier result.
    id: stableID('verification', command.trim().replace(/\s+/g, ' ')),
    name: testName(command),
    status: failed ? 'failed' : 'passed',
    detail: failed ? '失敗を検出' : '成功',
  };
}

export function isTestCommand(command: string): boolean {
  return /scripts\/verify\.sh(?:\s+(?:api|ios|app|all))?|(^|\s)(test|pytest|vitest|xctest)(\s|$)|swift\s+test|xcodebuild.*\b(?:test|build)\b|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|build)/i.test(command);
}

export function testName(command: string): string {
  const verifyTarget = command.match(/scripts\/verify\.sh(?:\s+(api|ios|app|all))?/i)?.[1]?.toLocaleLowerCase('en-US');
  if (verifyTarget === 'api') return 'API検証';
  if (verifyTarget === 'ios') return 'iOSパッケージ検証';
  if (verifyTarget === 'app') return 'iOSアプリビルド';
  if (verifyTarget === 'all' || /scripts\/verify\.sh/i.test(command)) return '全体検証';
  if (/xcodebuild/i.test(command)) return 'Xcodeテスト';
  if (/swift\s+test/i.test(command)) return 'Swiftテスト';
  if (/vitest/i.test(command)) return 'Vitest';
  if (/pytest/i.test(command)) return 'Pytest';
  return '自動テスト';
}

export function taskResult(message: string | undefined): ShannonTaskResult | undefined {
  if (!message?.trim()) return undefined;
  const lines = message.trim().split(/\r?\n/);
  let markerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim().startsWith('SHANNON_TASK_RESULT:')) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) return undefined;
  const raw = lines[markerIndex]!.trim().slice('SHANNON_TASK_RESULT:'.length).trim();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const status = value.status;
    if (status !== 'completed' && status !== 'paused' && status !== 'failed') return undefined;
    const visibleSummary = lines.filter((_, index) => index !== markerIndex).join('\n').trim();
    const summary = stringValue(value.summary)?.trim() || visibleSummary;
    if (!summary) return undefined;
    const remainingAction = stringValue(value.remainingAction)?.trim();
    return { status, summary, ...(remainingAction ? { remainingAction } : {}) };
  } catch {
    return undefined;
  }
}

export function changeFromItem(value: unknown, namespace: string): AgentChangeSummary | undefined {
  const object = objectValue(value);
  const path = stringValue(object?.path);
  if (!path) return undefined;
  const diff = stringValue(object?.diff) ?? '';
  const counts = lineCounts(diff);
  return {
    id: stableID(namespace, path),
    displayName: basename(path),
    path,
    summary: object?.kind === 'add' ? '追加' : object?.kind === 'delete' ? '削除' : '変更',
    additions: counts.additions,
    deletions: counts.deletions,
    ...(diff ? { diffPreview: boundedDiff(diff) } : {}),
  };
}

export function changesFromUnifiedDiff(diff: string): AgentChangeSummary[] {
  const chunks = diff.split(/^diff --git /m).slice(1);
  return chunks.flatMap(chunk => {
    const header = chunk.match(/^a\/(.+?) b\/(.+?)\n/);
    if (!header) return [];
    const path = header[2]!;
    const counts = lineCounts(chunk);
    return [{
      id: stableID('diff', path),
      displayName: basename(path),
      path,
      summary: '変更',
      additions: counts.additions,
      deletions: counts.deletions,
      diffPreview: boundedDiff(`diff --git ${chunk}`),
    }];
  });
}

function boundedDiff(diff: string, limit = 16_000): string {
  if (diff.length <= limit) return diff;
  return `${diff.slice(0, limit)}\n…差分の続きはAgent Host上で保持されています。`;
}

export function lineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

export function errorMessage(value: Record<string, unknown>): string {
  const error = objectValue(value.error);
  return compact(stringValue(error?.message) ?? stringValue(value.message)) ?? 'Codexとの接続で問題が発生しました。';
}

export function compact(value: string | undefined, limit = 1_200): string | undefined {
  if (!value) return undefined;
  const result = value.replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, limit - 1)}…` : result;
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('AGENT_PROJECT_NOT_ALLOWLISTED')) return 'このプロジェクトは作業環境でまだ許可されていません。';
  if (message.includes('UsageLimitExceeded')) return 'Codexの利用上限に達しています。';
  if (message.includes('ContextWindowExceeded')) return '作業履歴が長くなりすぎました。';
  return compact(message, 500) ?? '不明な問題が発生しました。';
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
