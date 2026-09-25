#!/usr/bin/env node

import process from 'node:process';

import { buildVoiceDesignRequest } from './gemini-tts-lab-core.mjs';
import { safeUpstreamError } from './gemini-voice-lab-core.mjs';
import { voiceDesignPresets } from '../tools/gemini-voice-lab/voice-design-presets.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const API_KEY = String(process.env.GEMINI_API_KEY ?? '').trim();
const requestedPreset = argumentValue('--preset');

if (!process.argv.includes('--confirm-billable') || !process.argv.includes('--delete-successes')) {
  throw new Error('This smoke test creates billable stored voices. Pass --confirm-billable --delete-successes.');
}
if (!API_KEY) throw new Error('GEMINI_API_KEY is required');

const presets = requestedPreset
  ? voiceDesignPresets.filter(preset => preset.id === requestedPreset)
  : voiceDesignPresets;
if (!presets.length) throw new Error(`Unknown preset: ${requestedPreset}`);

const results = [];
for (const preset of presets) results.push(await checkPreset(preset));
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (results.some(result => result.status !== 'passed' || result.deleted !== true)) process.exitCode = 1;

async function checkPreset(preset) {
  let voiceId;
  try {
    const response = await request('/voices', {
      method: 'POST',
      body: buildVoiceDesignRequest({
        name: `Smoke ${preset.id}`,
        prompt: preset.prompt,
        language: 'ja-JP',
        gender: 'female',
      }),
    });
    voiceId = typeof response.id === 'string' ? response.id : '';
    if (!/^voice_[A-Za-z0-9_-]+$/u.test(voiceId)) throw new Error('Gemini did not return a valid voice ID');
    await request(`/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', allowEmpty: true });
    return { preset: preset.id, status: 'passed', deleted: true, creationModel: response.model ?? null };
  } catch (error) {
    let deleted = false;
    if (voiceId) {
      try {
        await request(`/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', allowEmpty: true });
        deleted = true;
      } catch {
        process.stderr.write(`Cleanup failed for ${voiceId}\n`);
      }
    }
    return { preset: preset.id, status: 'failed', deleted, error: safeMessage(error) };
  }
}

async function request(resource, { method, body, allowEmpty = false }) {
  const response = await fetch(`${API_ROOT}${resource}`, {
    method,
    headers: {
      'x-goog-api-key': API_KEY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${safeUpstreamError(text)}`);
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new Error('Gemini returned an empty response');
  }
  return JSON.parse(text);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
}
