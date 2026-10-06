import { OpenAIDailyMindModel } from '../src/mind/action/respond/dailyMind.js';

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required for the live daily-mind evaluation');

const usage: unknown[] = [];
const model = new OpenAIDailyMindModel({
  apiKey,
  model: process.env.SHANNON_BACKGROUND_LLM_MODEL?.trim()
    || process.env.SHANNON_LLM_MODEL?.trim()
    || 'gpt-5.6-luna',
  usageStore: {
    backgroundLlmCostUsd: () => 0,
    recordLlmUsage: event => usage.push(event),
  },
});

const result = await model.generate({
  scopeKey: 'live-eval:daily-mind',
  recentInterests: ['AIネイティブな記憶', '人とAIの関係'],
  candidate: {
    id: 'eval-source', sourceId: 'eval', sourceTitle: 'Hacker News',
    title: 'How memory changes the way an agent behaves',
    summary: 'A technical discussion of bounded memory and long-lived agents.',
    url: 'https://example.com/eval', discoveredAt: new Date().toISOString(),
  },
});

const passed = Boolean(result)
  && result!.topic.length <= 120
  && result!.reason.length <= 280
  && result!.openingLine.length <= 280
  && !/(ユーザーは|あなたは.{0,20}(好き|住ん|働い|歳))/u.test(`${result!.topic}\n${result!.reason}\n${result!.openingLine}`)
  && usage.length === 1;

console.log(JSON.stringify({ model: model.constructor.name, passed, result, usageEvents: usage.length }, null, 2));
if (!passed) process.exitCode = 1;
