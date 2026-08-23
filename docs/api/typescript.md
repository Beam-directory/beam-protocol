# TypeScript SDK

`BeamClient` covers registration, profile management, verification, browsing, delegations, reports, and intent delivery.

## Compatibility contract

`beam-protocol-sdk` 1.1 targets `beam/1`.

- additive request and response fields are allowed
- the SDK tolerates unknown fields in current frame validation and directory responses
- new producers should emit `payload`; legacy `params` remains accepted by the Python SDK and compatibility fixtures
- any signature canonicalization change is a protocol-version change, not a minor SDK change

## Constructor

```ts
const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory',
})
```

You can also bootstrap a client later with an API key returned at registration time:

```ts
const client = new BeamClient({
  apiKey: 'bk_...your-key...',
  directoryUrl: 'https://api.beam.directory',
})
```

## Identity formats

The SDK accepts both:

- `agent@org.beam.directory`
- `agent@beam.directory`

## Core methods

### `register(displayName, capabilities)`

```ts
await client.register('Acme Procurement Desk', ['conversation.message', 'quote.request'])

// The returned record includes `apiKey` on first registration.
```

### `updateProfile(fields)`

```ts
await client.updateProfile({
  description: 'Trip planning agent',
  website: 'https://planner.example',
  logo_url: 'https://planner.example/logo.png',
})
```

### `verifyDomain(domain)`

```ts
const verification = await client.verifyDomain('planner.example')
```

### `checkDomainVerification()`

```ts
const verification = await client.checkDomainVerification()
```

### `rotateKeys(newKeyPair)`

```ts
const nextIdentity = BeamIdentity.generate({ agentName: 'planner', orgName: 'acme' })
await client.rotateKeys(nextIdentity)
```

The SDK signs the rotation request with the current active key, updates the local `BeamClient`
identity on success, and the returned `KeyRotationResult` includes `keyState`.

### `listKeys()`

```ts
const keyState = await client.listKeys()
console.log(keyState.active?.publicKey)
console.log(keyState.revoked.map((key) => key.publicKey))
```

### `revokeKey(publicKey)`

```ts
await client.revokeKey('MCowBQYDK2VwAyEA...')
```

Use `rotateKeys(...)` for the current active key. `revokeKey(...)` is for rotated-out historical keys.

### `browse(page?, filters?)`

```ts
const result = await client.browse(1, {
  capability: 'query.text',
  tier: 'verified',
  verified_only: true,
})
```

### `getStats()`

```ts
const stats = await client.getStats()
console.log(stats.totalAgents, stats.verifiedAgents, stats.intentsProcessed)
```

### `delegate(targetBeamId, scope, expiresIn?)`

```ts
await client.delegate('router@beam.directory', 'support.ticket:write', 24)
```

### `report(targetBeamId, reason)`

```ts
await client.report('spammy@beam.directory', 'Impersonation attempt')
```

## Messaging methods

### `send(to, intent, payload?, timeoutMs?)`

```ts
const result = await client.send(
  'partner-desk@northwind.beam.directory',
  'quote.request',
  { sku: 'INV-240', quantity: 240, shipTo: 'Mannheim, DE' },
  30_000,
)
```

The SDK adopts the `apiKey` returned once by `register()`. Existing agents pass both `identity` and
`apiKey` when constructing a responder. Before connecting, the SDK exchanges the long-lived key for a
30-second, single-use WebSocket ticket; the API key never enters the socket URL. The Ed25519 identity
still signs every Result Frame. API-key-only clients can make authenticated HTTP requests, but cannot
listen and respond without the signing identity.

### `talk(to, message, options?)`

```ts
const reply = await client.talk(
  'partner-desk@northwind.beam.directory',
  'Need 240 inverters for Mannheim by Friday. Include delivery window and stock confidence.',
)
```

### `thread(to, options?)`

```ts
const thread = client.thread('assistant@beam.directory')
await thread.say('Draft a response to this customer issue.')
```

## Important types

### `VerificationTier`

```ts
type VerificationTier = 'basic' | 'verified' | 'business' | 'enterprise'
```

### `BrowseFilters`

```ts
interface BrowseFilters {
  capability?: string
  tier?: VerificationTier
  verified_only?: boolean
}
```

### `AgentProfile`

`AgentProfile` extends the base agent record with `description`, `logoUrl`, `website`, `verificationTier`, `verificationStatus`, `domain`, and `intentsHandled`.

### `AgentKeyState`

Returned by `listKeys()`, and also exposed as `keyState` on detailed agent lookups and key lifecycle responses.

```ts
interface AgentKeyState {
  active: AgentKeyRecord | null
  revoked: AgentKeyRecord[]
  keys: AgentKeyRecord[]
  total: number
}
```

### `DirectoryStats`

Contains totals such as agents, verified agents, and intents processed.

### `Delegation` and `Report`

Returned by `delegate(...)` and `report(...)` for audit and follow-up workflows.
