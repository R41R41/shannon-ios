class ShannonCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourcePosition = 0;
    this.pending = [];
    this.targetRate = 16_000;
    this.chunkSamples = 1_600;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input?.length) return true;

    const step = sampleRate / this.targetRate;
    while (this.sourcePosition < input.length) {
      const lower = Math.min(input.length - 1, Math.floor(this.sourcePosition));
      const upper = Math.min(input.length - 1, lower + 1);
      const fraction = this.sourcePosition - lower;
      const sample = input[lower] + (input[upper] - input[lower]) * fraction;
      this.pending.push(Math.max(-1, Math.min(1, sample)));
      this.sourcePosition += step;
    }
    this.sourcePosition -= input.length;

    while (this.pending.length >= this.chunkSamples) {
      const pcm = new Int16Array(this.chunkSamples);
      for (let index = 0; index < pcm.length; index += 1) {
        const sample = this.pending[index];
        pcm[index] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
      }
      this.pending.splice(0, this.chunkSamples);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('shannon-capture', ShannonCaptureProcessor);
