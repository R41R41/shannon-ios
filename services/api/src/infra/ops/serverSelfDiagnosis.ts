/**
 * The server's description of itself (coordinator task 2026-10-05, taken over from Voyager): which models it
 * resolved, which version of her persona it speaks with, which of her tools are enabled, which revision is
 * deployed, and which integrations are configured. The owner reads it in `GET /v1/ops` (`server`,
 * `docs/ops-contract.md`) and the service log has it once at startup.
 *
 * Names, counts, a hash and booleans only: no credential, endpoint, path or token, and model names only after
 * validation. An integration is `true` or `false`; a model is the name its gateway resolved (the same
 * `createConfigured…` function the route uses, or the live instance the server holds), reported only when it passes
 * `reportableModelName` and otherwise `null`. Some names are not validated where they are configured
 * (`SHANNON_JEV_MODEL`), so this check is the one that holds for every name here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHANNON_ONE_LINE_VOICE, looksSecret, shannonCapabilityPrompt, shannonPersonaPrompt, shannonSuitePrompt } from '@shannon/cognition';
import { configuredAutonomy } from '../../mind/inhibition/autonomyBudget.js';
import { ownerDocumentsEnabled } from '../../mind/action/ownTime/autonomyLoopConfig.js';
import { AUTONOMY_MODEL_PURPOSES, AUTONOMY_ROOM_LOOK_MODEL, autonomyModel, type AutonomyModelPurpose } from '../../mind/action/ownTime/autonomyModels.js';
import { dedicatedAutonomyCredential, resolveAutonomyModel } from '../../mind/action/ownTime/autonomyTextModel.js';
import { createConfiguredElevenSpeechGateway } from '../../elevenSpeech.js';
import { createConfiguredGeminiLiveGateway } from '../../geminiLive.js';
import { createConfiguredGeminiSpeechGateway } from '../../geminiSpeech.js';
import { createConfiguredOpenAITranscriptionGateway } from '../../openaiTranscriptionSession.js';
import { DisabledVoyagerCatalog, type VoyagerCatalog } from '../../integrations/voyager/organizeIntegrations.js';
import { shannonNowOwnerScope } from '../../contracts/shannonNowContract.js';
import { configuredAetherAccess } from '../../integrations/aether/aetherAccess.js';
import { SHANNON_TOOLS, offeredTools, ownToolsEnabled, type ToolAudience, type ToolSurface } from '../../mind/tools/shannonTools.js';

type Environment = Readonly<Record<string, string | undefined>>;

export const SELF_DIAGNOSIS_SCHEMA_VERSION = 1 as const;
/** The file the deployment writes next to the deployed source (the service's working directory). */
export const DEPLOYED_REVISION_FILE = 'DEPLOYED_REVISION';
const PERSONA_HASH_LENGTH = 12;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u;
/** The rule the chat model's name is held to (`validModel` in `chatModelSupport.ts`). */
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,100}$/u;
const LONG_RUN = /[A-Za-z0-9_]{32,}/gu;
const SURFACES: readonly ToolSurface[] = ['text', 'voice', 'autonomy'];
const AUDIENCES: readonly ToolAudience[] = ['owner_alone', 'others'];

export interface ServerSelfDiagnosis {
  schemaVersion: typeof SELF_DIAGNOSIS_SCHEMA_VERSION;
  startedAt: string;
  build: { revision: string | null };
  models: {
    /** Text chat replies. `local-stub` without a model key. */
    text: string | null;
    voice: {
      /** Spoken replies: the same chat model as text. */
      reply: string | null;
      /** The voice turn router (`local-rules` without a key). */
      routing: string | null;
      /** Live transcription of a voice call, per provider the app may ask for; null when not configured. */
      transcription: { gemini: string | null; openai: string | null };
      /** Speech synthesis, per provider; null when not configured. */
      speech: { gemini: string | null; eleven: string | null };
      /** A look through the camera during a voice turn. */
      vision: string | null;
    };
    /** `POST /v1/voice/transcriptions` (recorded voice input). */
    dictation: string | null;
    /** Her own activity: whether it is switched on, and the model each purpose resolves to now (null: no dedicated credential). */
    autonomy: { enabled: boolean; roomLook: string | null } & Record<AutonomyModelPurpose, string | null>;
  };
  persona: { hash: string; algorithm: 'sha256' };
  tools: {
    enabled: boolean;
    /** Tools of the registry that are enabled (`SHANNON_OWN_TOOLS`); 0 when switched off. */
    count: number;
    names: string[];
    /**
     * What each surface offers for each audience, counted from the registry: folder tools only while a PC or Mac is bound
     * (`SHANNON_AUTONOMY_HOST_FOLDERS_JSON` with a `deviceId`); her Minecraft body's tools need a configured body at the
     * time of the turn (`minecraft.request` one in the game), which is not counted here.
     */
    offered: Record<ToolSurface, Record<ToolAudience, number>>;
  };
  integrations: { voyager: boolean; notion: boolean; aetherContext: boolean; aetherProposals: boolean; discordBridge: boolean };
}

export interface SelfDiagnosisSources {
  environment: Environment;
  startedAt: string;
  chatModel: { model: string };
  voiceDecision: { model: string };
  /** The recorded-voice transcriber and the voice look gateway the server holds (null when not configured). */
  dictation: object | null;
  vision: object | null;
  voyagerCatalog: VoyagerCatalog;
  notion: { connected: boolean };
  /** The platform bridge (Discord and the legacy runtime); null when not configured. */
  platformBridge: object | null;
  autonomy: { enabled: boolean; preferences: (scopeKey: string) => readonly { purpose: string; modelId: string }[] };
  /** Defaults to `DEPLOYED_REVISION` in the working directory. */
  revision?: () => string | null;
}

/** The persona text, the suite roles and what she can and cannot do (owner and guest), as one canonical JSON array. */
export function personaHashSource(): string {
  return JSON.stringify([
    ['persona.owner', shannonPersonaPrompt('owner')],
    ['persona.guest', shannonPersonaPrompt('guest')],
    ['suite', shannonSuitePrompt()],
    ['capabilities.owner', shannonCapabilityPrompt('owner')],
    ['capabilities.guest', shannonCapabilityPrompt('guest')],
    ['oneLineVoice', SHANNON_ONE_LINE_VOICE],
  ]);
}

/** The first 12 hex characters of the SHA-256 of `personaHashSource()`: changes whenever any of that text changes. */
export function personaHash(source = personaHashSource()): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, PERSONA_HASH_LENGTH);
}

/** The first word of the file the deployment writes, when it looks like a revision; otherwise null. */
export function deployedRevision(path = resolve(process.cwd(), DEPLOYED_REVISION_FILE)): string | null {
  try {
    const word = readFileSync(path, 'utf8').trim().split(/\s+/u)[0] ?? '';
    return REVISION.test(word) ? word : null;
  } catch {
    return null;
  }
}

/**
 * A model name as it may be shown: it matches the chat model's name rule and is not credential-shaped (the
 * `looksSecret` guard, or an unbroken run of 32 or more letters, digits and `_` holding both a letter and a digit).
 * Anything else, such as a URL or a key pasted into a model variable, is null.
 */
export function reportableModelName(value: unknown): string | null {
  if (typeof value !== 'string' || !MODEL_NAME.test(value) || looksSecret(value)) return null;
  return (value.match(LONG_RUN) ?? []).some(run => /[A-Za-z]/u.test(run) && /[0-9]/u.test(run)) ? null : value;
}

function modelOf(gateway: unknown): string | null {
  return reportableModelName(gateway && typeof gateway === 'object' ? (gateway as { model?: unknown }).model : undefined);
}

function present(environment: Environment, name: string): boolean {
  return Boolean(environment[name]?.trim());
}

function toolSummary(environment: Environment): ServerSelfDiagnosis['tools'] {
  const enabled = ownToolsEnabled(environment);
  // Her Aether tools exist on this server only while its Aether client is configured (address and token); without it the
  // summary is what it was before Aether access.
  const aether = configuredAetherAccess(environment) !== null;
  // The owner's documents in her own time exist only with Aether and SHANNON_AUTONOMY_OWNER_DOCUMENTS=on (ADR-0007).
  const here = (tool: { name: string; domain: string }) => tool.domain === 'owner_documents_read' ? aether && ownerDocumentsEnabled(environment) : aether || !tool.name.startsWith('aether');
  // Her folder's tools are offered only while a PC or Mac is bound to it (`ShannonToolRunner.offered`), as the API reads it.
  const bound = Object.keys(configuredAutonomy(environment).places.hostDevices ?? {}).length > 0;
  const offeredHere = (tool: { name: string; domain: string }) => here(tool) && (tool.domain !== 'host_folder' || bound);
  const offered = Object.fromEntries(SURFACES.map(surface => [surface, Object.fromEntries(AUDIENCES.map(audience => [
    audience, enabled ? offeredTools(surface, audience, offeredHere).length : 0,
  ]))])) as ServerSelfDiagnosis['tools']['offered'];
  const names = enabled ? SHANNON_TOOLS.filter(here).map(tool => tool.name) : [];
  return { enabled, count: names.length, names, offered };
}

/**
 * Everything that does not change while the process runs is resolved once, here. The models of her own activity are
 * resolved on every read, because the owner may change her model preferences while the server runs.
 */
export function createServerSelfDiagnosis(sources: SelfDiagnosisSources) {
  const environment = sources.environment;
  const ownerScopeKey = shannonNowOwnerScope(environment);
  const credentials = { google: dedicatedAutonomyCredential('google', environment) !== null, openai: dedicatedAutonomyCredential('openai', environment) !== null };
  const canUse = (id: string) => { const model = autonomyModel(id); return model !== null && credentials[model.provider]; };
  const fixed = {
    schemaVersion: SELF_DIAGNOSIS_SCHEMA_VERSION,
    startedAt: sources.startedAt,
    build: { revision: (sources.revision ?? (() => deployedRevision()))() },
    voice: {
      reply: modelOf(sources.chatModel),
      routing: modelOf(sources.voiceDecision),
      transcription: { gemini: modelOf(createConfiguredGeminiLiveGateway(environment)), openai: modelOf(createConfiguredOpenAITranscriptionGateway(environment)) },
      speech: { gemini: modelOf(createConfiguredGeminiSpeechGateway(environment)), eleven: modelOf(createConfiguredElevenSpeechGateway(environment)) },
      vision: modelOf(sources.vision),
    },
    persona: { hash: personaHash(), algorithm: 'sha256' as const },
    tools: toolSummary(environment),
    integrations: {
      voyager: !(sources.voyagerCatalog instanceof DisabledVoyagerCatalog),
      notion: sources.notion.connected === true,
      aetherContext: present(environment, 'SHANNON_AETHER_CONTEXT_FILE'),
      aetherProposals: present(environment, 'SHANNON_AETHER_PROPOSAL_DIR'),
      discordBridge: sources.platformBridge !== null,
    },
  };

  function autonomyModels(): ServerSelfDiagnosis['models']['autonomy'] {
    let preferences: readonly { purpose: string; modelId: string }[] = [];
    try { preferences = sources.autonomy.preferences(ownerScopeKey); } catch { /* the defaults then */ }
    const purposes = Object.fromEntries(AUTONOMY_MODEL_PURPOSES.map(purpose => [purpose.id, resolveAutonomyModel(purpose.id, preferences, canUse)]));
    return {
      enabled: sources.autonomy.enabled,
      ...(purposes as Record<AutonomyModelPurpose, string | null>),
      roomLook: canUse(AUTONOMY_ROOM_LOOK_MODEL) ? AUTONOMY_ROOM_LOOK_MODEL : null,
    };
  }

  function read(): ServerSelfDiagnosis {
    return {
      schemaVersion: fixed.schemaVersion,
      startedAt: fixed.startedAt,
      build: { ...fixed.build },
      models: {
        text: modelOf(sources.chatModel),
        voice: {
          ...fixed.voice,
          transcription: { ...fixed.voice.transcription },
          speech: { ...fixed.voice.speech },
        },
        dictation: modelOf(sources.dictation),
        autonomy: autonomyModels(),
      },
      persona: { ...fixed.persona },
      tools: { ...fixed.tools, names: [...fixed.tools.names], offered: structuredClone(fixed.tools.offered) },
      integrations: { ...fixed.integrations },
    };
  }

  return {
    read,
    /** Only the owner's scope reads it; any other scope gets nothing. */
    forScope(scopeKey: string | null | undefined): ServerSelfDiagnosis | null {
      return scopeKey === ownerScopeKey ? read() : null;
    },
    /** The one line the service log gets at startup. */
    startupLine(): string {
      return `Shannon self-diagnosis ${JSON.stringify(read())}`;
    },
  };
}

export type ServerSelfDiagnosisReader = ReturnType<typeof createServerSelfDiagnosis>;
