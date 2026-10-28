import type { CallRecord, DecisionDocument } from './decisionRecordRead.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) ?? 'null';
const fence = (text: string, language = '') => `\`\`\`${language}\n${text.replace(/```/gu, '` ` `')}\n\`\`\``;

interface Block {
  type?: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean;
}
/** A message's content (a string, or blocks) as the text a reader follows. */
function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  const item = block as Block;
  switch (item?.type) {
    case 'text': return String(item.text ?? '');
    case 'thinking': return `(thinking)\n${String(item.thinking ?? '')}`;
    case 'redacted_thinking': return '(redacted thinking)';
    case 'tool_use': return `(tool_use ${item.name} id=${item.id})\n${json(item.input)}`;
    case 'tool_result': return `(tool_result id=${item.tool_use_id}${item.is_error ? ' is_error' : ''})\n${contentText(item.content)}`;
    default: return json(block);
  }
}
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(blockText).join('\n\n') : json(content);
}

function systemText(system: unknown): string {
  const blocks = Array.isArray(system) ? system : [system];
  return blocks.map((block, index) => {
    const marked = (block as { cache_control?: unknown } | null)?.cache_control ? '（キャッシュ境界あり）' : '';
    return `### system ${index + 1}${marked}\n\n${fence(blockText(block))}`;
  }).join('\n\n');
}
function toolsText(tools: unknown): string {
  if (!Array.isArray(tools)) return '（なし）';
  const lines = tools.map(tool => {
    const first = String((tool as { description?: string }).description ?? '').split('\n')[0]?.slice(0, 160) ?? '';
    return `- \`${(tool as { name?: string }).name}\`: ${first}`;
  });
  return `${lines.join('\n')}\n\n<details><summary>tools の定義（JSON）</summary>\n\n${fence(json(tools), 'json')}\n\n</details>`;
}
function messagesText(document: DecisionDocument): string {
  const { messages, omittedMessages } = document.request;
  const head = omittedMessages ? `（古い ${omittedMessages} 件は省いた）\n\n` : '';
  return head + messages.map(message => `#### [${message.index}] ${message.role}\n\n${fence(contentText(message.content))}`).join('\n\n');
}

function responseText(document: DecisionDocument): string {
  const answer = document.response;
  if (!answer) return '応答の記録なし（要求は送ったが、応答も失敗も記録されていない。プロセスが落ちた可能性）。';
  const lines = [`- 結果: **${answer.outcome}**${answer.reason ? `（理由: ${String(answer.reason)}）` : ''}`, `- 時刻: ${answer.at}（要求から ${answer.ms} ms）`,
    `- stop_reason: ${String(answer.stopReason)}`, `- トークン: ${json(answer.tokens)}`, `- 費用（USD）: ${String(answer.costUsd)}`];
  if (answer.error) lines.push(`- エラー: ${json(answer.error)}`);
  if (answer.content) {
    const blocks = Array.isArray(answer.content) ? answer.content.map(block => fence(blockText(block))) : [fence(json(answer.content))];
    lines.push('', '#### 出力（content）', '', ...blocks);
  }
  lines.push('', '<details><summary>応答のメタ情報と usage</summary>', '', fence(json({ meta: answer.meta, usage: answer.usage }), 'json'), '', '</details>');
  return lines.join('\n');
}

function sentText(sent: CallRecord['sent'][number]): string[] {
  const shape = { skill: sent.skill, arguments: sent.arguments, queue: sent.queue, deadlineAt: sent.deadlineAt, connectionId: sent.connectionId,
    context: sent.context };
  return [`- 体へ送った形（コマンド ${sent.commandId}、列 ${sent.queue?.item ?? '-'}）:`, fence(json(shape), 'json')];
}
function callText(call: CallRecord): string {
  const skipped = call.skipped ? '（前の動作の失敗で実行せず）' : '';
  const lines = [`#### 呼び ${call.toolUseId}: \`${call.name}\`${skipped}`, '', '- モデルが書いた入力（応答の tool_use）:', fence(json(call.modelInput), 'json'),
    '- 頭が受け取った入力（検証・変換の後に道具へ渡した形）:', fence(json(call.input), 'json'),
    `- 道具の結果: ${call.result.ok ? '成功' : `失敗（${call.result.failure ?? '-'}）`}（${call.ms} ms）`, fence(call.result.text)];
  if (call.sentToBody) lines.push(...call.sent.flatMap(sentText));
  else if (call.notSentReason !== null) lines.push(`- **体へは送らなかった**。理由（道具の返答）: ${call.notSentReason.slice(0, 400)}`);
  return lines.join('\n');
}

function outcomeText(document: DecisionDocument): string[] {
  if (!document.outcome.length) return ['- 記録なし（採用も破棄も失敗も書かれていない: 途中でプロセスが止まったか、再試行された失敗の要求）。'];
  return document.outcome.map(event => {
    const detail = Object.fromEntries(Object.entries(event).filter(([key]) => !['ev', 'at', 'id'].includes(key)));
    return `- ${event.at}: **${event.ev}** ${json(detail)}`;
  });
}
function headerText(document: DecisionDocument): string[] {
  const { version, request } = document;
  return [`# 判断 ${document.id}（task ${document.taskId}、${document.kind} #${document.no}）`, '', `- 時刻: ${document.requestedAt}`,
    `- step: ${document.stepId}（step 番号 d=${document.stepIndex ?? '-'}、round ${document.round}、試行 ${document.attempt ?? '-'}）`,
    `- operation: ${document.operationId ?? '-'}`, `- モデル: ${String(request.model)}`, `- 設定: ${json(request.config)}`,
    `- ヘッダ（モデルが読む物）: ${json(request.headers)}`, '', '## 版', '',
    fence(json({ head: version.head, body: version.body, prompt: version.prompt, runStartedAt: version.runStartedAt }), 'json')];
}

/** One decision as a markdown page: its input, its answer, what the step did, each call and the act sent to the body, and the versions. */
export function renderDecision(document: DecisionDocument): string {
  return [...headerText(document), '', '## 入力', '', '### system', '', systemText(document.request.system), '', '### tools', '',
    toolsText(document.request.tools), '', '### messages', '', messagesText(document), '', '## 出力', '', responseText(document), '',
    '## 頭がこの判断をどう扱ったか', '', ...outcomeText(document), '', '## 呼びと体へ送った形', '',
    ...(document.calls.length ? document.calls.map(callText) : ['（呼びなし）'])].join('\n');
}
export function renderDecisions(documents: readonly DecisionDocument[]): string { return documents.map(renderDecision).join('\n\n---\n\n'); }
