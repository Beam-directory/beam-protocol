# Beam 0.6 Compatibility

Beam 0.6 defines one compatibility contract across the protocol, directory, CLI, TypeScript SDK, and Python SDK:

```text
Protocol family: beam/1
Current frame version: v = "1"
```

If you stay inside that contract, minor releases must remain interoperable.

## The Rules

### 1. Additive changes are allowed

You may add:

- optional top-level fields
- optional payload fields
- optional response fields
- new intent types
- new observability metadata

Existing receivers must ignore fields they do not understand.

### 2. Breaking required-field changes are not allowed in `beam/1`

The following require a new protocol version:

- removing an existing field
- changing the meaning of an existing field
- making a formerly optional field mandatory
- changing signature canonicalization
- changing nonce or timestamp validation semantics in a way that rejects previously valid traffic

### 3. `payload` is canonical

For intent frames, `payload` is the canonical request body on the wire.

Current SDKs still accept `params` as a legacy alias for backward compatibility. New producers should emit `payload`.

### 4. Unknown fields must be ignored

`beam/1` receivers must ignore unknown fields at:

- the top level of intent frames
- the top level of result frames
- nested payload objects unless the application-level intent schema says otherwise

Ignoring unknown fields is what makes additive evolution safe.

### 5. Signature inputs cannot drift silently

Within `beam/1`, the signed content for frames is fixed. If you need a different canonicalization or signing rule, that is a version change, not a patch release.

### 6. CLI and SDK releases must track server compatibility explicitly

- `beam-protocol-cli 0.6.x` targets `beam/1`
- `beam-protocol-sdk 0.6.x` targets `beam/1`
- `beam-directory 0.6.x` targets `beam/1`

Feature additions may land in minor releases, but protocol compatibility must remain intact.

## Schema Evolution Checklist

Before shipping a new field or endpoint behavior:

1. Is the change additive?
2. Will old clients continue to parse the response?
3. Will old servers continue to accept the request?
4. Does the signature input remain byte-for-byte compatible?
5. Do compatibility fixtures and tests still pass?

If any answer is "no", you are not making a minor change anymore.

## Fixtures and Tests

Beam 0.6 ships two compatibility fixture layers under [`spec/fixtures/compatibility`](https://github.com/Beam-directory/beam-protocol/tree/main/spec/fixtures/compatibility):

- parser fixtures in the root folder for additive decode behavior such as unknown-field tolerance and legacy `params`
- archived signed release fixtures in [`spec/fixtures/compatibility/releases`](https://github.com/Beam-directory/beam-protocol/tree/main/spec/fixtures/compatibility/releases) for `v0.6.0` and `v0.6.1`

The archived fixtures pin real signed frames from released `beam/1` behavior:

- `v0.6.0` quote request and signed quote result
- `v0.6.1` async finance preflight intent and accepted acknowledgement result

The TypeScript and Python SDK test suites consume both layers. That means CI now fails on:

- additive parser regressions
- signature verification drift
- replay-window handling drift for archived intent frames
- result-frame validation changes that would reject already released `beam/1` traffic

## Release Notes Requirement

Every release note for Beam 0.6+ should say one of:

- "No protocol compatibility changes"
- or "Introduces a new protocol family / breaking compatibility"

That prevents silent breakage from being buried in a changelog bullet.
