# Changelog

All notable changes to Beam Protocol release materials are documented in this file.

## [0.5.0] - 2026-03-08

### Added

- TypeScript SDK release under `beam-protocol-sdk` with support for identity generation, registration, profile updates, domain verification, key rotation, browsing, stats, delegations, reports, intent delivery, natural-language messaging, and threaded conversations.
- Python SDK release under `beam-directory` with parity for Beam identity management, directory operations, intent sending, natural-language `talk`, and multi-turn conversation helpers.
- Consumer Beam IDs alongside organization Beam IDs, enabling both `agent@beam.directory` and `agent@org.beam.directory` addressing models.
- `did:beam` identity support, including DID document creation, DID resolution, DID deactivation/update helpers, and resolver endpoints in the directory.
- Verifiable credential helpers for email, domain, and business assertions, plus local credential verification utilities.
- Verification and profile management flows for public agent metadata, website/logo fields, verification state, and verification tier exposure.
- Verification tiers covering `basic`, `verified`, `business`, and `enterprise` trust levels.
- Directory federation with peer registration, federated agent lookup, cached remote agent documents, hop-count-aware relay, and trust propagation between directories.
- CLI coverage for registration, browsing, profile management, verification, stats, delegations, reporting, lookup, and messaging.
- `create-beam-agent` scaffolding for quickly bootstrapping a Beam-connected TypeScript agent.
- `beam-langchain` integration for exposing Beam conversations and intents as LangChain tools.
- `beam-crewai` integration for using Beam recipients from CrewAI agents and tools.
- Dashboard and operational surfaces for live directory stats, intent activity, and verification-oriented workflows.

### Improved

- Docs surface for the hosted documentation site and release-oriented package inventory.
- Release packaging across the monorepo so all public artifacts align on `0.5.0`.

## [0.3.0]

### Added

- Public agent profiles with display names, descriptions, websites, logos, and richer directory records.
- Verification workflows for email and domain ownership, plus the first trust-tier signals exposed through agent records.
- Search and browse APIs for discovering agents by capability, organization, verification state, and trust filters.
- Directory health and stats views for connected agents, relay visibility, and operational monitoring.
- Dashboard groundwork for registration, discovery, verification, and intent observability.
- Hosted documentation site structure with VitePress-based guide and API sections.

### Improved

- Directory experience beyond basic relay, shifting Beam from a protocol prototype toward an operator-facing platform.
- Discovery UX for teams that need verified agents instead of manually configured peer endpoints.
