import { blankImage, type RgbaImage } from './png.js';
import type { MiniContact } from './miniPoseContract.js';

/**
 * The picture work of a mini pose, all on RGBA pixels: the layout guide the image model draws on, keying out its green board and
 * measuring where the window's edge ended up, and taking only the changed part of a mouth or eye edit back onto the base picture
 * (the model may redraw the whole canvas, its background included; only the face may change between variants).
 */
export const MINI_CANVAS = 1024;
/** Where the guide's board starts. The model may move it; the edge is measured on its answer, never assumed. */
export const GUIDE_EDGE = 640;
const GUIDE_LEFT = 112, GUIDE_RIGHT = 912;

export interface Box { left: number; top: number; right: number; bottom: number }

/** Where the side board's right edge starts, for a `wall` picture (she clings to it). */
export const GUIDE_SIDE = 420;

/**
 * The layout guide: a flat pure-green board that stands for the top of a window. `air` and `hang` have none (a transparent canvas);
 * `wall` has a tall board on the left whose right edge is the window's side.
 */
export function guideFor(contact: MiniContact): RgbaImage {
  const image = blankImage(MINI_CANVAS, MINI_CANVAS);
  if (contact === 'air' || contact === 'hang') return image;
  if (contact === 'wall') {
    for (let y = 0; y < MINI_CANVAS; y++) for (let x = 60; x <= GUIDE_SIDE; x++) { const i = (y * MINI_CANVAS + x) * 4; image.data[i + 1] = 255; image.data[i + 3] = 255; }
    return image;
  }
  for (let y = GUIDE_EDGE; y < MINI_CANVAS; y++) {
    for (let x = GUIDE_LEFT; x <= GUIDE_RIGHT; x++) {
      const i = (y * MINI_CANVAS + x) * 4;
      image.data[i + 1] = 255; image.data[i + 3] = 255;
    }
  }
  return image;
}

const greenness = (d: Uint8ClampedArray, i: number) => d[i + 1]! - Math.max(d[i]!, d[i + 2]!);

/**
 * Keys out the green board and reads the edge: the first row where the board covers a quarter of the width. Strong green goes
 * transparent, weak green half so and loses its green; the faint glow the model sometimes paints around her goes too.
 */
export function keyGreen(source: RgbaImage): { image: RgbaImage; edge: number | null; board: [number, number] | null; side: number | null } {
  const { width, height } = source, d = source.data, out = new Uint8ClampedArray(d);
  let edge: number | null = null, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (greenness(d, i) > 90 && d[i + 3]! > 128) { count++; if (x < left) left = x; if (x > right) right = x; }
    }
    if (edge === null && count > width * 0.25) edge = y;
  }
  for (let i = 0; i < d.length; i += 4) {
    const g = greenness(d, i);
    let alpha = d[i + 3]!;
    if (g > 90) alpha = 0;
    else if (g > 25) alpha = alpha * Math.min(1, Math.max(0, (90 - g) / 65));
    if (g > 0) out[i + 1] = Math.max(d[i]!, d[i + 2]!);
    out[i + 3] = alpha < 24 ? 0 : alpha;
  }
  // A side board's right edge: the last column the board fills for a quarter of the height.
  let side: number | null = null;
  for (let x = width - 1; x >= 0 && side === null; x--) {
    let count = 0;
    for (let y = 0; y < height; y++) { const i = (y * width + x) * 4; if (greenness(d, i) > 90 && d[i + 3]! > 128) count++; }
    if (count > height * 0.25) side = x;
  }
  return { image: { width, height, data: out }, edge, board: right >= 0 ? [left, right] : null, side };
}

/** Clears the faint, nearly transparent haze outside her (some answers carry a glow even without a board). */
export function clearHaze(source: RgbaImage, below = 24): RgbaImage {
  const out = new Uint8ClampedArray(source.data);
  for (let i = 3; i < out.length; i += 4) if (out[i]! < below) out[i] = 0;
  return { width: source.width, height: source.height, data: out };
}

/** The box of her solid pixels, or null when there are none. */
export function solidBounds(image: RgbaImage, alphaAbove = 128): Box | null {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3]! <= alphaAbove) continue;
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

export function solidShare(image: RgbaImage, alphaAbove = 128): number {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i]! > alphaAbove) count++;
  return count / (image.width * image.height);
}

/** The picture flattened onto one colour. */
export function flatten(image: RgbaImage, rgb: [number, number, number]): RgbaImage {
  const out = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = image.data[i + 3]! / 255;
    out[i] = image.data[i]! * a + rgb[0] * (1 - a);
    out[i + 1] = image.data[i + 1]! * a + rgb[1] * (1 - a);
    out[i + 2] = image.data[i + 2]! * a + rgb[2] * (1 - a);
    out[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** A separable box blur of a one-channel map (radius r), in place of a Gaussian: the region only has to be smooth. */
function boxBlur(map: Float32Array, width: number, height: number, r: number): Float32Array {
  const tmp = new Float32Array(map.length), out = new Float32Array(map.length), size = 2 * r + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += map[y * width + Math.min(width - 1, Math.max(0, x))]!;
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = sum / size;
      sum += map[y * width + Math.min(width - 1, x + r + 1)]! - map[y * width + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x]!;
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / size;
      sum += tmp[Math.min(height - 1, y + r + 1) * width + x]! - tmp[Math.max(0, y - r) * width + x]!;
    }
  }
  return out;
}

export interface ChangedRegion {
  /** 0..1 per pixel: how much of the edit to take there. */
  weight: Float32Array;
  box: Box;
  /** The region's area against her solid area. */
  share: number;
}

/**
 * Where an edit changed her, as one smooth region: pixels whose colour moved (both flattened on grey), inside her, gathered by a
 * blur so the scattered one-pixel line noise of a redraw does not count, keeping only clusters near the strongest one.
 * Null when nothing clear changed.
 */
export function changedRegion(base: RgbaImage, edited: RgbaImage): ChangedRegion | null {
  if (base.width !== edited.width || base.height !== edited.height) return null;
  const { width, height } = base, a = flatten(base, [128, 128, 128]).data, b = flatten(edited, [128, 128, 128]).data;
  const changed = new Float32Array(width * height);
  let solid = 0;
  for (let p = 0, i = 0; p < changed.length; p++, i += 4) {
    if (base.data[i + 3]! <= 200) continue;
    solid++;
    const diff = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!));
    if (diff > 40) changed[p] = 1;
  }
  const density = boxBlur(changed, width, height, 9);
  let peak = 0, peakAt = -1;
  for (let p = 0; p < density.length; p++) if (density[p]! > peak) { peak = density[p]!; peakAt = p; }
  if (peak < 0.2 || peakAt < 0) return null;
  const solidBox = solidBounds(base, 200);
  const reach = solidBox ? (solidBox.bottom - solidBox.top) * 0.22 : height * 0.2;
  const px = peakAt % width, py = Math.floor(peakAt / width);
  const keep = new Float32Array(width * height);
  for (let p = 0; p < density.length; p++) {
    if (density[p]! < peak * 0.22) continue;
    const x = p % width, y = Math.floor(p / width);
    if (Math.hypot(x - px, y - py) <= reach) keep[p] = 1;
  }
  const grown = boxBlur(keep, width, height, 6);
  const weight = new Float32Array(width * height);
  let left = width, top = height, right = -1, bottom = -1, area = 0;
  for (let p = 0; p < grown.length; p++) {
    if (grown[p]! <= 0.01) continue;
    const w = Math.min(1, grown[p]! * 2.2);
    weight[p] = w;
    if (w > 0.5) area++;
    const x = p % width, y = Math.floor(p / width);
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
  }
  if (right < 0) return null;
  return { weight, box: { left, top, right, bottom }, share: solid ? area / solid : 1 };
}

/** The base picture with each edit taken in where its region says, keeping the base's alpha (her outline never moves). */
export function takeRegions(base: RgbaImage, edits: readonly { image: RgbaImage; region: ChangedRegion }[]): RgbaImage {
  const out = new Uint8ClampedArray(base.data);
  for (const { image, region } of edits) {
    for (let p = 0, i = 0; p < region.weight.length; p++, i += 4) {
      const w = region.weight[p]!;
      if (w <= 0 || base.data[i + 3]! === 0) continue;
      for (let c = 0; c < 3; c++) out[i + c] = out[i + c]! * (1 - w) + image.data[i + c]! * w;
    }
  }
  return { width: base.width, height: base.height, data: out };
}

/** The picture scaled to width x height, bilinear on premultiplied colour (transparent pixels do not darken her outline). */
export function scaled(image: RgbaImage, width: number, height: number): RgbaImage {
  const out = blankImage(width, height), d = image.data;
  const sx = image.width / width, sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.floor(fy), y1 = Math.min(image.height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.floor(fx), x1 = Math.min(image.width - 1, x0 + 1), wx = fx - x0;
      let r = 0, g = 0, b = 0, a = 0;
      for (const [px, py, w] of [[x0, y0, (1 - wx) * (1 - wy)], [x1, y0, wx * (1 - wy)], [x0, y1, (1 - wx) * wy], [x1, y1, wx * wy]] as const) {
        const i = (py * image.width + px) * 4, alpha = d[i + 3]! * w;
        r += d[i]! * alpha; g += d[i + 1]! * alpha; b += d[i + 2]! * alpha; a += alpha;
      }
      const o = (y * width + x) * 4;
      if (a > 0) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; }
      out.data[o + 3] = a;
    }
  }
  return out;
}

/** Copies `image` onto a blank canvas with its top left at (x, y); what falls outside is cut. */
export function placed(image: RgbaImage, width: number, height: number, x: number, y: number): RgbaImage {
  const out = blankImage(width, height);
  for (let row = 0; row < image.height; row++) {
    const ty = row + y;
    if (ty < 0 || ty >= height) continue;
    for (let col = 0; col < image.width; col++) {
      const tx = col + x;
      if (tx < 0 || tx >= width) continue;
      out.data.set(image.data.subarray((row * image.width + col) * 4, (row * image.width + col) * 4 + 4), (ty * width + tx) * 4);
    }
  }
  return out;
}

/** The mean x of her solid pixels in the top `share` of her height: where her head is, which a walk's swinging limbs do not move. */
export function headCentre(image: RgbaImage, box: Box, share = 0.3): number {
  let sum = 0, count = 0;
  const until = box.top + (box.bottom - box.top) * share;
  for (let y = box.top; y <= until; y++) {
    for (let x = box.left; x <= box.right; x++) if (image.data[(y * image.width + x) * 4 + 3]! > 128) { sum += x; count++; }
  }
  return count ? sum / count : (box.left + box.right) / 2;
}

/** Half the size, averaging 2x2 (premultiplied, so transparent pixels do not darken the edges). */
export function halve(image: RgbaImage): RgbaImage {
  const width = image.width >> 1, height = image.height >> 1, out = blankImage(width, height), d = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const i = ((y * 2 + dy) * image.width + x * 2 + dx) * 4, alpha = d[i + 3]!;
        r += d[i]! * alpha; g += d[i + 1]! * alpha; b += d[i + 2]! * alpha; a += alpha;
      }
      const o = (y * width + x) * 4;
      if (a > 0) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; }
      out.data[o + 3] = a / 4;
    }
  }
  return out;
}

/** Pictures side by side on one flat colour, for the inspector to look at in one image. */
export function strip(images: readonly RgbaImage[], rgb: [number, number, number]): RgbaImage {
  const height = Math.max(...images.map(image => image.height)), width = images.reduce((sum, image) => sum + image.width, 0);
  const out = blankImage(width, height);
  let x0 = 0;
  for (const image of images) {
    const flat = flatten(image, rgb);
    for (let y = 0; y < image.height; y++) out.data.set(flat.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), (y * width + x0) * 4);
    x0 += image.width;
  }
  return out;
}

/**
 * Her picture in front of a plain stand-in window whose top is at `edge` (the board was keyed out), on a flat colour: what the
 * inspector looks at, so it can see that she sits on, stands on or hangs from something.
 */
export function onWindow(image: RgbaImage, edge: number | null): RgbaImage {
  const out = blankImage(image.width, image.height);
  for (let p = 0, i = 0; p < image.width * image.height; p++, i += 4) {
    const x = p % image.width, y = Math.floor(p / image.width);
    const inWindow = edge !== null && y >= edge && x >= GUIDE_LEFT && x <= GUIDE_RIGHT;
    const back: [number, number, number] = inWindow ? (y < edge! + 36 ? [70, 78, 96] : [150, 158, 175]) : [236, 238, 242];
    const a = image.data[i + 3]! / 255;
    for (let c = 0; c < 3; c++) out.data[i + c] = image.data[i + c]! * a + back[c]! * (1 - a);
    out.data[i + 3] = 255;
  }
  return out;
}

/** Copies a box out of a picture. */
export function crop(image: RgbaImage, box: Box): RgbaImage {
  const left = Math.max(0, box.left), top = Math.max(0, box.top), right = Math.min(image.width - 1, box.right), bottom = Math.min(image.height - 1, box.bottom);
  const out = blankImage(right - left + 1, bottom - top + 1);
  for (let y = top; y <= bottom; y++) out.data.set(image.data.subarray((y * image.width + left) * 4, (y * image.width + right + 1) * 4), (y - top) * out.width * 4);
  return out;
}
