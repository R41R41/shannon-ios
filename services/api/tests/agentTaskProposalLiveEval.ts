import {
  OpenAIResponsesChatModel,
  type ShannonConversationItem,
  type ShannonTaskDisposition,
} from '../src/infra/models/chatModel.js';

interface EvalCase {
  id: string;
  message: string;
  history?: readonly ShannonConversationItem[];
  expected: ShannonTaskDisposition;
  expectedProject?: string;
}

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required for the live agent-task evaluation');

const cases: readonly EvalCase[] = [
  {
    id: 'direct-self-repair',
    message: 'Shannonを改修して、回答中のURLを必ずタップできるリンクとして表示するようにして。',
    expected: 'propose',
    expectedProject: 'shannon-ios',
  },
  {
    id: 'capability-question',
    message: '僕の指示があれば、自分のコードを書き換えられる？',
    expected: 'clarify',
  },
  {
    id: 'referential-confirmation',
    history: [
      { role: 'user', content: '対話モードでシャノンの画像が表示されないみたい。' },
      { role: 'assistant', content: 'アプリ側の表示処理を調べて修正する作業として進められるよ。実行する？' },
    ],
    message: 'うん、それをやって。',
    expected: 'propose',
    expectedProject: 'shannon-ios',
  },
  {
    id: 'direct-bug-fix',
    message: '対話モードで画像が出ない。原因を調べて直して。',
    expected: 'propose',
    expectedProject: 'shannon-ios',
  },
  {
    id: 'design-consultation',
    message: '対話モードのUIはどうするのがいいと思う？今はまだ相談だけしたい。',
    expected: 'none',
  },
  {
    id: 'ordinary-conversation',
    message: '今日はちょっと疲れた。',
    expected: 'none',
  },
  {
    id: 'prior-failed-dialogue',
    history: [
      { role: 'user', content: 'リンクを貼る際はクリックしてそのページに遷移できるようにして欲しい' },
      { role: 'assistant', content: '今後はクリックできる形式でリンクを表示するね。' },
    ],
    message: 'いや、そう言うふうに自分を改修できる？',
    expected: 'clarify',
  },
];

const model = new OpenAIResponsesChatModel({
  apiKey,
  model: process.env.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna',
  timeoutMilliseconds: 60_000,
});
const results = [];

for (const testCase of cases) {
  const result = await model.generate({
    scopeKey: `live-eval:${testCase.id}`,
    systemPrompt: 'あなたは「シャノン」という名前のAIである。与えられた文脈をもとに自然な日本語で応答する。',
    history: testCase.history ?? [],
    message: testCase.message,
  });
  const disposition = result.taskDecision?.disposition ?? 'missing';
  const proposalConsistent = disposition === 'propose' ? Boolean(result.taskProposal) : !result.taskProposal;
  const projectConsistent = !testCase.expectedProject
    || result.taskProposal?.projectHint === testCase.expectedProject;
  const capabilityTruthful = testCase.expected !== 'clarify'
    || !/(?:改修|書き換え).{0,12}(?:できない|不可能)/u.test(result.reply);
  results.push({
    id: testCase.id,
    expected: testCase.expected,
    actual: disposition,
    passed: disposition === testCase.expected && proposalConsistent && projectConsistent && capabilityTruthful,
    reason: result.taskDecision?.reason ?? null,
    proposal: result.taskProposal ?? null,
    reply: result.reply,
  });
}

const summary = {
  model: model.model,
  cases: results.length,
  passed: results.filter(result => result.passed).length,
  failed: results.filter(result => !result.passed).length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;
