# How Beam works invisibly

Beam is meant to work like the lock icon in a browser. Each agent message
carries a signed note saying who is behind the agent. The receiving runtime
checks it quietly. A person only notices Beam when something is wrong.

## What happens on every message

1. **Send.** The SDK signs the intent frame with the agent's Ed25519 key, as it
   always has. It also attaches (*staples*) the agent's current **trust
   assertion**: a small JSON document that the Beam directory signed. It says
   which organisation and person stand behind the agent, what the agent may do
   (`may`), which key the agent signs with (`agentKey`) and until when all of
   this holds (`expiresAt`).
2. **Cache.** The SDK fetches its own assertion once per lifetime (24 hours by
   default) and renews it before it expires. Beam learns only that the agent
   renewed its proof. It does not learn who the agent writes to.
3. **Receive.** The receiving SDK checks the stapled assertion **offline**
   against the pinned directory key:
   - the directory signature is valid and the assertion has not expired,
   - the assertion is about the sender (`beamId === from`),
   - the message is addressed to this receiver,
   - the message signature matches the `agentKey` the directory signed.

   No call to Beam is made. The result is attached to the message.

```ts
client.on('*', (frame, respond) => {
  if (!frame.trust.verified) {
    console.warn(`Beam: ${frame.trust.reason} for ${frame.trust.address}`)
  }
  // frame.trust = { verified, org, person, may, reason, display, expiresAt, source }
})
```

Developers don't need to do anything. Stapling and verification are on by
default.

## The result

| Field | Meaning |
|---|---|
| `verified` | `true` only if every check passed and the organisation is verified |
| `org` | Organisation and domain, such as `COPPEN GmbH (coppen.de)` |
| `person` | Public role of the responsible person, such as `Prokurist` |
| `may` | Mandate scopes, such as `read`, `schedule.commit`, `file.send` |
| `reason` | `ok`, or why not: `not_stapled`, `bad_signature`, `expired`, `address_mismatch`, `wrong_recipient`, `message_signature_invalid`, `agent_key_mismatch`, `suspended`, … |
| `source` | `stapled` (sent by the agent), `relay` (attached by the directory relay), `online` (fallback lookup) |

`org`, `person` and `may` stay empty unless the directory signature and the
binding to this exact message both hold. A tick means "this is the real COPPEN
agent and it may do X". It does not mean the content of the message is true.

## Functions

- `verifyStapledAssertion(message, assertion, options)`: the offline check
  described above. It returns the result shown above.
- `checkStapledAssertion(address, assertion)`: checks the assertion only,
  offline. It returns the same `AgentCheck` as `verifyAgent()`.
- `verifyAgent(address)` / `verifyAgentTrust(address)`: the online fallback.
  They fetch the assertion from the directory.
- MCP: `beam_verify_agent` accepts an optional `assertion` (and `message`) and
  then verifies offline. It stays read-only.

## Settings

```ts
new BeamClient({
  identity, apiKey, directoryUrl,
  trust: {
    staple: true,              // attach own assertion when sending
    assertionTtlMs: 24 * 3600e3, // requested lifetime; the directory caps it
    verifyIncoming: true,      // set frame.trust on received intents
    onlineFallback: false,     // ask Beam when nothing was stapled
    maxAssertionAgeMs: undefined, // receiver may demand fresher proofs
  },
})
```

The directory issues the longer lifetime only to the agent itself (API key).
It caps the lifetime at `BEAM_TRUST_ASSERTION_MAX_TTL_SECONDS` (default 24 hours).
Anyone else gets the usual 15 minutes.

## Compatibility

- The assertion travels **next to** the frame (`stapledTrust` in the WebSocket
  envelope or the HTTP body), not inside it. Frame bytes, frame signatures and
  frame size limits are unchanged, so older SDKs (TypeScript and Python) ignore
  the staple.
- Older directories drop the staple. Receivers then check the assertion the
  relay already attaches (`source: 'relay'`), offline as well.
- Assertions issued before `agentKey` existed are still accepted when the
  transport supplies the sender key.

## Limits

- A suspended agent stays "verified" until its assertion expires. That is why
  lifetimes are short. Receivers can set `maxAssertionAgeMs` to demand fresher
  proofs.
- The message bus still relays these intents and sees their content. For
  "Beam never sees content", agent messages must use the end-to-end encrypted
  path. That path is the next step and not part of this one.
