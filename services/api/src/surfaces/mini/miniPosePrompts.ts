import { type MiniContact, type MiniGrip, type MiniPoseEntry } from './miniPoseContract.js';

/**
 * Drawing one mini pose: (1) the pose in words, when a reply asked for one no picture fits; (2) the base picture, drawn on the
 * layout guide with the character sheet and her original as references; (3) the green board keyed out and the window's edge
 * measured on the answer; (4) the mouth and the eyes redrawn, and only the changed part of each taken back onto the base (the
 * fourth variant, both, is made from those two without a call); (5) an inspection of the three side by side against the sheet;
 * (6) its embedding; then it joins the library. Every stage's seconds and the cost are recorded.
 */
export interface MiniPoseSpec {
  contact: MiniContact;
  expression: string | null;
  description: string;
  label: string;
  activity: MiniPoseEntry['activity'];
  /** `face`: the four face variants; `still`: the base alone (asleep). A walk also gets the four frames of its walk cycle. */
  variants: 'face' | 'still';
  /** A carried picture: where she is held. The hold is measured on the drawing and becomes its anchor. */
  grip?: MiniGrip;
  /**
   * Drawn on an empty canvas with no board, her anchor a point read off the drawing (like a carried picture's hold) but not a
   * hold: `waist`, the centre of her waist, for a dive head first into a box. Diving into a board drawn as a
   * stand-in for a window
   * went wrong (she is drawn in front of it or beside it), so she hangs in the air upside down and the desktop, which clips all
   * that is below the waist line, takes her in at that point: the entry's contact is `stand`, its anchor the waist.
   */
  anchorAt?: 'waist';
  /** How she touches the board instead of the contact's usual words (crouching, on hands and knees). */
  resting?: string;
}

export interface DrawOutcome {
  entry: MiniPoseEntry | null;
  reason: string | null;
  seconds: Record<string, number>;
  costUsd: number;
  attempts: number;
  /** Why a variant was left out (its edit changed too much or nothing), for the record. */
  notes: string[];
}

export const CONTACT_WORDS: Record<MiniContact, string> = {
  stand: "standing ON that top edge: the soles of her boots rest exactly on the green rectangle's top edge, all of " + 'her above it',
  sit:
    "sitting ON that top edge: her bottom rests exactly on the green rectangle's top edge and her legs dangle " +
    'down in FRONT of the green rectangle',
  lie:
    "lying on her front ALONG that top edge: her chest and tummy rest on the green rectangle's top edge, her " +
    'lower legs bent up in the air behind her, her long hair spilling down over the front of the green ' +
    'rectangle',
  // Drawn without a board: with one, the model hangs her under it or lets her float in front of it. Her raised
  // fists are the anchor.
  hang:
    'hanging by both hands from an invisible horizontal bar at the top of the picture (do not draw the bar): ' +
    'both arms stretched straight up, both fists closed at the same height and they are the highest part of ' +
    'her, her body and legs dangling below',
  air: 'in mid-air with nothing under her',
  wall:
    'climbing UP the right-hand side of the green rectangle (the side of a window): seen from the side, facing ' +
    'left toward it, both hands and both feet gripping its right edge, her body beside it to the right',
};

/** What touches the board, for the drawing prompt and the inspector: the spec's own words, or none for a picture
 * drawn in the air. */
export function contactWords(spec: Pick<MiniPoseSpec, 'contact' | 'resting' | 'anchorAt'>): string {
  return spec.anchorAt ? CONTACT_WORDS.air : (spec.resting ?? CONTACT_WORDS[spec.contact]);
}

export function drawPrompt(spec: MiniPoseSpec): string {
  const guide =
    spec.contact === 'wall'
      ? 'The FIRST image is a layout guide: the tall bright green rectangle on the left is the side of an ' +
        "application window on a computer desktop; its RIGHT edge is the window's side."
      : boardless(spec.contact) || spec.anchorAt
        ? 'The FIRST image is an empty transparent canvas: draw her in the middle of it, whole body visible with ' + 'margin on every side.'
        : 'The FIRST image is a layout guide: the bright green rectangle is the top of an application window on a ' +
          "computer desktop; its top edge is the window's edge.";
  return [
    guide,
    'Draw the mini (chibi) girl from the character sheet (the SECOND image; the THIRD image is her full-size ' +
      'original, for details) ' +
      `${contactWords(spec)}` +
      '.',
    `What she is doing: ${spec.description}.`,
    'Draw her eyes open and her mouth closed unless what she is doing says otherwise.',
    ...(boardless(spec.contact) || spec.anchorAt
      ? []
      : [
          'Keep the green rectangle exactly where it is, the same size and the same flat pure green, untouched ' +
            'except where she overlaps it.',
        ]),
    'Keep the character exactly the same design, outfit, colors and chibi proportions (about 3 heads tall) as ' +
      'the character sheet, at the same scale as one figure on the sheet.',
    'Only her and small things she holds (and small swirls, sparkles, sweat drops or surprise marks right by ' +
      'her head when what she is doing says so). Transparent background everywhere else. No text, no letters, no ' +
      'speech bubbles, no shadow on the background, no other characters.',
  ].join('\n');
}

export const TALK_PROMPT =
  'Edit this image. Change ONLY her mouth: if it is closed, open it as if she is in the middle of saying a ' +
  'word; if it is open, close it ' +
  ('into the same feeling with lips together. Do not change anything else at all: same pose, same position, ' +
    'same size, same hair, same eyes, same colors, ') +
  'same line art, same framing, transparent background.';

export const BLINK_PROMPT =
  'Edit this image. Change ONLY her eyes: if they are open, close both gently as in a natural blink (curved ' +
  'closed-eye lines, eyelashes ' +
  ('visible); if they are closed, open them. Do not change anything else at all: same pose, same position, ' +
    'same size, same hair, same mouth, same colors, ') +
  'same line art, same framing, transparent background.';

// A walk is drawn as one sheet of frames, like the character sheet: drawn together, the frames keep one face, one outfit and one
// size. Redrawing only the legs of the walking picture did not work (2026-10-28): a natural step swings the arms too, so every
// redraw changed the upper body, and asked to swap the legs the model gave the same legs back. Eight frames (a full cycle, two
// steps, owner 2026-10-28: smoother) are one sheet of two rows of four, drawn in one call; older entries have the four frames.
export interface CycleSheet {
  frames: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export const SHEET_4: CycleSheet = { frames: 4, columns: 4, rows: 1, width: 2560, height: 1024 };

export const SHEET_8: CycleSheet = { frames: 8, columns: 4, rows: 2, width: 2560, height: 2048 };

export const SHEET_TAIL = 'Flat pure green background (#00FF00) everywhere. No text, no numbers, no frame borders, no shadows.';

export const sheetWords = (sheet: CycleSheet) =>
  sheet.rows === 1
    ? `${sheet.frames} frames side by side in ONE row, left to right`
    : `${sheet.frames} frames in ${sheet.rows} rows of ${sheet.columns}, each row left to right, the first row then the second`;

export const cycleLines = (lines: readonly string[]) => lines.map((line, index) => `${index + 1}. ${line}`);

export function dancePrompt(sheet: CycleSheet): string {
  const four = [
    'arms up to the left, hips to the right, one foot lifted',
    'arms crossed in front, both feet down, knees bent a little',
    'arms up to the right, hips to the left, the other foot lifted',
    'arms crossed in front again, both feet down, knees bent a little',
  ];
  const eight = [
    'arms up to the left, hips to the right, one foot lifted',
    'arms coming down in front, hips centred, the lifted foot landing',
    'arms crossed in front, both feet down, knees bent a little',
    'arms swinging up to the right, hips going to the left, weight on the left foot',
    'arms up to the right, hips to the left, the other foot lifted',
    'arms coming down in front, hips centred, the lifted foot landing',
    'arms crossed in front, both feet down, knees bent a little',
    'arms swinging up to the left, hips going to the right, weight on the right foot',
  ];
  return [
    'The FIRST image is the girl dancing (one frame). The SECOND image is her character sheet.',
    'Draw a ' +
      `${sheet.frames}` +
      '-frame DANCE LOOP animation sprite sheet of this exact chibi girl dancing happily in place, front view, a ' +
      'simple cute beat dance that loops smoothly from the last frame back to the first.',
    '' +
      `${sheetWords(sheet)}` +
      ', evenly spaced, each frame the same size as the girl in the first image, all standing on the same ' +
      'horizontal ground line (one ground line per row), nothing overlapping:',
    ...cycleLines(sheet.frames === 8 ? eight : four),
    'The same face as the first image, same hair, same outfit, same colors and the same size in every frame; ' +
      'the hair and skirt swing with the beat.',
    SHEET_TAIL,
  ].join('\n');
}

export function walkPrompt(sheet: CycleSheet): string {
  const four = [
    'contact: front leg forward, heel touching the ground, back leg behind, arms swinging opposite to the legs',
    'passing: legs passing each other under her body, back foot lifted, body slightly higher',
    'contact: the OTHER leg forward, heel touching the ground, arms swung the other way',
    'passing: legs passing each other again, the other foot lifted, body slightly higher',
  ];
  const eight = [
    'contact: front leg forward, heel touching the ground, back leg behind, arms swinging opposite to the ' +
      'legs, body at its normal height',
    'down: the front foot flat on the ground taking her weight, knee bent a little, body at its lowest, the ' + 'back heel lifting',
    'passing: the back leg swinging forward under her body, the back foot lifted off the ground, body rising',
    'up: the swinging leg reaching forward, the standing leg straight on its toes, body at its highest',
    'contact: the OTHER leg forward, heel touching the ground, arms swung the other way, body at its normal ' + 'height',
    'down: the new front foot flat on the ground taking her weight, knee bent a little, body at its lowest, ' + 'the back heel lifting',
    'passing: the other back leg swinging forward under her body, that foot lifted off the ground, body rising',
    'up: the swinging leg reaching forward, the standing leg straight on its toes, body at its highest, ready ' +
      'to start again at frame 1',
  ];
  return [
    'The FIRST image is the girl walking (one frame). The SECOND image is her character sheet.',
    'Draw a ' +
      `${sheet.frames}` +
      '-frame WALK CYCLE animation sprite sheet of this exact chibi girl walking to the LEFT, in the same ' +
      'three-quarter view as the first image; the frames are evenly spaced in time through ONE full cycle (two ' +
      'steps) and loop smoothly from the last back to the first.',
    '' +
      `${sheetWords(sheet)}` +
      ', evenly spaced, each frame the same size as the girl in the first image, all standing on the same ' +
      'horizontal ground line (one ground line per row), nothing overlapping:',
    ...cycleLines(sheet.frames === 8 ? eight : four),
    'The same face as the first image, same hair, same outfit, same colors and the same size in every frame; ' +
      'only the legs, arms and the hair and skirt sway change.',
    SHEET_TAIL,
  ].join('\n');
}

export const GRIP_WORDS: Record<MiniGrip | 'waist', string> = {
  arm: 'the wrist of her raised arm, where a hand holds her up',
  leg: 'the ankle of her raised leg, where a hand holds her up upside down',
  head: 'the top of her head, where a hand holds her up',
  scruff: 'the back of her collar at the nape of her neck, where a hand holds her up',
  torso: 'the middle of her waist, where a hand holds her up',
  waist: 'the centre of her waist, the narrowest point of her body between her chest and her hips',
};

export const MEASURE_INSTRUCTIONS =
  'The image is 512x512 pixels and shows one chibi girl. Give the bounding box of her HEAD ONLY: from the ' +
  'top of her hair on ' +
  ('the skull (NOT the ahoge antenna, NOT the two hair buns) down to the bottom of her chin, and from one ' +
    'side of her skull to the other (NOT the long ') +
  ('hair hanging down, NOT the buns). If her head is tilted, still box the head itself. When "hold" is given, ' +
    'also give the one pixel point it ') +
  'describes. Answer only JSON {"head":[left,top,right,bottom],"grip":[x,y] or null}.';

export const INSPECT_INSTRUCTIONS =
  'You check drawings of a mascot character for a desktop app. The first image is her official character ' +
  'sheet (four views). ' +
  ('The second image shows the new drawing; when it holds several panels side by side, the first panel is the ' +
    'base picture and the others are variants. ') +
  ('The plain grey block with a dark top band behind her is a stand-in for the application window she is on; ' +
    'it is not part of the drawing. ') +
  ('Answer only JSON with booleans: same_character (same girl as the sheet: light-blue long hair with pink ' +
    'tips, two buns, ahoge, white off-shoulder blouse, ') +
  ('black suspenders, light-blue pleated skirt, black thigh-highs, black boots), chibi (chibi proportions ' +
    'like the sheet), one_character (exactly one girl), ') +
  ('clean (no text, no speech bubbles, no frames, no background scenery), anatomy_ok (no extra or missing ' +
    'limbs or fingers that a viewer would notice), ') +
  ('pose_matches (the base picture shows the described pose and feeling), variants_ok (each variant differs ' +
    'from the base only as described, or true when ') +
  'there are none); and "problems": one short sentence or "".';

/** Contacts drawn on an empty canvas: there is no board to key out (a board under a hang is drawn wrong too often). */
export function boardless(contact: MiniContact): boolean {
  return contact === 'air' || contact === 'hang';
}
