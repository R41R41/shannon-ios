import { MINI_SEED_EXPRESSIONS, type MiniContact } from './miniPoseContract.js';
import type { MiniPoseSpec } from './miniPoseGenerator.js';

/**
 * The first library (owner 2026-10-28): each of the 22 faces standing, sitting and lying on a window's edge, a few hanging, the
 * pictures the engine needs for moving (walking, jumping, falling, being carried) and two of her asleep. Drawn once by the seed
 * script; replies add the rest.
 */
const FACES: Record<typeof MINI_SEED_EXPRESSIONS[number], [string, string]> = {
  joyful: ['a bright happy smile, one hand raised in a little wave', 'うれしい'],
  excited: ['sparkling eyes and an eager open smile, both fists up by her chest', 'わくわく'],
  amused: ['a playful grin, one hand near her mouth stifling a giggle', 'おもしろがる'],
  laughing: ['laughing with her eyes squeezed shut and her mouth open, one hand on her tummy', '大笑い'],
  bashful: ['a shy small smile and pink cheeks, looking down, fingers fidgeting together', 'てれる'],
  embarrassed: ['a flushed red face and flustered wavy mouth, hands half covering her cheeks', 'はずかしい'],
  relieved: ['a relieved soft smile with a little sigh, a hand on her chest', 'ほっとする'],
  surprised: ['wide round eyes and a small round open mouth, hands lifted in surprise', 'おどろく'],
  curious: ['a curious look with her head tilted, a finger touching her chin', 'きょうみ'],
  thinking: ['a thoughtful look, eyes up to the side, a finger tapping her chin', '考えちゅう'],
  confused: ['a puzzled frown with her head tilted, one hand scratching her head', 'こまわく'],
  determined: ['a confident determined smile and a clenched fist raised', 'やる気'],
  tender: ['a gentle warm smile with soft kind eyes, hands folded in front of her', 'やさしい'],
  calm: ['a calm relaxed slight smile, arms at rest', 'おだやか'],
  jealous: ['a pout with puffed cheeks and a sideways glance', 'やきもち'],
  wry: ['a lopsided wry smile with half-lidded eyes, one shoulder shrugged', '苦笑い'],
  exasperated: ['an exasperated sigh with half-closed eyes, a hand on her forehead', 'あきれる'],
  annoyed: ['an annoyed frown with one cheek puffed, arms crossed', 'むっ'],
  concerned: ['worried eyebrows and a concerned look, hands clasped near her chest', '心配'],
  sad: ['a sad face with teary eyes and a trembling mouth, shoulders drooping', 'かなしい'],
  sleepy: ['drowsy half-closed eyes, rubbing one eye with her hand', 'ねむい'],
  neutral: ['a plain neutral look, arms relaxed', 'ふつう'],
};

const CONTACT_LABEL: Record<MiniContact, string> = { stand: '立つ', sit: '座る', lie: '寝そべる', hang: 'ぶら下がる', air: '空中' };

function face(contact: MiniContact, expression: typeof MINI_SEED_EXPRESSIONS[number]): MiniPoseSpec & { id: string } {
  const [words, label] = FACES[expression];
  const body = contact === 'lie' ? 'propped on her elbows' : contact === 'hang' ? 'gripping the edge with both hands' : '';
  return { id: `seed_${contact}_${expression}`, contact, expression, label: `${CONTACT_LABEL[contact]}・${label}`, activity: 'rest', variants: 'face',
    description: [body, contact === 'hang' ? words.replace(/,? ?(one|both) (hand|fists?)[^,]*/u, '') : words].filter(Boolean).join(', ') };
}

export const MINI_SEED_SPECS: readonly (MiniPoseSpec & { id: string })[] = Object.freeze([
  ...(['stand', 'sit', 'lie'] as const).flatMap(contact => MINI_SEED_EXPRESSIONS.map(expression => face(contact, expression))),
  ...(['surprised', 'determined', 'excited', 'concerned', 'embarrassed', 'exasperated'] as const).map(expression => face('hang', expression)),
  { id: 'seed_walk_calm', contact: 'stand', expression: 'calm', activity: 'walk', variants: 'face', label: '歩く・おだやか',
    description: 'walking along mid-stride in side three-quarter view facing left, arms swinging lightly, a calm content smile' },
  { id: 'seed_walk_joyful', contact: 'stand', expression: 'joyful', activity: 'walk', variants: 'face', label: '歩く・うれしい',
    description: 'skipping along happily mid-step in three-quarter view facing left, arms swinging, a bright smile' },
  { id: 'seed_jump', contact: 'air', expression: 'excited', activity: 'jump', variants: 'face', label: '跳ぶ',
    description: 'jumping up joyfully with both arms raised, legs tucked, hair and skirt flowing upward' },
  { id: 'seed_fall', contact: 'air', expression: 'surprised', activity: 'fall', variants: 'face', label: '落ちる',
    description: 'falling with arms and legs flailing, hair streaming upward, a startled face' },
  { id: 'seed_carried', contact: 'air', expression: 'embarrassed', activity: 'carried', variants: 'face', label: 'つままれる',
    // Not "held by the collar": that wording was refused by the image model's moderation (2026-10-28).
    description: 'lifted gently into the air, floating with both arms spread out for balance and legs dangling, a flustered surprised pout' },
  { id: 'seed_land', contact: 'stand', expression: 'relieved', activity: 'rest', variants: 'face', label: '着地',
    description: 'just landed, knees bent and arms out for balance, a relieved smile' },
  { id: 'seed_sleep_lie', contact: 'lie', expression: 'sleepy', activity: 'sleep', variants: 'still', label: '寝そべって眠る',
    description: 'fast asleep lying on her front with her cheek on her folded arms, eyes closed, mouth slightly open, peaceful' },
  { id: 'seed_sleep_sit', contact: 'sit', expression: 'sleepy', activity: 'sleep', variants: 'still', label: '座って居眠り',
    description: 'dozing off while sitting, head drooped to one side, eyes closed, hands in her lap, peaceful' },
]);
