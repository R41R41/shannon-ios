import {
  VOICE_WAITING_AFFECTS,
  voiceAffectInstructions,
  type VoiceAffect, type VoiceDecisionInput, type VoiceDelivery,
  type VoiceLatencyClass, type VoiceSkill, type VoiceTurnDecision,
  type VoiceWaitingAffect, type VoiceWaitingDirection, type VoiceWaitingScenario,
  type VoiceWaitingVariant,
} from './contracts/voiceDecisionContract.js';

export const waitingScenarioCriteria: Readonly<Record<VoiceWaitingScenario, string>> = {
  general: 'A useful reply needs a moment, but no more specific category applies.',
  web: 'A current public fact or web lookup other than weather or transit is needed.',
  weather: 'The reply needs current weather or a forecast.',
  transit: 'The reply needs current routes, trains, buses, delays, or service status.',
  aether: 'The reply needs an Aether note or memo, but not Voyager tasks.',
  voyager: 'The reply needs a Voyager task, but not Aether notes.',
  suite: 'The reply needs both Aether notes and Voyager tasks.',
  agent: 'The reply needs the verified status of Codex or agent work.',
  memory: 'The reply needs an earlier owner conversation, promise, or remembered preference.',
  daily_mind: 'The reply needs Shannon’s current daily reflection.',
  time: 'The reply needs the device’s current local time or date.',
  location: 'The reply needs the device’s one-time current location.',
  support: 'The speaker needs careful emotional support, not a task-status claim or a cheerful search acknowledgement.',
  analysis: 'A comparison, explanation, or substantial synthesis needs thought.',
  planning: 'The user asks for a plan, design, or ordered steps.',
  troubleshooting: 'The user asks to diagnose a failure or investigate its cause.',
};

export const jevWaitingQuestions = [
  ['waiting_scenario', {
    type: 'choice',
    instructions: 'Choose the topic of one short pre-answer acknowledgement. It will be spoken only for a turn expected to take at least three seconds. Never imply that a read or external action has already succeeded; guest turns cannot use owner-private categories.',
    criteria: waitingScenarioCriteria,
  }],
  ['waiting_variant', {
    type: 'choice',
    instructions: 'Choose the wording tone for that acknowledgement. Vary naturally with the utterance and recent context.',
    criteria: {
      steady: 'Plain and clear, especially for factual or serious work.',
      warm: 'Close and reassuring without an unnecessary promise.',
      lively: 'Briefly playful or upbeat when the situation permits.',
    },
  }],
  ['waiting_affect', {
    type: 'choice',
    instructions: 'Choose the separate emotional performance for the short acknowledgement, not the eventual answer. Keep it appropriate to the speaker’s situation.',
    criteria: Object.fromEntries(VOICE_WAITING_AFFECTS.map(affect => [affect, voiceAffectInstructions[affect]])),
  }],
  ['waiting_intensity', {
    type: 'choice',
    instructions: 'Choose how audible the acknowledgement emotion should be. Prefer subtle; strong is rare.',
    criteria: {
      subtle: 'A light emotional tint.', moderate: 'Clearly audible but brief emotion.',
      strong: 'Rare clear emotion justified by the moment.',
    },
  }],
  ['waiting_delivery', {
    type: 'choice',
    instructions: 'Choose how to speak the acknowledgement, independently of the eventual answer.',
    criteria: {
      conversational: 'Natural speech.', quick: 'Brief and brisk.', gentle: 'Soft and unhurried.',
      focused: 'Clear and deliberate.', energetic: 'Lively without shouting.',
    },
  }],
] as const;

// Each category has a steady, warm, and lively wording. These are acknowledgements,
// never evidence that an external read or action has already succeeded.
const phrases: Readonly<Record<VoiceWaitingScenario, Readonly<Record<VoiceWaitingVariant, string>>>> = {
  general: {
    steady: '少し確認してみますね。', warm: 'うん、ちょっと確かめますね。', lively: 'よし、さっと見てみますね。',
  },
  web: {
    steady: 'ちょっと最新の情報を調べてみますね。', warm: 'いまの情報を確かめますね。', lively: '新しい情報を見てきますね。',
  },
  weather: {
    steady: 'いまの天気を確認しますね。', warm: '空模様を確かめますね。', lively: '今日の天気、見てみますね。',
  },
  transit: {
    steady: '運行情報を確認しますね。', warm: '移動の状況を確かめますね。', lively: '電車やバスの状況、見てみますね。',
  },
  aether: {
    steady: 'Aetherのノートを確認しますね。', warm: '共有されたノートを見てみますね。', lively: 'Aetherの記録を探してみますね。',
  },
  voyager: {
    steady: 'Voyagerのタスクを確認してみますね。', warm: 'タスクの状況を見てみますね。', lively: 'Voyagerの記録を探してみますね。',
  },
  suite: {
    steady: 'AetherとVoyagerを確認してみますね。', warm: 'ノートとタスクを合わせて見ますね。', lively: '両方の記録を確かめますね。',
  },
  agent: {
    steady: '作業の進み具合を確認してきますね。', warm: '作業の記録を確かめますね。', lively: 'いまの作業状況を見てみますね。',
  },
  memory: {
    steady: '前の話を確認しますね。', warm: 'これまでの話を少し確かめますね。', lively: '前に話した内容を探してみますね。',
  },
  daily_mind: {
    steady: '今日の考えを確かめますね。', warm: '今日の気持ちを少し整理しますね。', lively: '今日のボクの考え、見てみますね。',
  },
  time: {
    steady: 'いまの時刻を確認しますね。', warm: 'こちらの時刻を確かめますね。', lively: '時計を見てみますね。',
  },
  location: {
    steady: '使える位置情報を確認しますね。', warm: '現在地を確かめますね。', lively: 'いまいる場所を見てみますね。',
  },
  support: {
    steady: '少し言葉を選んで答えますね。', warm: 'うん、ちゃんと聞いています。', lively: '大切な話ですね。少し考えます。',
  },
  analysis: {
    steady: '少し整理して答えますね。', warm: '考えをまとめてみますね。', lively: '順番に考えてみますね。',
  },
  planning: {
    steady: '進め方を整理しますね。', warm: 'できる順番を考えますね。', lively: 'まず道筋を組み立てますね。',
  },
  troubleshooting: {
    steady: '原因を切り分けてみますね。', warm: '何が起きたか順に確かめますね。', lively: '手がかりから見ていきますね。',
  },
};

export function fallbackWaitingDirection(
  input: Pick<VoiceDecisionInput, 'transcript'>,
  selectedSkills: readonly VoiceSkill[],
  affect: VoiceAffect,
  intensity: number,
  delivery: VoiceDelivery,
): VoiceWaitingDirection {
  const skills = new Set(selectedSkills);
  const text = input.transcript;
  const scenario: VoiceWaitingScenario = skills.has('aether_notes') && skills.has('voyager_tasks') ? 'suite'
    : skills.has('aether_notes') ? 'aether'
      : skills.has('voyager_tasks') ? 'voyager'
        : skills.has('agent_status') ? 'agent'
          : skills.has('current_web') && /(?:天気|気温|予報|雨|晴)/u.test(text) ? 'weather'
            : skills.has('current_web') && /(?:電車|バス|運行|遅延|乗換|経路)/u.test(text) ? 'transit'
              : skills.has('current_web') ? 'web'
                : skills.has('device_context') && /(?:現在地|場所|近く|周辺)/u.test(text) ? 'location'
                  : skills.has('device_context') ? 'time'
                    : skills.has('conversation_memory') ? 'memory'
                      : skills.has('daily_mind') ? 'daily_mind'
                        : /(?:つらい|悲しい|不安|心配|寂しい|亡くな)/u.test(text) ? 'support'
                          : /(?:原因|不具合|問題|直ら|調査)/u.test(text) ? 'troubleshooting'
                          : /(?:計画|設計|進め方|手順)/u.test(text) ? 'planning'
                            : /(?:比較|分析|整理|考えて)/u.test(text) ? 'analysis' : 'general';
  return {
    scenario, variant: 'steady',
    affect: VOICE_WAITING_AFFECTS.includes(affect as VoiceWaitingAffect) ? affect as VoiceWaitingAffect : 'neutral',
    intensity: Math.min(intensity, 0.6), delivery,
  };
}

export function waitingDirectionFor(decision: VoiceTurnDecision): VoiceWaitingDirection {
  const fallback = fallbackWaitingDirection(
    { transcript: '' }, decision.selectedSkills, decision.affect, decision.affectIntensity, decision.delivery,
  );
  const candidate = decision.waitingDirection;
  if (!candidate) return fallback;
  return scenarioAllowed(candidate.scenario, decision.selectedSkills) ? candidate : {
    ...candidate, scenario: fallback.scenario,
  };
}

export function waitingPhraseFor(
  decision: VoiceTurnDecision,
  direction = waitingDirectionFor(decision),
): string | undefined {
  if (!decision.shouldRespond || !needsWaitingPhrase(decision.latencyClass)) return undefined;
  return phrases[direction.scenario][direction.variant];
}

function needsWaitingPhrase(latency: VoiceLatencyClass): boolean {
  return latency === 'under_10s' || latency === 'over_10s';
}

function scenarioAllowed(scenario: VoiceWaitingScenario, selectedSkills: readonly VoiceSkill[]): boolean {
  const skills = new Set(selectedSkills);
  switch (scenario) {
    case 'suite': return skills.has('aether_notes') && skills.has('voyager_tasks');
    case 'aether': return skills.has('aether_notes');
    case 'voyager': return skills.has('voyager_tasks');
    case 'agent': return skills.has('agent_status');
    case 'memory': return skills.has('conversation_memory');
    case 'daily_mind': return skills.has('daily_mind');
    case 'web': case 'weather': case 'transit': return skills.has('current_web');
    case 'time': case 'location': return skills.has('device_context');
    default: return true;
  }
}
