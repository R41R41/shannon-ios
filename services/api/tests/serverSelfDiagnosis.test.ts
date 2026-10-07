import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shannonCapabilityPrompt, shannonPersonaPrompt } from '@shannon/cognition';
import { createConfiguredChatModel } from '../src/infra/models/chatModel.js';
import { configuredNotionSource } from '../src/integrations/notion/notionSource.js';
import { SQLiteOpsStore } from '../src/infra/ops/store/opsStore.js';
import { createConfiguredVoyagerCatalog } from '../src/integrations/voyager/organize.js';
import { configuredPlatformBridge } from '../src/surfaces/platform/platformBridge.js';
import { createOpsRoute, OPS_READ_PATH } from '../src/infra/ops/serverOpsRoutes.js';
import {
  createServerSelfDiagnosis, deployedRevision, personaHash, personaHashSource, reportableModelName, type SelfDiagnosisSources,
} from '../src/infra/ops/serverSelfDiagnosis.js';
import { SHANNON_TOOLS, offeredTools } from '../src/mind/tools/shannonTools.js';
import { createConfiguredVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { createConfiguredVoiceTranscriber } from '../src/infra/models/voiceTranscription.js';
import { createConfiguredVoiceVisionGateway } from '../src/surfaces/voice/voiceVision.js';
import { readApiSource } from './support/sources.js';

const START = '2026-10-05T12:00:00.000Z';
const DEVICE_TOKEN = 'device-token-of-the-owner';
const OTHER_TOKEN = 'device-token-of-someone-else';

/** Every credential, endpoint and path the server reads, filled with fake values that must never come back. */
const SECRETS = Object.freeze({
  OPENAI_API_KEY: 'sk-fake-openai-conversation-key-0001',
  GEMINI_API_KEY: 'fake-gemini-conversation-key-0002',
  ELEVENLABS_API_KEY: 'fake-eleven-key-0003',
  SHANNON_ELEVEN_TTS_VOICE_ID: 'fakeElevenVoice0004',
  TYPESAFE_API_KEY: 'fake-typesafe-jev-key-0005',
  SHANNON_AUTONOMY_GEMINI_API_KEY: 'fake-autonomy-gemini-key-0006',
  SHANNON_AUTONOMY_OPENAI_API_KEY: 'sk-fake-autonomy-openai-key-0007',
  SHANNON_NOTION_TOKEN: 'ntn_fake_notion_token_000000000008',
  SHANNON_NOTION_ROOT_PAGE_IDS: 'fakeroot0009fakeroot0009fakeroot',
  SHANNON_VOYAGER_INTEGRATION_URL: 'https://voyager.example.invalid/fake0010/task-changes:apply',
  SHANNON_VOYAGER_INTEGRATION_TOKEN: 'fake-voyager-token-0011',
  SHANNON_VOYAGER_WORKSPACE_ID: 'fake-workspace-0012',
  SHANNON_AETHER_CONTEXT_FILE: '/fake/aether/context0013.json',
  SHANNON_AETHER_PROPOSAL_DIR: '/fake/aether/proposals0014',
  SHANNON_PLATFORM_BRIDGE_TOKEN: 'fake-platform-bridge-token-0015-0000000000',
  SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'bridge-scope-0016',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationId: 'fake-conversation-0017', ownerUserId: 'fake-user-0018', title: 'fake-title-0019' }]),
  SHANNON_API_TOKEN: 'fake-fixed-api-token-0020-000000000000',
  SHANNON_AUTH_PEPPER: 'fake-auth-pepper-0021-0000000000000000',
  SHANNON_AGENT_HOST_TOKEN: 'fake-agent-host-token-0022-0000000000',
  SHANNON_APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----fake0023',
  SHANNON_GEMINI_TTS_ENDPOINT: 'https://tts.example.invalid/fake0024',
  SHANNON_VOICE_ROUTER_ENDPOINT: 'https://router.example.invalid/fake0025',
});

/** Models set away from their defaults, so a default can never pass for the resolved name. */
const MODELS = Object.freeze({
  SHANNON_LLM_MODEL: 'gpt-5.6-terra',
  SHANNON_JEV_MODEL: 'jev-2026-10',
  SHANNON_GEMINI_TTS_MODEL: 'gemini-3.8-flash-tts',
  SHANNON_VOICE_CALL_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
  SHANNON_VOICE_TRANSCRIPTION_MODEL: 'whisper-1',
  SHANNON_VISION_MODEL: 'gpt-5.6-sol',
});

const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sources(environment: Record<string, string>, overrides: Partial<SelfDiagnosisSources> = {}): SelfDiagnosisSources {
  return {
    environment, startedAt: START,
    chatModel: createConfiguredChatModel(environment),
    voiceDecision: createConfiguredVoiceDecisionGateway(environment),
    dictation: createConfiguredVoiceTranscriber(environment),
    vision: createConfiguredVoiceVisionGateway(environment),
    voyagerCatalog: createConfiguredVoyagerCatalog(environment),
    notion: configuredNotionSource(environment),
    platformBridge: configuredPlatformBridge(environment),
    autonomy: { enabled: environment.SHANNON_AUTONOMY_ENABLED === 'true', preferences: () => [] },
    revision: () => '5943c29',
    ...overrides,
  };
}

/** The registry as a server has it while her own time may not read the owner's documents (SHANNON_AUTONOMY_OWNER_DOCUMENTS unset). */
const REGISTRY = SHANNON_TOOLS.filter(tool => tool.domain !== 'owner_documents_read');
const BEFORE_AETHER = REGISTRY.filter(tool => !tool.name.startsWith('aether'));
/** A PC and a Mac bound to her folder, as in production (2026-10-06): her folder's tools are counted only with one bound. */
const HOSTS = JSON.stringify({ 'owner-windows': { deviceId: '0123456789abcdef' }, 'owner-mac': { deviceId: 'fedcba9876543210' } });
const configured = () => ({ ...SECRETS, ...MODELS, SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_AUTONOMY_HOST_FOLDERS_JSON: HOSTS });

describe('the self-diagnosis', () => {
  it('has the documented shape, with the models the configuration resolved', () => {
    const diagnosis = createServerSelfDiagnosis(sources(configured())).read();
    expect(diagnosis).toEqual({
      schemaVersion: 1,
      startedAt: START,
      build: { revision: '5943c29' },
      models: {
        text: 'gpt-5.6-terra',
        voice: {
          reply: 'gpt-5.6-terra',
          routing: 'jev-2026-10',
          transcription: { gemini: 'gemini-3.5-transcribe-live', openai: 'gpt-4o-transcribe' },
          speech: { gemini: 'gemini-3.8-flash-tts', eleven: 'eleven_v4_turbo' },
          vision: 'gpt-5.6-sol',
        },
        dictation: 'whisper-1',
        autonomy: {
          enabled: true, prose: 'gemini-3.8-flash', research_reading: 'gpt-5.6-luna', planning: 'gpt-5.6-luna', critique: 'gpt-5.6-terra',
          roomLook: 'gemini-3.8-flash',
        },
      },
      persona: { hash: personaHash(), algorithm: 'sha256' },
      // Without the Aether client (no address) the summary is what it was before Aether access: no Aether tool, none with others.
      tools: {
        enabled: true, count: BEFORE_AETHER.length, names: BEFORE_AETHER.map(tool => tool.name),
        offered: {
          text: { owner_alone: BEFORE_AETHER.length, others: 0 },
          voice: { owner_alone: BEFORE_AETHER.length, others: 0 },
          // Her Minecraft body's tools exist only in conversations (`shannonTools.ts`, `conversationTool`), never in her own time.
          autonomy: { owner_alone: BEFORE_AETHER.filter(tool => tool.surfaces.includes('autonomy')).length, others: 0 },
        },
      },
      integrations: { voyager: true, notion: true, aetherContext: true, aetherProposals: true, discordBridge: true },
    });
  });

  it('counts her Aether tools only while the Aether client is configured', () => {
    const tools = createServerSelfDiagnosis(sources({ ...configured(), SHANNON_AETHER_API_URL: 'http://127.0.0.1:3007', SHANNON_AETHER_SHANNON_TOKEN: 'fake-token-0015' })).read().tools;
    expect(tools.names).toEqual(REGISTRY.map(tool => tool.name));
    expect(tools.offered.text).toEqual({ owner_alone: REGISTRY.length, others: 3 });
    // The owner's documents in her own time (ADR-0007) are counted only with Aether and SHANNON_AUTONOMY_OWNER_DOCUMENTS=on, on her own time only.
    const aether = { ...configured(), SHANNON_AETHER_API_URL: 'http://127.0.0.1:3007', SHANNON_AETHER_SHANNON_TOKEN: 'fake-token-0015' };
    for (const flag of ['off', 'On', 'yes']) expect(createServerSelfDiagnosis(sources({ ...aether, SHANNON_AUTONOMY_OWNER_DOCUMENTS: flag })).read().tools).toEqual(tools);
    const on = createServerSelfDiagnosis(sources({ ...aether, SHANNON_AUTONOMY_OWNER_DOCUMENTS: 'on' })).read().tools;
    expect(on.names).toEqual(SHANNON_TOOLS.map(tool => tool.name));
    expect(on.offered).toEqual({ ...tools.offered, autonomy: { ...tools.offered.autonomy, owner_alone: tools.offered.autonomy.owner_alone + 2 } });
    expect(createServerSelfDiagnosis(sources({ ...configured(), SHANNON_AUTONOMY_OWNER_DOCUMENTS: 'on' })).read().tools.names.some(name => name.startsWith('ownerDocs.'))).toBe(false);
    // An address without TLS to another machine is not a client.
    expect(createServerSelfDiagnosis(sources({ ...configured(), SHANNON_AETHER_API_URL: 'http://aether.example.org', SHANNON_AETHER_SHANNON_TOKEN: 'fake-token-0015' })).read().tools.offered.text.others).toBe(0);
  });

  it('says what is not configured as null and false, never as a default model', () => {
    const diagnosis = createServerSelfDiagnosis(sources({}, { revision: () => null })).read();
    expect(diagnosis.build.revision).toBeNull();
    expect(diagnosis.models).toEqual({
      text: 'local-stub',
      voice: { reply: 'local-stub', routing: 'local-rules', transcription: { gemini: null, openai: null }, speech: { gemini: null, eleven: null }, vision: null },
      dictation: null,
      autonomy: { enabled: false, prose: null, research_reading: null, planning: null, critique: null, roomLook: null },
    });
    expect(diagnosis.integrations).toEqual({ voyager: false, notion: false, aetherContext: false, aetherProposals: false, discordBridge: false });
  });

  function expectNoEnvironmentValue(environment: Record<string, string>) {
    const reader = createServerSelfDiagnosis(sources(environment));
    const outputs = [JSON.stringify(reader.read()), reader.startupLine(), JSON.stringify(reader.forScope('owner'))];
    const modelNames = new Set<string>(Object.values(MODELS));
    for (const output of outputs) {
      for (const [name, value] of Object.entries(environment)) {
        if (modelNames.has(value) || value.length < 8) continue;
        expect(output, name).not.toContain(value);
        // Nor a recognisable piece of it.
        expect(output, name).not.toContain(value.slice(0, 12));
      }
      expect(output).not.toMatch(/fake|example\.invalid|PRIVATE KEY|sk-|ntn_/u);
    }
    expect(reader.startupLine().split('\n')).toHaveLength(1);
    return reader.read();
  }

  it('never carries a credential, an endpoint, a path or a token', () => {
    expectNoEnvironmentValue(configured());
  });

  // SHANNON_JEV_MODEL is not validated where it is configured (`JevVoiceDecisionGateway`).
  it.each([
    ['a URL', 'https://jev.example.invalid/fake0026?key=x'],
    ['an API key', 'sk-fakeJevRouterToken0027abcdefghij'],
    ['a long token', 'fakeJevToken0028AbCdEfGhIjKlMnOpQrStUvWx'],
    ['a dotted bot token', 'fakeA0029bcdefghijklmnopqrstu.fakeB0030cd.fakeC0031efghijklmnopqrstuvwxyz0123'],
  ])('reports no routing model when SHANNON_JEV_MODEL holds %s', (_kind, value) => {
    const diagnosis = expectNoEnvironmentValue({ ...configured(), SHANNON_JEV_MODEL: value });
    expect(diagnosis.models.voice.routing).toBeNull();
  });

  it('shows a model name only when it passes the chat model name rule and is not credential-shaped', () => {
    for (const name of ['gpt-5.6-luna', 'jev-latest', 'local-rules', 'gemini-3.5-transcribe-live', 'eleven_v4_turbo', 'models:x.1']) {
      expect(reportableModelName(name)).toBe(name);
    }
    for (const value of [undefined, null, 7, '', 'a b', 'https://x.invalid/y', '/path/to/model', 'x'.repeat(101),
      'sk-abcdefghijklmnop0123', 'AKIA0123456789ABCDEF', 'abc0123456789abcdefghijklmnopqrstuv']) {
      expect(reportableModelName(value), String(value)).toBeNull();
    }
  });

  it('counts exactly the tools of the registry, per surface and audience, and none when they are switched off', () => {
    const diagnosis = createServerSelfDiagnosis(sources(configured())).read();
    // Without the Aether client, the registry less her Aether tools.
    expect(diagnosis.tools.count).toBe(BEFORE_AETHER.length);
    expect(diagnosis.tools.names).toEqual(BEFORE_AETHER.map(tool => tool.name));
    expect(new Set(diagnosis.tools.names).size).toBe(diagnosis.tools.count);
    for (const surface of ['text', 'voice', 'autonomy'] as const) {
      for (const audience of ['owner_alone', 'others'] as const) {
        expect(diagnosis.tools.offered[surface][audience]).toBe(offeredTools(surface, audience, tool => !tool.name.startsWith('aether') && tool.domain !== 'owner_documents_read').length);
      }
    }
    // With no PC or Mac bound her folder's tools are named but not offered, as `ShannonToolRunner.offered` decides it.
    const unbound = createServerSelfDiagnosis(sources({ ...configured(), SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '' })).read().tools;
    expect(unbound.names).toEqual(diagnosis.tools.names);
    const folderTools = BEFORE_AETHER.filter(tool => tool.domain === 'host_folder').length;
    expect(folderTools).toBe(8);
    for (const surface of ['text', 'voice', 'autonomy'] as const) {
      expect(unbound.offered[surface]).toEqual({ owner_alone: diagnosis.tools.offered[surface].owner_alone - folderTools, others: diagnosis.tools.offered[surface].others });
    }
    // A folder path without a device binds nothing.
    expect(createServerSelfDiagnosis(sources({ ...configured(), SHANNON_AUTONOMY_HOST_FOLDERS_JSON: JSON.stringify({ 'owner-windows': 'C:\\Shannon' }) })).read().tools).toEqual(unbound);
    const off = createServerSelfDiagnosis(sources({ ...configured(), SHANNON_OWN_TOOLS: 'off' })).read().tools;
    expect(off).toEqual({
      enabled: false, count: 0, names: [],
      offered: { text: { owner_alone: 0, others: 0 }, voice: { owner_alone: 0, others: 0 }, autonomy: { owner_alone: 0, others: 0 } },
    });
  });

  it('resolves her own models from her preference of the owner scope, live, and only for providers with a dedicated key', () => {
    const asked: string[] = [];
    let preferences = [{ purpose: 'prose', modelId: 'gpt-5.6-sol' }];
    const reader = createServerSelfDiagnosis(sources(configured(), {
      autonomy: { enabled: true, preferences: scopeKey => { asked.push(scopeKey); return preferences; } },
    }));
    expect(reader.read().models.autonomy.prose).toBe('gpt-5.6-sol');
    preferences = [];
    expect(reader.read().models.autonomy.prose).toBe('gemini-3.8-flash');
    expect(new Set(asked)).toEqual(new Set(['owner']));
    // Only the conversation keys: her activity has no model, whatever the conversation has.
    const conversationOnly = { ...configured(), SHANNON_AUTONOMY_GEMINI_API_KEY: '', SHANNON_AUTONOMY_OPENAI_API_KEY: '' };
    expect(createServerSelfDiagnosis(sources(conversationOnly)).read().models.autonomy)
      .toEqual({ enabled: true, prose: null, research_reading: null, planning: null, critique: null, roomLook: null });
    // Google only: every purpose falls to the model that provider has.
    const googleOnly = { ...configured(), SHANNON_AUTONOMY_OPENAI_API_KEY: '' };
    expect(createServerSelfDiagnosis(sources(googleOnly)).read().models.autonomy).toMatchObject({ planning: 'gemini-3.8-flash', critique: 'gemini-3.8-flash' });
  });

  it('is for the owner scope only', () => {
    const reader = createServerSelfDiagnosis(sources(configured()));
    expect(reader.forScope('owner')).toEqual(reader.read());
    expect(reader.forScope('someone-else')).toBeNull();
    expect(reader.forScope(null)).toBeNull();
    expect(reader.forScope(undefined)).toBeNull();
    const moved = createServerSelfDiagnosis(sources({ ...configured(), SHANNON_OWNER_SCOPE_KEY: 'rai' }));
    expect(moved.forScope('owner')).toBeNull();
    expect(moved.forScope('rai')).not.toBeNull();
  });
});

describe('the persona hash', () => {
  it('is the first 12 hex characters of the SHA-256 of the persona, suite and capability text', () => {
    const source = personaHashSource();
    expect(personaHash()).toMatch(/^[0-9a-f]{12}$/u);
    expect(personaHash()).toBe(createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12));
    expect(personaHash()).toBe(personaHash());
    for (const text of [shannonPersonaPrompt('owner'), shannonPersonaPrompt('guest'), shannonCapabilityPrompt('owner'), shannonCapabilityPrompt('guest')]) {
      expect(JSON.parse(source).map((entry: [string, string]) => entry[1])).toContain(text);
    }
    expect(personaHash(`${source} `)).not.toBe(personaHash());
  });
});

describe('the deployed revision', () => {
  function file(content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-revision-'));
    directories.push(directory);
    const path = join(directory, 'DEPLOYED_REVISION');
    writeFileSync(path, content);
    return path;
  }

  it('is the first word of DEPLOYED_REVISION, and null when the file is missing or holds something else', () => {
    expect(deployedRevision(file('5943c29\n'))).toBe('5943c29');
    expect(deployedRevision(file('  2505a282007f81f2fe61939728cf6ae6f76d104a 2026-10-05T12:00:00Z\n'))).toBe('2505a282007f81f2fe61939728cf6ae6f76d104a');
    expect(deployedRevision(file(''))).toBeNull();
    expect(deployedRevision(file('<script>'))).toBeNull();
    expect(deployedRevision(join(tmpdir(), 'shannon-no-such-directory', 'DEPLOYED_REVISION'))).toBeNull();
  });
});

describe('GET /v1/ops', () => {
  async function harness(fixedToken = false) {
    const reader = createServerSelfDiagnosis(sources(configured()));
    const route = createOpsRoute({
      store: new SQLiteOpsStore(':memory:'), now: () => START, ingestEnabled: () => true, bridge: null,
      server: scopeKey => reader.forScope(scopeKey),
      device: authorization => authorization === `Bearer ${DEVICE_TOKEN}` ? { scopeKey: fixedToken ? null : 'owner' }
        : authorization === `Bearer ${OTHER_TOKEN}` ? { scopeKey: 'someone-else' } : null,
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      void route(url.pathname, request, response, url.searchParams);
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    return async (token: string | null, query = '') => {
      const response = await fetch(`http://127.0.0.1:${address.port}${OPS_READ_PATH}${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: response.status, text: await response.text() };
    };
  }

  it('gives the owner device the self-diagnosis as `server`, and nobody else', async () => {
    const read = await harness();
    const owner = await read(DEVICE_TOKEN);
    expect(owner.status).toBe(200);
    const body = JSON.parse(owner.text) as Record<string, any>;
    expect(body.server).toMatchObject({ schemaVersion: 1, tools: { count: BEFORE_AETHER.length }, integrations: { voyager: true } });
    for (const value of Object.values(SECRETS)) expect(owner.text).not.toContain(value);
    expect(JSON.parse((await read(OTHER_TOKEN)).text)).not.toHaveProperty('server');
    expect(await read(null)).toMatchObject({ status: 401 });
  });

  it('gives a fixed local token the self-diagnosis only for the owner scope', async () => {
    const read = await harness(true);
    expect(JSON.parse((await read(DEVICE_TOKEN, '?scopeKey=owner')).text)).toHaveProperty('server');
    expect(JSON.parse((await read(DEVICE_TOKEN, '?scopeKey=someone-else')).text)).not.toHaveProperty('server');
  });
});

describe('server.ts', () => {
  const server = readApiSource('server.ts');

  it('logs the same summary once at startup and hands the ops route the owner-only reader', () => {
    expect(server.match(/selfDiagnosis\.startupLine\(\)/gu)).toHaveLength(1);
    // Stage 3 review: the mind's state is added for the owner (`withMindOps`, nothing with stage 3 off), to the same owner-only reader.
    expect(server).toContain('server: scopeKey => withMindOps(selfDiagnosis.forScope(scopeKey), { host: mind?.host ?? null, outbox: persistentStore.memoryOutbox(), now }),');
    expect(server).not.toMatch(/selfDiagnosis\.read\(\)/u);
  });
});

describe('docs/ops-contract.md', () => {
  it('states the field, who reads it, the revision file, the hash and the startup line', () => {
    const document = readFileSync(resolve(import.meta.dirname, '../../../docs/ops-contract.md'), 'utf8');
    for (const word of ["## The server's self-diagnosis", '| `server` |', 'SHANNON_OWNER_SCOPE_KEY', 'DEPLOYED_REVISION', 'personaHashSource()',
      'Shannon self-diagnosis ', '`GET /health` is unchanged', 'tools.offered', 'integrations.discordBridge',
      'No credential, endpoint, path or token; model names only after validation', 'SHANNON_JEV_MODEL', 'read once when the process starts']) expect(document, word).toContain(word);
    expect(document).not.toContain('value of the environment');
  });

  it('is matched by the deploy runbook: the revision is written atomically after the sync and before the restart', () => {
    const runbook = readFileSync(resolve(import.meta.dirname, '../../../docs/self-improvement-runbook.md'), 'utf8');
    const write = runbook.indexOf('mv -f DEPLOYED_REVISION.tmp DEPLOYED_REVISION');
    expect(write).toBeGreaterThan(runbook.indexOf('Deploy only reviewed files'));
    expect(write).toBeLessThan(runbook.indexOf('Restart only affected services'));
    expect(runbook).toContain('after the source sync and before any restart');
  });
});
