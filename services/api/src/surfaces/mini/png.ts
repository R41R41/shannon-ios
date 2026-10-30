import { deflateSync, inflateSync } from 'node:zlib';

/**
 * The few PNGs the mini poses need, without a dependency: 8-bit RGB or RGBA, not interlaced (what the image
 * model returns and what
 * this module writes). Pixels are RGBA, row by row.
 */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function blankImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG_INVALID');
  const { width, height, colorType, idat } = pngChunks(buffer);
  if (!width || !height || colorType < 0) throw new Error('PNG_INVALID');
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG_INVALID');
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride, previous = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[out + x - channels]! : 0, b = y > 0 ? rows[previous + x]! : 0;
      const c = x >= channels && y > 0 ? rows[previous + x - channels]! : 0;
      const value = pngFilterByte(filter, line[x]!, a, b, c);
      rows[out + x] = value & 0xff;
    }
  }
  return rgbaRows(width, height, rows, channels);

}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** RGBA, filter 1 (sub) on every row: small enough for flat transparent pictures, and fast. */
export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4, raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const row = y * (stride + 1), source = y * stride;
    raw[row] = 1;
    for (let x = 0; x < stride; x++) raw[row + 1 + x] = (image.data[source + x]! - (x >= 4 ? image.data[source + x - 4]! : 0)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
    header[9] = 6;
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** PNGのチャンクからヘッダーと圧縮データだけを読む。 */
function pngChunks(buffer: Buffer) {
  let offset = 8, width = 0, height = 0, colorType = -1;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
      const depth = body[8], interlace = body[12];
      colorType = body[9]!;
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('PNG_UNSUPPORTED');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  return { width, height, colorType, idat };
}

/** PNGの各フィルターの逆変換。丸めは呼び出し元で行う。 */
function pngFilterByte(filter: number, value: number, a: number, b: number, c: number): number {
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('PNG_INVALID');
  return value;
}

/** 復元したRGB/RGBAの行を、共通のRGBA画像へ写す。 */
function rgbaRows(width: number, height: number, rows: Uint8Array, channels: number): RgbaImage {
  const image = blankImage(width, height);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    image.data[i * 4] = rows[j]!;
      image.data[i * 4 + 1] = rows[j + 1]!;
      image.data[i * 4 + 2] = rows[j + 2]!;
    image.data[i * 4 + 3] = channels === 4 ? rows[j + 3]! : 255;
  }
  return image;
}
