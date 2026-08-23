# Trust and identity assurance

Beam treats trust as a set of independently verifiable claims, not as a badge
that can be purchased. The protocol proves who signed a message; the control
plane decides whether that identity may act for a human or organization.

## Principals

Production deployments must keep these principals separate:

- **Human:** the accountable operator or approver.
- **Organization:** the legal or contractual counterparty.
- **Agent:** the stable Beam/A2A identity that signs messages.
- **Runtime:** the device, host, or service currently executing the agent.
- **Delegation:** the explicit, scoped, expiring authority connecting them.

A Beam ID is an address and signing identity. It is not by itself proof of a
human identity, employment relationship, company authority, or permission to
take an external action.

## Assurance ladder

| Level | Evidence | Suitable use |
| --- | --- | --- |
| Registered | Agent public key and API-key possession | Discovery and low-risk messages |
| Domain controlled | DNS challenge completed | Product/team identity and constrained handoffs |
| Business reviewed | Registry evidence, domain control, independent approval | Cross-company operational workflows |
| Enterprise governed | Business review, SSO/SCIM, contractual owner, security controls | Regulated or high-impact workflows |

Payment and subscription state are not assurance evidence.

## KYB and KYC

Beam's directory implements KYB as a review workflow. Registry formatting alone
must remain `pending`; even an authoritative registry match still requires
proof of organization control and an independent decision. The reviewer and
evidence reference are written to the audit log.

Personal KYC should be performed by a specialized identity provider when a
workflow's risk requires it. Beam should retain the provider, assurance level,
subject reference, outcome, timestamps, and revocation status—not raw passports,
selfies, or other source documents.

## Authorization rule

Every external action must evaluate all of the following:

1. Is the connection authenticated as the claimed agent?
2. Is the message signature valid and bound to sender, recipient, nonce, and time?
3. Is the agent currently delegated by the relevant human or organization?
4. Does the workspace policy allow this intent, partner, and data class?
5. Is human approval required, and was it granted by an independent approver?
6. Can the outcome be reconstructed from immutable audit evidence?

Failure or missing evidence at any step is a denial, not an implicit downgrade.

## Privacy baseline

- Encrypt sensitive content in transit and at rest; prefer end-to-end encryption for cross-company payloads.
- Keep identity evidence separate from message content.
- Minimize stored attributes and define retention and deletion schedules.
- Never put API keys, private keys, session tokens, or raw KYC documents in logs.
- Expose verification status publicly only at a coarse level; detailed evidence is restricted to the subject and authorized reviewers.

## Interoperability

Beam verification is an overlay, not a replacement for A2A or MCP. External
Agent Cards and identities may be imported, but local policy must record which
issuer asserted each claim and must not silently translate an untrusted remote
badge into Beam business or enterprise assurance.

Federated agent documents therefore resolve fail-closed. Beam retains the
peer's coarse claim under `remoteAssurance`, labels it
`federated-untrusted`, and exposes only `basic`/`unverified` as the effective
local tier. A future trust agreement may recognize selected issuers, but that
must be an explicit operator policy; receiving a peer document or a propagated
trust score is never sufficient by itself.
