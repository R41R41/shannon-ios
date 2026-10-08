import { createConfiguredVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { settleOwnerVoiceTurn } from '../src/mind/attention/voiceSilence.js';
import { ownerCallFacts, voiceDecisionEvaluationCases } from './voiceDecisionEvaluationCases.js';

const skillThreshold = Number(process.env.SHANNON_VOICE_SKILL_THRESHOLD ?? '0.85');
if (!Number.isFinite(skillThreshold) || skillThreshold < 0 || skillThreshold > 1) {
  throw new Error('SHANNON_VOICE_SKILL_THRESHOLD must be between 0 and 1');
}

const gateway = createConfiguredVoiceDecisionGateway({ ...process.env, SHANNON_JEV_TIMEOUT_MS: process.env.SHANNON_JEV_TIMEOUT_MS ?? '1200' });
if (gateway.mode === 'fallback') throw new Error('A configured Jev or small-model provider credential is required for the live voice-router evaluation');
const latencies: number[] = [];
const failures: string[] = [];
const failureDetails: Array<{
  id: string;
  source: string;
  shouldRespond: boolean;
  conversationClass: string;
  latencyClass: string;
  selectedSkills: readonly string[];
  missingSkills: readonly string[];
  unexpectedSkills: readonly string[];
  skillScores: Readonly<Record<string, number>>;
  checks: Readonly<Record<string, boolean>>;
}> = [];

for (const testCase of voiceDecisionEvaluationCases) {
  // The facts of the moment as the owner call sends them, and the router's answer settled against the local rules as in a real turn.
  const turn = { ...ownerCallFacts, ...testCase.turn };
  const decision = settleOwnerVoiceTurn(await gateway.decide({
    scopeKey: `live-eval:${testCase.id}`,
    transcript: testCase.transcript,
    participantMode: 'owner',
    requestedLocation: testCase.expectedSkills.includes('device_context'),
    hasFreshLocation: testCase.expectedSkills.includes('device_context'),
    turn, context: turn.shannonLastLine ? [{ role: 'assistant', content: turn.shannonLastLine }] : [],
  }), { transcript: testCase.transcript, facts: turn, uncertain: false });
  latencies.push(decision.elapsedMilliseconds);
  const missingSkills = testCase.expectedSkills.filter(skill => !decision.selectedSkills.includes(skill));
  const unexpectedSkills = decision.selectedSkills.filter(skill => !testCase.expectedSkills.includes(skill));
  const checks = {
    source: decision.source === gateway.mode,
    response: decision.shouldRespond === testCase.shouldRespond,
    conversationClass: testCase.expectedClasses.includes(decision.conversationClass),
    latencyClass: testCase.expectedLatency.includes(decision.latencyClass),
    skills: missingSkills.length === 0 && unexpectedSkills.length === 0,
  };
  const passed = Object.values(checks).every(Boolean);
  if (!passed) {
    failures.push(testCase.id);
    failureDetails.push({
      id: testCase.id,
      source: decision.source,
      shouldRespond: decision.shouldRespond,
      conversationClass: decision.conversationClass,
      latencyClass: decision.latencyClass,
      selectedSkills: decision.selectedSkills,
      missingSkills,
      unexpectedSkills,
      skillScores: decision.skillScores,
      checks,
    });
  }
}

latencies.sort((left, right) => left - right);
const percentile = (fraction: number): number => latencies[Math.ceil(latencies.length * fraction) - 1] ?? 0;
const passRate = (voiceDecisionEvaluationCases.length - failures.length) / voiceDecisionEvaluationCases.length;
console.log(JSON.stringify({
  cases: voiceDecisionEvaluationCases.length,
  provider: gateway.mode, model: gateway.model,
  skillThreshold,
  passRate,
  failedCaseIDs: failures,
  failureDetails,
  latencyMilliseconds: { p50: percentile(0.5), p95: percentile(0.95), maximum: percentile(1) },
}, null, 2));

if (passRate < 0.8 || percentile(0.95) > 1_200) process.exitCode = 1;
