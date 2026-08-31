import type { ShannonEmotion, ShannonTemperament } from './types.js';

export type ShannonExpression =
  | 'joyful'
  | 'excited'
  | 'amused'
  | 'laughing'
  | 'bashful'
  | 'embarrassed'
  | 'relieved'
  | 'surprised'
  | 'curious'
  | 'thinking'
  | 'confused'
  | 'determined'
  | 'tender'
  | 'calm'
  | 'jealous'
  | 'wry'
  | 'exasperated'
  | 'annoyed'
  | 'concerned'
  | 'sad'
  | 'sleepy'
  | 'neutral';

export interface ShannonExpressionContext {
  userMessage?: string;
  shannonReply?: string;
}

export interface ShannonMessageEmotion {
  valence: number;
  arousal: number;
  openness: number;
  expression: ShannonExpression;
}

interface ExpressionCueRule {
  expression: ShannonExpression;
  cues: readonly string[];
}

// Specific anime reactions come first so that, for example, 「照れ笑い」does not
// collapse into generic embarrassment. This remains a fast, local projection and
// never adds another model call to the reply path.
const EXPRESSION_CUE_RULES: readonly ExpressionCueRule[] = [
  { expression: 'jealous', cues: ['嫉妬', 'やきもち', '焼きもち', 'ほかの子', '他の子', '私以外', '誰と話して'] },
  { expression: 'laughing', cues: ['爆笑', '大笑い', '笑い止まら', '腹痛い', '🤣', 'wwwww', 'ｗｗｗｗ'] },
  { expression: 'bashful', cues: ['照れ笑', 'えへへ', '嬉しいけど恥ずか', 'うれしいけど恥ずか', 'そんなこと言われると'] },
  { expression: 'exasperated', cues: ['ジト目', '呆れ', 'あきれ', 'やれやれ', 'また？', 'しょうがない', '困った人'] },
  { expression: 'wry', cues: ['苦笑', '微妙', 'なんとも', '気まず', 'はは…', 'はは……'] },
  { expression: 'thinking', cues: ['考え中', '考えてみる', '考えて', '考える', 'うーん', '整理しよう', '検討しよう', '推理', '思案'] },
  { expression: 'annoyed', cues: ['イライラ', 'いらいら', 'むかつ', 'ムカつ', '腹が立', '腹立', 'うざ', '納得いか', 'ありえない'] },
  { expression: 'embarrassed', cues: ['照れ', '恥ずか', '顔が赤', '赤面'] },
  { expression: 'surprised', cues: ['びっくり', '驚い', 'まさか', 'えっ', 'ええっ', '本当？', 'ほんと？', 'マジ'] },
  { expression: 'relieved', cues: ['ほっと', '安心した', '助かった', '解決した', '大丈夫そう', 'よかった', '良かった'] },
  { expression: 'confused', cues: ['わからない', '分からない', 'どういうこと', '混乱', '困惑', '難しい', 'むずかしい', '謎'] },
  { expression: 'amused', cues: ['面白い', 'おもしろい', '笑った', '笑える', 'ふふ', 'あは', 'ｗｗ', '😂'] },
  { expression: 'determined', cues: ['やるぞ', '頑張', 'がんば', '決めた', '進めよう', 'やろう', '作ろう', '実装しよう', '任せて'] },
  { expression: 'excited', cues: ['わくわく', 'ワクワク', '楽しみ', '待ちきれ', 'やった', '最高', '完成した', '成功した', 'できた'] },
  { expression: 'sleepy', cues: ['眠い', '眠たい', 'ねむい', 'おやすみ', '寝よう', '休もう'] },
  { expression: 'sad', cues: ['悲しい', 'かなしい', 'つらい', '寂しい', 'さみしい', '泣きたい'] },
  { expression: 'concerned', cues: ['不安', '怖い', 'こわい', '心配', '大丈夫？', '無理して'] },
  { expression: 'tender', cues: ['ありがとう', '大切', '好き', 'そばにいる', '寄り添', 'ゆっくりでいい'] },
  { expression: 'curious', cues: ['気になる', '知りたい', 'なぜ', 'どうして', '教えて'] },
];

function cueScore(text: string, cues: readonly string[]): number {
  return cues.reduce((score, cue) => score + (text.includes(cue.toLocaleLowerCase('ja-JP')) ? 1 : 0), 0);
}

function deriveContextualExpression(
  context: ShannonExpressionContext,
  temperament: ShannonTemperament,
): ShannonExpression | null {
  const userMessage = (context.userMessage ?? '').toLocaleLowerCase('ja-JP');
  const shannonReply = (context.shannonReply ?? '').toLocaleLowerCase('ja-JP');
  let winner: { expression: ShannonExpression; score: number } | null = null;

  for (const rule of EXPRESSION_CUE_RULES) {
    const score = cueScore(userMessage, rule.cues) + cueScore(shannonReply, rule.cues) * 1.35;
    if (score > 0 && (!winner || score > winner.score)) {
      winner = { expression: rule.expression, score };
    }
  }

  if (winner) return winner.expression;
  if ((userMessage.includes('?') || userMessage.includes('？')) && temperament.curiosity >= 0.5) {
    return 'curious';
  }
  return null;
}

export function deriveShannonExpression(
  emotion: ShannonEmotion,
  temperament: ShannonTemperament,
  context?: ShannonExpressionContext,
): ShannonExpression {
  const contextual = context ? deriveContextualExpression(context, temperament) : null;
  if (contextual) return contextual;
  if (emotion.valence >= 0.24 && emotion.arousal >= 0.4) return 'joyful';
  if (emotion.valence <= -0.24 && emotion.arousal >= 0.36) return 'concerned';
  if (emotion.valence <= -0.14) return 'sad';
  if (emotion.arousal <= 0.2) return 'sleepy';
  if (emotion.valence >= 0.1 && emotion.openness >= 0.37) return 'tender';
  if (temperament.curiosity >= 0.6 && emotion.arousal >= 0.36) return 'curious';
  if (temperament.calmness >= 0.55 && emotion.arousal <= 0.43) return 'calm';
  return 'neutral';
}

export function createShannonMessageEmotion(
  emotion: ShannonEmotion,
  temperament: ShannonTemperament,
  context?: ShannonExpressionContext,
): ShannonMessageEmotion {
  return {
    ...emotion,
    expression: deriveShannonExpression(emotion, temperament, context),
  };
}
