/**
 * The turns of the stage-2 switched-off proof (`stage2SwitchedOff.test.ts`). Each scenario runs on a fresh kernel; a text turn
 * is `POST /v1/chat`, a voice turn the body's delegation. Never change a scenario of `v1`: its digests were recorded on ca7cf519.
 */
export interface SwitchedOffTurn { kind: 'text' | 'voice'; words: string; extra: Record<string, unknown> }
export interface SwitchedOffScenario { name: string; turns: readonly SwitchedOffTurn[]; toolRound?: true }

const text = (words: string, extra: Record<string, unknown> = {}): SwitchedOffTurn => ({ kind: 'text', words, extra });
const voice = (words: string, extra: Record<string, unknown> = {}): SwitchedOffTurn => ({ kind: 'voice', words, extra });

export const stage2SwitchedOffScenarios: readonly SwitchedOffScenario[] = Object.freeze([
  { name: 'text-tools', turns: [text('書斎の下書き、どうなってる？')] },
  { name: 'text-schedule', turns: [text('今日の予定は？')] },
  { name: 'text-tasks', turns: [text('Voyagerのタスク「買い物」はどうなってる？')] },
  { name: 'text-notion', turns: [text('Notionの設定資料を見せて')] },
  { name: 'text-web', turns: [text('今日の天気を調べて', { webSearch: true })] },
  { name: 'text-others', turns: [text('書斎の下書き、どうなってる？', { audience: 'others' })] },
  { name: 'text-two-turns', turns: [text('こんにちは'), text('さっきの話の続きをしよう')] },
  { name: 'tool-round', turns: [text('書斎に何がある？')], toolRound: true },
  { name: 'voice-greeting', turns: [voice('おはよう、今日は寒いね')] },
  { name: 'voice-tools', turns: [voice('書斎のメモを読んで')] },
  { name: 'voice-schedule', turns: [voice('今日の予定ある？')] },
  { name: 'voice-companion', turns: [voice('書斎のメモを読んで', { companionPresent: true })] },
]);
