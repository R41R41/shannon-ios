/** Observation exposes owner-only projections; Shannon cannot change this boundary without owner approval. */
export const OBSERVER_CORE_PATHS = Object.freeze([
  'services/api/src/contracts/observerContract.ts',
  'services/api/src/infra/observer/',
  'services/api/src/wiring/serverObserverWiring.ts',
  'services/api/src/surfaces/voice/voiceObservation.ts',
  'apps/ios/Sources/ShannonAppCore/API/ShannonAPIClient+Observer.swift',
  'apps/ios/Sources/ShannonAppCore/Features/Voice/ShannonVoiceObservation.swift',
  'docs/signal-observer-contract.md',
]);
