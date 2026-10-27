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

const CONTACT_LABEL: Record<MiniContact, string> = { stand: '立つ', sit: '座る', lie: '寝そべる', hang: 'ぶら下がる', air: '空中', wall: '登る' };

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
  // Held by the owner's cursor: the hold is the anchor, so she hangs from wherever she was picked up. "Do not draw the hand": the
  // cursor is the hand. Gentle wording: "held by the collar like a kitten" was refused by the image model's moderation.
  ...([
    ['arm', 'held up by one wrist so she dangles below her raised arm, her other arm and both legs hanging down, her long hair hanging straight down, a flustered pout', 'ぶら下げ・腕'],
    ['leg', 'held up upside down by one ankle so she dangles head down below her raised leg, both hands holding her skirt in place, her long hair hanging straight down toward the ground, an embarrassed angry face', 'ぶら下げ・脚'],
    ['head', 'held up by the top of her head so she dangles straight down below it, arms and legs limp, her long hair hanging down, a sulky face', 'ぶら下げ・頭'],
    ['scruff', 'held up by the back of her blouse at the nape so she dangles below it like a lifted cat, arms and legs limp, her long hair hanging down, a resigned pout', 'ぶら下げ・首根っこ'],
    ['torso', 'held up around her middle so her upper body droops forward on one side and her legs dangle on the other, arms and long hair hanging down, a surprised face', 'ぶら下げ・胴'],
  ] as const).map(([grip, description, label]) => ({ id: `seed_carried_${grip}`, contact: 'air' as const, expression: 'embarrassed', activity: 'carried' as const,
    variants: 'face' as const, grip, label, description: `${description}; do not draw any hand holding her` })),
  // Watching the window she is on, her back to the viewer (owner 2026-10-28: 「後ろを向いて画面の表示を見てる仕草」). Sitting, her legs
  // hang down the far side of the edge, out of sight.
  { id: 'seed_watch_stand', contact: 'stand', expression: 'curious', activity: 'watch', variants: 'still', label: '画面を見る・立つ',
    description: 'seen from BEHIND, her back to the viewer: standing on the edge, hands clasped behind her back, head tilted down as she looks at the window below her as if reading its screen, her long hair down her back' },
  { id: 'seed_watch_sit', contact: 'sit', expression: 'curious', activity: 'watch', variants: 'still', label: '画面を見る・座る',
    description: 'seen from BEHIND, her back to the viewer: sitting on the edge facing away, leaning forward with her hands on the edge, looking down at the window below as if watching its screen, her long hair down her back, her legs on the far side out of sight' },
  // What she does for what is on the owner's screen and for her own moves (owner 2026-10-28: 「提案してくれた動きや反応を実装して」).
  { id: 'seed_climb', contact: 'wall', expression: 'determined', activity: 'climb', variants: 'still', label: '登る',
    description: 'climbing up energetically, one hand reaching higher, one knee raised, a determined little smile' },
  { id: 'seed_peek', contact: 'stand', expression: 'curious', activity: 'peek', variants: 'face', label: '覗く',
    description: 'leaning her upper body far to the left as if peeking around a corner, one hand raised by her face, her long hair hanging sideways, a curious mischievous look' },
  { id: 'seed_dizzy', contact: 'stand', expression: 'confused', activity: 'dizzy', variants: 'still', label: '目を回す',
    description: 'dizzy and wobbling, swirly spiral eyes, both hands on her head, knees bent and unsteady' },
  { id: 'seed_type', contact: 'sit', expression: 'determined', activity: 'type', variants: 'face', label: 'タイピング',
    description: 'typing fast on a tiny laptop resting on her lap, focused eyes on its screen, little motion lines by her fingers' },
  { id: 'seed_watch_video', contact: 'sit', expression: 'joyful', activity: 'watchVideo', variants: 'still', label: '動画を観る',
    description: 'seen from BEHIND, her back to the viewer: sitting on the edge facing away holding a bucket of popcorn on her lap, one hand reaching into it, watching the window below like a movie screen, her long hair down her back' },
  { id: 'seed_point', contact: 'stand', expression: 'excited', activity: 'point', variants: 'face', label: '指さす',
    description: 'pointing up and to the side excitedly with one arm stretched out, the other hand on her hip, as if saying look at that' },
  { id: 'seed_work', contact: 'sit', expression: 'determined', activity: 'work', variants: 'face', label: '作業中',
    description: 'working busily with a small wrench in one hand and a screwdriver in the other, a little open toolbox beside her, a hard-working look' },
  { id: 'seed_ask', contact: 'stand', expression: 'curious', activity: 'ask', variants: 'face', label: '手を挙げる',
    description: 'raising one hand high and straight up as if waiting to be called on, the other hand at her side, looking up expectantly' },
  { id: 'seed_dance', contact: 'stand', expression: 'joyful', activity: 'dance', variants: 'face', label: '踊る',
    description: 'dancing happily in place, front view, arms up to one side, hips swaying, one foot lifted' },
  { id: 'seed_land', contact: 'stand', expression: 'relieved', activity: 'rest', variants: 'face', label: '着地',
    description: 'just landed, knees bent and arms out for balance, a relieved smile' },
  { id: 'seed_sleep_lie', contact: 'lie', expression: 'sleepy', activity: 'sleep', variants: 'still', label: '寝そべって眠る',
    description: 'fast asleep lying on her front with her cheek on her folded arms, eyes closed, mouth slightly open, peaceful' },
  { id: 'seed_sleep_sit', contact: 'sit', expression: 'sleepy', activity: 'sleep', variants: 'still', label: '座って居眠り',
    description: 'dozing off while sitting, head drooped to one side, eyes closed, hands in her lap, peaceful' },
]);
