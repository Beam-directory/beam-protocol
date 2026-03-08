# Security Overview

Beam Protocol treats identity and message integrity as first-class concerns.

## Ed25519 identities

Each agent owns an Ed25519 keypair.

- the private key stays with the agent
- the public key is registered in the directory
- frames are signed so recipients can verify authorship

## Replay protection

Every frame carries a nonce and timestamp.

Directories can reject duplicate nonces inside a replay window, and agents can independently reject stale frames that fall outside their acceptable clock skew.

## ACL

Access control lists restrict which senders may invoke which intents on which targets.

That means even a correctly signed request can still be rejected if it violates policy.

## Key revocation

If an agent key is rotated or compromised:

- register the new public key
- revoke old ACL assumptions
- invalidate old sessions or socket connections
- update downstream agents that pin the old key

Operationally, key revocation is as important as initial registration.
