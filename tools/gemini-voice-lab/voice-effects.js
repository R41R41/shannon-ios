export const voiceEffectPresets = Object.freeze([
  Object.freeze({ id: 'dry', label: '原音', pitchCents: 0, robotAmount: 0 }),
  Object.freeze({ id: 'bright', label: '少し高く', pitchCents: 250, robotAmount: 0 }),
  Object.freeze({ id: 'digital', label: '明るい電子感', pitchCents: 325, robotAmount: 0.14 }),
  Object.freeze({ id: 'robot', label: '高めロボ', pitchCents: 425, robotAmount: 0.28 }),
]);

export function normalizeVoiceEffects(value = {}) {
  return Object.freeze({
    pitchCents: boundedNumber(value.pitchCents, 0, 600, 0),
    robotAmount: boundedNumber(value.robotAmount, 0, 0.5, 0),
  });
}

export function pitchRatioFromCents(cents) {
  return 2 ** (normalizeVoiceEffects({ pitchCents: cents }).pitchCents / 1_200);
}

export function processVoiceEffects(source, sampleRate, value = {}) {
  if (!(source instanceof Float32Array)) throw new TypeError('source must be Float32Array');
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError('sampleRate must be 8000-192000');
  }
  const settings = normalizeVoiceEffects(value);
  if (settings.pitchCents === 0 && settings.robotAmount === 0) return new Float32Array(source);
  const pitched = settings.pitchCents > 0
    ? shiftPitchWithCrossfadedDelay(source, sampleRate, pitchRatioFromCents(settings.pitchCents))
    : new Float32Array(source);
  const output = settings.robotAmount > 0
    ? addRobotTexture(pitched, sampleRate, settings.robotAmount)
    : pitched;
  fadeEdges(output, sampleRate);
  normalizePeak(output);
  return output;
}

export function encodeMonoFloat32WAV(samples, sampleRate) {
  if (!(samples instanceof Float32Array)) throw new TypeError('samples must be Float32Array');
  const rate = Math.round(sampleRate);
  if (!Number.isFinite(rate) || rate < 8_000 || rate > 192_000) throw new RangeError('sampleRate is invalid');
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeASCII(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeASCII(view, 8, 'WAVE');
  writeASCII(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeASCII(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32_768 : sample * 32_767, true);
  }
  return buffer;
}

export function decodePCM16WAV(value) {
  const buffer = value instanceof ArrayBuffer
    ? value
    : value?.buffer?.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44) throw new TypeError('WAV data is invalid');
  const view = new DataView(buffer);
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') throw new TypeError('WAV container is invalid');
  let format;
  let dataOffset;
  let dataLength;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const id = ascii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + length > view.byteLength) throw new TypeError('WAV chunk is truncated');
    if (id === 'fmt ' && length >= 16) {
      format = {
        encoding: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    }
    if (id === 'data') {
      dataOffset = body;
      dataLength = length;
    }
    offset = body + length + (length % 2);
  }
  if (!format || dataOffset === undefined || dataLength === undefined
      || format.encoding !== 1 || format.bitsPerSample !== 16
      || format.channels < 1 || format.channels > 2) throw new TypeError('Only mono/stereo PCM16 WAV is supported');
  const frameCount = Math.floor(dataLength / (format.channels * 2));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      total += view.getInt16(dataOffset + (frame * format.channels + channel) * 2, true) / 32_768;
    }
    samples[frame] = total / format.channels;
  }
  return Object.freeze({ samples, sampleRate: format.sampleRate });
}

function shiftPitchWithCrossfadedDelay(input, sampleRate, ratio) {
  if (input.length === 0 || ratio <= 1.0001) return new Float32Array(input);
  const delaySamples = Math.max(128, Math.round(sampleRate * 0.04));
  const cycleSamples = delaySamples / (ratio - 1);
  const output = new Float32Array(input.length + delaySamples);
  for (let index = 0; index < output.length; index += 1) {
    let weighted = 0;
    let weightSum = 0;
    for (const offset of [0, 0.5]) {
      const phase = fractional(index / cycleSamples + offset);
      const delay = 1 + delaySamples * (1 - phase);
      const readIndex = index - delay;
      if (readIndex < 0 || readIndex >= input.length - 1) continue;
      const window = Math.sin(Math.PI * phase) ** 2;
      weighted += interpolatedSample(input, readIndex) * window;
      weightSum += window;
    }
    output[index] = weightSum > 1e-6 ? weighted / weightSum : 0;
  }
  return output;
}

function addRobotTexture(input, sampleRate, amount) {
  const output = new Float32Array(input.length);
  const carrierHz = 54 + amount * 72;
  const combDelay = Math.max(1, Math.round(sampleRate * 0.0048));
  for (let index = 0; index < input.length; index += 1) {
    const dry = input[index];
    const carrier = Math.sin(2 * Math.PI * carrierHz * index / sampleRate);
    const delayed = index >= combDelay ? input[index - combDelay] : 0;
    const metallic = dry * carrier * 0.78 + (dry - delayed) * 0.36;
    const wet = Math.tanh(metallic * 1.35);
    output[index] = dry * (1 - amount) + wet * amount;
  }
  return output;
}

function fadeEdges(samples, sampleRate) {
  const length = Math.min(Math.round(sampleRate * 0.008), Math.floor(samples.length / 2));
  for (let index = 0; index < length; index += 1) {
    const gain = index / Math.max(1, length - 1);
    samples[index] *= gain;
    samples[samples.length - 1 - index] *= gain;
  }
}

function normalizePeak(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak <= 0.98) return;
  const gain = 0.98 / peak;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;
}

function interpolatedSample(samples, position) {
  const left = Math.floor(position);
  const fraction = position - left;
  return samples[left] + (samples[left + 1] - samples[left]) * fraction;
}

function fractional(value) { return value - Math.floor(value); }

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function writeASCII(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function ascii(view, offset, length) {
  let result = '';
  for (let index = 0; index < length; index += 1) result += String.fromCharCode(view.getUint8(offset + index));
  return result;
}
