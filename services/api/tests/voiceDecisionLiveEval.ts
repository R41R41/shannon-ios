import { JevVoiceDecisionGateway } from '../src/voiceDecision.js';
import { voiceDecisionEvaluationCases } from './voiceDecisionEvaluationCases.js';

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) throw new Error('TYPESAFE_API_KEY is required for the live voice-router evaluation');

const gateway = new JevVoiceDecisionGateway({ apiKey, timeoutMilliseconds: 1_200 });
const latencies: number[] = [];
const failures: string[] = [];

for (const testCase of voiceDecisionEvaluationCases) {
  const decision = await gateway.decide({
    scopeKey: `live-eval:${testCase.id}`,
    transcript: testCase.transcript,
    participantMode: 'owner',
    requestedLocation: testCase.expectedSkills.includes('device_context'),
    hasFreshLocation: testCase.expectedSkills.includes('device_context'),
  });
  latencies.push(decision.elapsedMilliseconds);
  const missingSkills = testCase.expectedSkills.filter(skill => !decision.selectedSkills.includes(skill));
  const passed = decision.source === 'jev'
    && decision.shouldRespond === testCase.shouldRespond
    && testCase.expectedClasses.includes(decision.conversationClass)
    && testCase.expectedLatency.includes(decision.latencyClass)
    && missingSkills.length === 0;
  if (!passed) failures.push(testCase.id);
}

latencies.sort((left, right) => left - right);
const percentile = (fraction: number): number => latencies[Math.ceil(latencies.length * fraction) - 1] ?? 0;
const passRate = (voiceDecisionEvaluationCases.length - failures.length) / voiceDecisionEvaluationCases.length;
console.log(JSON.stringify({
  cases: voiceDecisionEvaluationCases.length,
  passRate,
  failedCaseIDs: failures,
  latencyMilliseconds: { p50: percentile(0.5), p95: percentile(0.95), maximum: percentile(1) },
}, null, 2));

if (passRate < 0.8 || percentile(0.95) > 1_200) process.exitCode = 1;
