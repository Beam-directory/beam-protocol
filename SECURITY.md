# Security policy

## Reporting a vulnerability

Email **security@beam.directory**. Please do not open a public GitHub issue, discussion or pull request for a vulnerability.

Include what you can of the following:

- the affected package, service or URL (for example `packages/directory`, `api.beam.directory`, or the MCP server);
- the version or commit;
- steps to reproduce, or a proof of concept;
- the impact you expect;
- whether the issue is already public.

Do not include real private keys, API keys or personal data in the report. If you need to show a key or token, revoke it first or use a test identity.

## Scope

This repository contains the directory API, the SDKs, the CLI, the MCP server, the message bus, the dashboard and the beam.directory website. Reports about any of them, and about the hosted services at `beam.directory`, `api.beam.directory` and `docs.beam.directory`, are in scope.

## Security model

How Beam handles identity, signing, replay protection, encryption and its limits is described in the docs:

- [Security overview](https://docs.beam.directory/security/overview)
- [Threat model](https://docs.beam.directory/security/threat-model)
- [Beam Shield](https://docs.beam.directory/security/beam-shield)
