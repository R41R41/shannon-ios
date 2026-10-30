import { boardless } from './miniPosePrompts.js';
import { type RgbaImage } from './png.js';
import { clearHaze, crop, keyGreen, MINI_CANVAS, solidBounds, solidShare } from './miniImage.js';
import { type MiniContact, type MiniPoseEntry } from './miniPoseContract.js';

/** The base picture keyed and measured; a picture whose board or figure cannot be read is refused. */
export function shapeBase(
  raw: RgbaImage,
  contact: MiniContact,
  backView = false,
  inAir = false,
): { image: RgbaImage; anchor: { x: number; y: number }; bounds: MiniPoseEntry['bounds'] } | { reason: string } {
  if (raw.width !== MINI_CANVAS || raw.height !== MINI_CANVAS) return { reason: 'size' };
  const keyed = boardless(contact) || inAir ? { image: clearHaze(raw), edge: null } : keyGreen(raw);
  const bounds = solidBounds(keyed.image);
  if (!bounds) return { reason: 'empty' };
  const share = solidShare(keyed.image);
  if (share < 0.04 || share > 0.5) return { reason: `share:${share.toFixed(3)}` };
  // Climbing, she may touch the top or the bottom of the canvas (the side board runs its full height); never the right side.
  const figureCutOff = () =>
    contact === 'wall'
      ? bounds.right > MINI_CANVAS - 5
      : bounds.left < 4 ||
        bounds.top < 4 ||
        bounds.right > MINI_CANVAS - 5 ||
        ((boardless(contact) || inAir) && bounds.bottom > MINI_CANVAS - 5);
  if (figureCutOff()) return { reason: 'cut_off' };
  if (contact === 'wall') {
    const wallPose = () => {
      const side = (keyed as { side?: number | null }).side ?? null;
      if (side === null) return { reason: 'no_side' };
      if (bounds.right <= side) return { reason: 'not_on_side' };
      return { image: keyed.image, anchor: { x: side, y: bounds.bottom }, bounds };
    };
    return wallPose();
  }
  // Drawn in the air: its anchor is read off the drawing afterwards; the middle of her stands in for it.
  if (inAir)
    return {
      image: keyed.image,
      anchor: { x: Math.round((bounds.left + bounds.right) / 2), y: Math.round((bounds.top + bounds.bottom) / 2) },
      bounds,
    };
  if (!boardless(contact)) {
    const edgeProblem = () => {
      if (keyed.edge === null) return { reason: 'no_edge' };
      // Her figure must actually meet the edge: something of her above it.
      if (bounds.top >= keyed.edge) return { reason: 'below_edge' };
      // Sitting, her legs hang in front of the window. Legs drawn behind the board went out with it (the seed's 23 sitting
      // pictures have 13 to 18% of her below the edge).
      if (contact === 'sit' && !backView && shareBelow(keyed.image, keyed.edge + 5) < MIN_LEGS_BELOW) return { reason: 'legs_hidden' };
    };
    const problem = edgeProblem();
    if (problem) return problem;
  }
  // A hang's edge is just under the top of her raised fists, so they grip it.
  const anchorY =
    contact === 'air' ? bounds.bottom : contact === 'hang' ? bounds.top + Math.round((bounds.bottom - bounds.top) * 0.035) : keyed.edge!;
  return { image: keyed.image, anchor: { x: Math.round((bounds.left + bounds.right) / 2), y: anchorY }, bounds };
}

/**
 * The horizontal spans of the `count` figures on a sheet: runs of columns that hold solid pixels, the narrowest gaps closed until
 * `count` are left (a hand reaching past the hair can leave a sliver). Null when fewer than `count` figures stand apart.
 */
export function figureSpans(sheet: RgbaImage, count: number): [number, number][] | null {
  const filled: boolean[] = [];
  for (let x = 0; x < sheet.width; x++) {
    let solid = 0;
    for (let y = 0; y < sheet.height && solid < 3; y++) if (sheet.data[(y * sheet.width + x) * 4 + 3]! > 128) solid++;
    filled.push(solid >= 3);
  }
  let spans: [number, number][] = [];
  for (let x = 0; x < filled.length; x++) {
    if (!filled[x]) continue;
    const start = x;
    while (x + 1 < filled.length && filled[x + 1]) x++;
    spans.push([start, x]);
  }
  // Specks narrower than 8 columns are not figures.
  spans = spans.filter(([from, to]) => to - from >= 8);
  while (spans.length > count) {
    let narrowest = 1;
    for (let i = 2; i < spans.length; i++)
      if (spans[i]![0] - spans[i - 1]![1] < spans[narrowest]![0] - spans[narrowest - 1]![1]) narrowest = i;
    spans.splice(narrowest - 1, 2, [spans[narrowest - 1]![0], spans[narrowest]![1]]);
  }
  return spans.length === count ? spans.map(([from, to]) => [Math.max(0, from - 4), Math.min(sheet.width - 1, to + 4)]) : null;
}

/**
 * The cells of a sheet of `rows` rows of `columns` figures, row by row: the sheet is cut across at the emptiest line near each
 * row boundary, then each row's figures are found as in `figureSpans`. Null when any row lacks its figures.
 */
export function figureGrid(
  sheet: RgbaImage,
  columns: number,
  rows: number,
): { left: number; top: number; right: number; bottom: number }[] | null {
  const solidInRow = (y: number) => {
    let n = 0;
    for (let x = 0; x < sheet.width; x++) if (sheet.data[(y * sheet.width + x) * 4 + 3]! > 128) n++;
    return n;
  };
  const cuts = [0];
  for (let row = 1; row < rows; row++) {
    const centre = Math.round((sheet.height * row) / rows),
      reach = Math.round(sheet.height * 0.12);
    // The middle of the emptiest stretch: each row keeps the same room around its figures.
    const counts: number[] = [];
    for (let y = centre - reach; y <= centre + reach; y++) counts.push(solidInRow(y));
    const least = Math.min(...counts),
      emptiest = counts.flatMap((n, i) => (n === least ? [centre - reach + i] : []));
    cuts.push(emptiest[Math.floor(emptiest.length / 2)]!);
  }
  cuts.push(sheet.height);
  const cells: { left: number; top: number; right: number; bottom: number }[] = [];
  for (let row = 0; row < rows; row++) {
    const top = cuts[row]!,
      bottom = cuts[row + 1]! - 1;
    const band = crop(sheet, { left: 0, top, right: sheet.width - 1, bottom });
    const spans = figureSpans(band, columns);
    if (!spans) return null;
    // The row's top and bottom are the band's own; a cell holds one figure.
    for (const [left, right] of spans) cells.push({ left, top, right, bottom });
  }
  return cells;
}

/** The least share of a sitting figure below the edge: her dangling legs. */
export const MIN_LEGS_BELOW = 0.06;

/** The share of her solid pixels at or below row y. */
export function shareBelow(image: RgbaImage, y: number): number {
  let below = 0,
    all = 0;
  for (let p = 0, i = 3; p < image.width * image.height; p++, i += 4) {
    if (image.data[i]! <= 128) continue;
    all++;
    if (Math.floor(p / image.width) >= y) below++;
  }
  return all ? below / all : 0;
}

export function rounded(seconds: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(seconds).map(([key, value]) => [key, Math.round(value * 10) / 10]));
}
