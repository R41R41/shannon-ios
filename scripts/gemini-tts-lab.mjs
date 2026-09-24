#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  audioBlockFromResponse,
  buildTTSRequest,
  buildVoiceDesignRequest,
  DEFAULT_VOICES,
  DESIGN_PRESETS,
  GEMINI_TTS_MODELS,
  LAB_SCRIPTS,
  parseList,
  pcm16MonoWav,
  percentile,
  resolveScript,
  resolveStyle,
  safeFileSegment,
  serverSentEvents,
  sha256,
  STYLE_PRESETS,
  voiceSampleFromResponse,
  wavMetadata,
} from './gemini-tts-lab-core.mjs';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_OUTPUT_ROOT = path.resolve('artifacts/gemini-tts');

const [command = 'help', ...rawArguments] = process.argv.slice(2);
const options = parseOptions(rawArguments);

try {
  switch (command) {
  case 'voices':
    await listVoices(options);
    break;
  case 'sample':
    await createSample(options);
    break;
  case 'matrix':
    await createMatrix(options);
    break;
  case 'stream':
    await createStreamSample(options);
    break;
  case 'design':
    await designVoice(options);
    break;
  case 'delete':
    await deleteVoice(options);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`Gemini TTS lab: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function listVoices(values) {
  const parameters = new URLSearchParams();
  appendList(parameters, 'language_code', parseList(values.language, ['ja-JP']));
  appendList(parameters, 'gender', parseList(values.gender, ['female']));
  appendList(parameters, 'pitch', parseList(values.pitch, ['high', 'medium']));
  appendList(parameters, 'context', parseList(values.context, ['Conversational']));
  appendList(parameters, 'type', parseList(values.type, ['prebuilt']));
  if (values.search) parameters.set('search', values.search);
  parameters.set('page_size', boundedInteger(values.limit, 1, 1_000, 100));
  const response = await geminiRequest(`/voices?${parameters}`);
  const voices = Array.isArray(response.voices) ? response.voices : [];
  process.stdout.write(`${JSON.stringify({ count: voices.length, voices }, null, 2)}\n`);
}

async function createSample(values) {
  const model = normalizedModel(values.model);
  const voice = values.voice ?? 'Leda';
  const scriptName = values.script ?? 'identity';
  const styleName = values['style-preset'] ?? 'plain';
  const text = resolveScript(scriptName, values.text);
  const style = resolveStyle(styleName, values.style);
  const directory = await outputDirectory(values.out);
  const result = await synthesize({ model, voice, text, style, scriptName, styleName, directory });
  await writeManifest(directory, [result]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function createMatrix(values) {
  const models = parseList(values.models, GEMINI_TTS_MODELS).map(normalizedModel);
  const voices = parseList(values.voices, DEFAULT_VOICES);
  if (!voices.length) throw new Error('At least one voice is required');
  const scripts = values.script === 'all'
    ? Object.keys(LAB_SCRIPTS)
    : parseList(values.scripts ?? values.script, ['identity']);
  const styles = parseList(values.styles ?? values['style-preset'], ['plain']);
  const directory = await outputDirectory(values.out);
  const results = [];
  for (const model of models) {
    for (const voice of voices) {
      for (const scriptName of scripts) {
        const text = resolveScript(scriptName, undefined);
        for (const styleName of styles) {
          const style = resolveStyle(styleName, undefined);
          process.stderr.write(`Generating ${model} / ${voice} / ${scriptName} / ${styleName}\n`);
          const result = await synthesize({ model, voice, text, style, scriptName, styleName, directory });
          results.push(result);
          await writeManifest(directory, results);
        }
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ directory, sampleCount: results.length, manifest: path.join(directory, 'manifest.json') }, null, 2)}\n`);
}

async function createStreamSample(values) {
  const model = normalizedModel(values.model);
  const voice = values.voice ?? 'Leda';
  const scriptName = values.script ?? 'identity';
  const styleName = values['style-preset'] ?? 'plain';
  const text = resolveScript(scriptName, values.text);
  const style = resolveStyle(styleName, values.style);
  const directory = await outputDirectory(values.out);
  const result = await synthesizeStream({ model, voice, text, style, scriptName, styleName, directory });
  await writeManifest(directory, [result]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function designVoice(values) {
  if (values.store !== true) {
    throw new Error('Voice design creates a voice stored for up to one year. Re-run with --store to confirm.');
  }
  const preset = values.preset ?? 'shannon-bright';
  const prompt = values.prompt ?? DESIGN_PRESETS[preset];
  if (!prompt) throw new Error(`Unknown design preset: ${preset}`);
  const name = values.name ?? `Shannon ${preset.replace(/^shannon-/u, '')}`;
  const model = normalizedModel(values.model);
  const body = buildVoiceDesignRequest({
    model,
    name,
    prompt,
    language: values.language ?? 'ja-JP',
    gender: values.gender ?? 'female',
  });
  const response = await geminiRequest('/voices', { method: 'POST', body });
  const id = typeof response.id === 'string' ? response.id : undefined;
  if (!id) throw new Error('Gemini response did not contain a voice ID');
  const { audio, mimeType } = voiceSampleFromResponse(response);
  const directory = await outputDirectory(values.out);
  const file = path.join(directory, `${safeFileSegment(id)}-preview.wav`);
  await writeFile(file, audio, { flag: values.force === true ? 'w' : 'wx' });
  const result = { id, name, preset, model, mimeType, file, wav: wavMetadata(audio) };
  await writeFile(path.join(directory, `${safeFileSegment(id)}.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function deleteVoice(values) {
  const id = String(values.id ?? '').trim();
  if (!/^voice_[A-Za-z0-9_-]+$/u.test(id)) throw new Error('delete requires an exact --id voice_... value');
  if (values.confirm !== id) throw new Error(`Re-run with --confirm ${id} to delete this stored voice`);
  await geminiRequest(`/voices/${encodeURIComponent(id)}`, { method: 'DELETE', allowEmpty: true });
  process.stdout.write(`${JSON.stringify({ deleted: id }, null, 2)}\n`);
}

async function synthesize({ model, voice, text, style, scriptName, styleName, directory }) {
  const startedAt = new Date();
  const started = performance.now();
  const response = await geminiRequest('/interactions', {
    method: 'POST',
    body: buildTTSRequest({ model, voice, text, style }),
  });
  const elapsedMilliseconds = Math.round(performance.now() - started);
  const { audio, mimeType } = audioBlockFromResponse(response);
  const wav = wavMetadata(audio);
  const baseName = [model, voice, scriptName, styleName].map(safeFileSegment).join('__');
  const file = path.join(directory, `${baseName}.wav`);
  await writeFile(file, audio, { flag: 'wx' });
  return {
    model,
    voice,
    script: scriptName,
    stylePreset: styleName,
    text,
    style,
    generatedAt: startedAt.toISOString(),
    file,
    mimeType,
    byteLength: audio.length,
    sha256: sha256(audio),
    elapsedMilliseconds,
    wav,
    realtimeFactor: Number((elapsedMilliseconds / wav.durationMilliseconds).toFixed(3)),
  };
}

async function synthesizeStream({ model, voice, text, style, scriptName, styleName, directory }) {
  const body = buildTTSRequest({ model, voice, text, style });
  body.response_format = { type: 'audio', mime_type: 'audio/l16', sample_rate: 24_000 };
  body.stream = true;
  const startedAt = new Date();
  const started = performance.now();
  const response = await authenticatedFetch('/interactions', { method: 'POST', body });
  if (!response.body) throw new Error('Gemini streaming response had no body');
  const chunks = [];
  const arrivalTimes = [];
  for await (const event of serverSentEvents(response.body)) {
    if (event?.event_type !== 'step.delta' || event?.delta?.type !== 'audio' || typeof event.delta.data !== 'string') continue;
    const chunk = Buffer.from(event.delta.data, 'base64');
    if (!chunk.length) continue;
    chunks.push(chunk);
    arrivalTimes.push(performance.now() - started);
  }
  if (!chunks.length) throw new Error('Gemini stream completed without audio chunks');
  const totalElapsedMilliseconds = Math.round(performance.now() - started);
  const pcm = Buffer.concat(chunks);
  const audio = pcm16MonoWav(pcm);
  const wav = wavMetadata(audio);
  const intervals = arrivalTimes.slice(1).map((value, index) => value - arrivalTimes[index]);
  const chunkSizes = chunks.map(chunk => chunk.length);
  const baseName = [model, voice, scriptName, styleName, 'stream'].map(safeFileSegment).join('__');
  const file = path.join(directory, `${baseName}.wav`);
  await writeFile(file, audio, { flag: 'wx' });
  return {
    model,
    voice,
    script: scriptName,
    stylePreset: styleName,
    text,
    style,
    mode: 'stream',
    generatedAt: startedAt.toISOString(),
    file,
    sourceMimeType: 'audio/l16',
    byteLength: audio.length,
    pcmByteLength: pcm.length,
    sha256: sha256(audio),
    firstAudioLatencyMilliseconds: Math.round(arrivalTimes[0]),
    totalElapsedMilliseconds,
    wav,
    realtimeFactor: Number((totalElapsedMilliseconds / wav.durationMilliseconds).toFixed(3)),
    chunks: {
      count: chunks.length,
      bytesP50: Math.round(percentile(chunkSizes, 0.5)),
      bytesP95: Math.round(percentile(chunkSizes, 0.95)),
      intervalMillisecondsP50: intervals.length ? Math.round(percentile(intervals, 0.5)) : null,
      intervalMillisecondsP95: intervals.length ? Math.round(percentile(intervals, 0.95)) : null,
    },
  };
}

async function geminiRequest(resource, { method = 'GET', body, allowEmpty = false } = {}) {
  const response = await authenticatedFetch(resource, { method, body });
  const responseText = await response.text();
  if (!responseText.trim()) return allowEmpty ? {} : (() => { throw new Error('Gemini returned an empty response'); })();
  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error('Gemini returned a non-JSON response');
  }
}

async function authenticatedFetch(resource, { method = 'GET', body } = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to the ignored .env file.');
  const response = await fetch(`${API_ROOT}${resource}`, {
    method,
    headers: {
      'x-goog-api-key': apiKey,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Gemini ${response.status}: ${boundedUpstreamMessage(responseText)}`);
  }
  return response;
}

async function outputDirectory(value) {
  const directory = value ? path.resolve(value) : path.join(DEFAULT_OUTPUT_ROOT, timestamp());
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeManifest(directory, samples) {
  const manifest = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    evaluationReminder: 'Compare naturalness, intelligibility, identity, pronunciation, first-audio latency, interruptions, and route behavior separately.',
    samples,
  };
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseOptions(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [rawName, inlineValue] = argument.slice(2).split('=', 2);
    const name = rawName.trim();
    if (!name) throw new Error('Empty option name');
    if (inlineValue !== undefined) {
      result[name] = inlineValue;
    } else if (arguments_[index + 1] && !arguments_[index + 1].startsWith('--')) {
      result[name] = arguments_[index + 1];
      index += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

function normalizedModel(value) {
  const aliases = { flash: GEMINI_TTS_MODELS[0], lite: GEMINI_TTS_MODELS[1] };
  const model = aliases[value] ?? value ?? GEMINI_TTS_MODELS[1];
  if (!GEMINI_TTS_MODELS.includes(model)) throw new Error(`model must be flash, lite, or an exact Gemini 3.8 TTS model ID`);
  return model;
}

function appendList(parameters, name, values) {
  values.forEach(value => parameters.append(name, value));
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? String(number) : String(fallback);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function boundedUpstreamMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message ?? parsed?.error?.status ?? 'request failed').slice(0, 500);
  } catch {
    return 'request failed';
  }
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message.replace(/AIza[A-Za-z0-9_-]+/gu, '[redacted-key]') : 'unknown failure';
}

function showHelp() {
  process.stdout.write(`Gemini 3.8 TTS listening lab\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  voices [--language ja-JP] [--gender female] [--pitch high,medium]\n`);
  process.stdout.write(`  sample [--model flash|lite] [--voice Leda] [--script identity] [--style-preset plain]\n`);
  process.stdout.write(`  matrix [--models flash,lite] [--voices Zephyr,Leda,Aoede,Achernar] [--script identity|all]\n`);
  process.stdout.write(`  stream [--model lite] [--voice Leda] [--script identity] [--style-preset plain]\n`);
  process.stdout.write(`  design --store [--preset shannon-bright|shannon-warm|shannon-calm] [--name NAME]\n`);
  process.stdout.write(`  delete --id voice_... --confirm voice_...\n\n`);
  process.stdout.write(`Script presets: ${Object.keys(LAB_SCRIPTS).join(', ')}\n`);
  process.stdout.write(`Style presets: ${Object.keys(STYLE_PRESETS).join(', ')}\n`);
}
