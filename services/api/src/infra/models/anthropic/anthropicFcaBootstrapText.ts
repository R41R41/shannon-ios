/**
 * mb-llmc v2 (mb-llmc-cand 10, D3 「履歴のノイズ」): the public bootstrap of a new replay epoch as lines a person can read. The shared
 * history code writes it as one JSON text (`{"kind":"fca_public_history","summary":…,"rounds":[…]}`) and every message in it is an escaped JSON string
 * (`"content":"{\"name\":\"mc_act\",\"input\":{…}}"`, a result with its line breaks as `\n`); each round also ends with
 * 「Committed task status after this round: queued. A requested completion is not proof of completion.」, 6 to 8 times the same words.
 * The codec of the mode (`anthropicFcaHistoryCodecV2`) renders the stored text with `readableBootstrap`: a pure function of it, so the same stored
 * text is the same message at every request of an epoch (the cache holds), and the text the history policy measures and stores is unchanged.
 */
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const STATUS = /^Committed task status after this round: (\w+)\. A requested completion is not proof of completion\.$/u;

function summaryLines(summary: Rec): string[] {
  return Object.entries(summary).flatMap(([key, value]) => {
    if (Array.isArray(value)) return value.length ? [`${key}:`, ...value.map(item => `- ${String(item)}`)] : [];
    return value === null || value === undefined || value === '' ? [] : [`${key}: ${String(value)}`];
  });
}
function inputLines(input: unknown): string[] {
  const row = rec(input);
  if (!row) return [JSON.stringify(input)];
  return Object.entries(row).flatMap(([key, value]) => Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [`  ${key}:`, ...value.map(item => `    ${item}`)] : [`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`]);
}
/**
 * GPT's review 2026-10-28 (「結果（成功）」 over a result that only said the act was taken into the queue, and the act then stopped): a result of `mc_act` is told by
 * what it is, 「受付」 (the body's run comes after, in the 「（列の知らせ）」 lines); a failed one was not taken or did not run.
 */
function resultLabel(ok: boolean, call: string): string {
  const act = call === 'mc_act' || call === 'mc.act';
  return ok ? (act ? '受付' : '応答') : (act ? '受け付けられなかった・動いていない' : '失敗');
}
function messageLines(message: Rec, call = ''): string[] {
  const content = typeof message.content === 'string' ? message.content : '';
  if (message.role === 'tool_call') {
    const call = (() => { try { return rec(JSON.parse(content)); } catch { return null; } })();
    return call ? [`呼び出し ${String(call.name)}`, ...inputLines(call.input)] : [`呼び出し ${content}`];
  }
  if (message.role === 'tool_result') {
    const result = (() => { try { return rec(JSON.parse(content)); } catch { return null; } })();
    return result && typeof result.result === 'string' ? [`結果（${resultLabel(result.ok !== false, call)}）:`, result.result] : [`結果: ${content}`];
  }
  return [`（${String(message.role)}）${content}`];
}

/** The readable text of a stored bootstrap, or null when the text is not one (the caller keeps it as it is). */
export function readableBootstrap(text: string): string | null {
  let value: Rec | null;
  try { value = rec(JSON.parse(text)); } catch { return null; }
  if (!value || value.kind !== 'fca_public_history' || !Array.isArray(value.rounds)) return null;
  const summary = rec(value.summary);
  const statuses: string[] = [];
  const rounds = value.rounds.map(item => {
    const round = rec(item) ?? {};
    let call = '';
    const messages = (Array.isArray(round.messages) ? round.messages : []).flatMap(entry => {
      const message = rec(entry);
      if (!message) return [];
      const status = typeof message.content === 'string' ? STATUS.exec(message.content)?.[1] : undefined;
      if (status) {
        statuses.push(status);
        return [];
      }
      if (message.role === 'tool_call') call = (() => { try { return String(rec(JSON.parse(String(message.content)))?.name ?? ''); } catch { return ''; } })();
      return [messageLines(message, call).join('\n')];
    });
    return [`### 判断 ${String(round.sequence ?? '?')}`, ...messages].join('\n');
  });
  const same = new Set(statuses).size <= 1;
  return ['# これまでの経過（古い所は要約、新しい所は記録のまま）',
    ...summary ? ['## 要約', ...summaryLines(summary)] : [],
    ...value.omittedRounds ? [`（古い ${String(value.omittedRounds)} 判断分は略）`] : [],
    '## 直近の記録（古い順）',
    ...statuses.length ? [`各判断の後の課題の状態: ${same ? statuses[0] : [...new Set(statuses)].join('・')}。完了の要求だけでは完了の証明にならない。`] : [],
    ...rounds].join('\n');
}
