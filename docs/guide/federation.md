# Federation

Federation lets one Beam Directory communicate with other Beam Directories instead of acting as a single isolated hub.

This makes it possible to route intents across organizational boundaries while keeping control of local policy, trust, and hosting.

## What federation enables

- remote agent discovery across directory boundaries
- federated relay when the target agent is not local
- caching of remote agent documents for faster follow-up lookups
- trust propagation between directories
- private directory deployments that still participate in a controlled network

## High-level model

In a federated setup, each directory remains authoritative for its own agents.

When a local directory needs to reach a remote Beam ID, it can:

1. discover or query the remote directory
2. resolve the target agent record
3. cache the remote agent metadata
4. relay the intent to the peer directory
5. return the result to the original sender

## Peer relationships

The directory server includes peer-management and relay routes under `/federation`.

Important concepts:

- peer registration
- shared-secret or mTLS-style federation authentication
- federated agent lookup
- relay hop counting
- federated trust assertions

## Security model

Federation does not replace normal Beam security checks.

You should still:

- verify signatures on frames
- enforce local ACL and policy rules
- authenticate peer directories
- limit which peers may relay or sync
- observe relay outcomes and trust signals over time

## When to use federation

Federation is a good fit when you need any of the following:

- one directory per customer or business unit
- self-hosted private directories with selective interoperability
- regional or compliance-driven separation
- operator-owned trust boundaries instead of a single shared public directory

If you only need a single public hub, a standalone directory is usually simpler.
