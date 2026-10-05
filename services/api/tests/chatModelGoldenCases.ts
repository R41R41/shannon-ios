import type { ShannonChatModelRequest } from '../src/chatModel.js';

/** The requests and provider responses that `chatModelGolden.test.ts` holds to their recorded bytes. */
export const GOLDEN_BASE: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: 'system prompt', history: [], message: '聞こえてる？' };
export const GOLDEN_REQUESTS: Record<string, { request: ShannonChatModelRequest; agentHostHint?: string; model?: string }> = {
  plain: { request: GOLDEN_BASE },
  history: { request: { ...GOLDEN_BASE, history: [{ role: 'user', content: 'おはよう' }, { role: 'assistant', content: 'おはようございます。' }],
    priorThreadSummary: '朝の挨拶をした', generateThreadTitle: true } },
  attachments: { request: { ...GOLDEN_BASE, attachments: [{ name: 'notes.md', mimeType: 'text/markdown', text: '# 本文\n"quoted"' }] } },
  webSearch: { request: { ...GOLDEN_BASE, useWebSearch: true } },
  placeSearch: { request: { ...GOLDEN_BASE, useWebSearch: true, placeSearch: { latitude: 34.7, longitude: 137.7 } } },
  placeWithoutLocation: { request: { ...GOLDEN_BASE, placeSearch: {} } },
  host: { request: GOLDEN_BASE, agentHostHint: 'shannon-vm', model: 'gpt-test-1' },
  // Her identity, what she knows of the owner, and the turn's context (`ShannonPromptLayers`), with every block of one turn.
  layered: { request: { ...GOLDEN_BASE, profilePrompt: 'profile prompt', turnContext: 'turn context',
    history: [{ role: 'user', content: 'おはよう' }, { role: 'assistant', content: 'おはようございます。' }], priorThreadSummary: '朝の挨拶をした',
    generateThreadTitle: true, attachments: [{ name: 'notes.md', mimeType: 'text/markdown', text: '本文' }] } },
};

const turn = (extra: Record<string, unknown> = {}) => ({
  reply: '  はい、聞こえています。\n次です。 \n', threadSummary: '挨拶をした', taskDecision: { disposition: 'none', reason: '雑談' },
  taskProposal: null, intentPlan: null, artifacts: null, ...extra,
});
const usage = { input_tokens: 120, output_tokens: 40, total_tokens: 160, input_tokens_details: { cached_tokens: 100 } };
export const GOLDEN_RESPONSES: Record<string, { request?: ShannonChatModelRequest; status?: number; envelope: unknown }> = {
  plain: { envelope: { output_text: JSON.stringify(turn()), usage } },
  outputArray: { envelope: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(turn()) }] }], usage } },
  title: { request: { ...GOLDEN_BASE, generateThreadTitle: true }, envelope: { output_text: JSON.stringify(turn({ threadTitle: '朝の挨拶' })), usage } },
  proposal: { envelope: { output_text: JSON.stringify(turn({ taskDecision: { disposition: 'propose', reason: '依頼' },
    taskProposal: { title: '修正', goal: 'ログインを直す', hostHint: null, projectHint: 'shannon-ios', risk: null },
    intentPlan: { nextStep: '確認する', steps: ['確認する', '直す'] } })), usage } },
  artifacts: { envelope: { output_text: JSON.stringify(turn({ artifacts: [{ name: 'memo.md', mimeType: 'text/markdown', content: '# メモ', summary: null }] })), usage } },
  webSources: { request: { ...GOLDEN_BASE, useWebSearch: true }, envelope: { usage, output: [
    { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/a', title: 'A' }] } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(turn()), annotations: [{ url: 'https://example.com/b' }] }] },
  ] } },
  proposeWithoutProposal: { envelope: { output_text: JSON.stringify(turn({ taskDecision: { disposition: 'propose', reason: '依頼' } })), usage } },
  truncated: { envelope: { output_text: '{"reply":"途中まで', usage, status: 'incomplete' } },
  empty: { envelope: { usage } },
  providerError: { status: 500, envelope: { error: { message: 'upstream failed' } } },
};
