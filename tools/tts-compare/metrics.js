export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

export function summarize(samples) {
  const complete = samples.filter(sample => sample.state === 'complete');
  return { count: complete.length, failed: samples.filter(sample => sample.state === 'failed').length,
    median: percentile(complete.map(s => s.metrics.firstByteMs), .5),
    p95: percentile(complete.map(s => s.metrics.firstByteMs), .95) };
}

export function pcmWav(chunks) {
  const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const wav = new Uint8Array(44 + bytes);
  const view = new DataView(wav.buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => { wav[offset + i] = c.charCodeAt(0); });
  ascii(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, bytes, true);
  let offset = 44;
  for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.length; }
  return wav;
}

export async function readFrames(body, handle) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 12000000) throw new Error('INVALID_UPSTREAM');
      let boundary;
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
        if (line.trim()) await handle(JSON.parse(line));
      }
      if (done) break;
    }
    if (pending.trim()) await handle(JSON.parse(pending));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
