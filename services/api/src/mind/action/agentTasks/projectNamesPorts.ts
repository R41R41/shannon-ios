/**
 * The project-names window of the agent-tasks action (Syzygy ADR-0008 §6 and §10; stage 3, S2): the normal forms of a project's key
 * and its GitHub repository, moved out of the provisioning store, for the Agent Host integration and the HTTP routes.
 */
export { normalizedAgentProjectKey, normalizedGitHubRepositoryURL } from './agentProjectNames.js';
