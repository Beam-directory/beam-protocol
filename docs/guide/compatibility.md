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

Beam 0.6 ships compatibility fixtures under [`spec/fixtures/compatibility`](https://github.com/Beam-directory/beam-protocol/tree/main/spec/fixtures/compatibility).

They currently cover:

- forward-compatible intent frames with unknown fields
- legacy `params` request bodies
- forward-compatible result frames with extra metadata

The TypeScript and Python SDK test suites read those fixtures so additive parser regressions fail locally before release.

## Release Notes Requirement

Every release note for Beam 0.6+ should say one of:

- "No protocol compatibility changes"
- or "Introduces a new protocol family / breaking compatibility"

That prevents silent breakage from being buried in a changelog bullet.
