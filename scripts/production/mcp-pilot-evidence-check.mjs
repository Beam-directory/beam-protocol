import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatDate, formatDateTime, optionalFlag, repoRoot, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const defaultEvidencePath = path.join(repoRoot, 'reports/1.7.0-mcp-pilot-evidence.json')
const REQUIRED_TOOLS = ['beam_prepare_handoff', 'beam_status']
const REQUIRED_ARTIFACTS = [
  'container-e2e',
  'container-sbom',
  'grok-diagnostics',
  'oauth-metadata',
  'redacted-audit',
  'vulnerability-scan',
]
const FORBIDDEN_SECRET_KEYS = /^(?:accessToken|refreshToken|apiKey|privateKey|clientSecret|authorization)$/iu

export function createMcpPilotConfig({ argv = process.argv } = {}) {
  const optional = (name, fallback = null) => {
    if (argv === process.argv) return optionalFlag(name, fallback)
    const index = argv.indexOf(name)
    if (index === -1) return fallback
    const value = argv[index + 1] ?? fallback
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 || trimmed.startsWith('--') ? fallback : trimmed
  }

  return {
    release: optional('--release', '1.7.0'),
    evidencePath: optional('--evidence', defaultEvidencePath),
    outputPath: optional('--output'),
    maxAgeDays: numericValue('--max-age-days', optional('--max-age-days', '30'), 1),
  }
}

function numericValue(name, raw, min) {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${name} value: ${raw}`)
  return value
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPrivateIp(hostname) {
  if (isIP(hostname) === 4) {
    const [a, b] = hostname.split('.').map(Number)
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
  }
  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase()
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/u.test(normalized)
  }
  return false
}

function isPublicHttpsUrl(value, { requirePath = false } = {}) {
  if (!hasText(value)) return false
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const ipHostname = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    const placeholder = hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '[::1]'
      || hostname.endsWith('.local')
      || hostname.endsWith('.test')
      || hostname.endsWith('.example')
      || hostname.endsWith('.invalid')
    return url.protocol === 'https:'
      && !placeholder
      && !isPrivateIp(ipHostname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (!requirePath || (url.pathname !== '/' && !url.pathname.endsWith('/')))
  } catch {
    return false
  }
}

function findForbiddenSecretKeys(value, pathParts = []) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenSecretKeys(entry, [...pathParts, String(index)]))
  }
  return Object.entries(value).flatMap(([key, nested]) => {
    const current = [...pathParts, key]
    return [
      ...(FORBIDDEN_SECRET_KEYS.test(key) ? [current.join('.')] : []),
      ...findForbiddenSecretKeys(nested, current),
    ]
  })
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

export function evaluateMcpPilotEvidence(
  evidence,
  config = createMcpPilotConfig({ argv: ['node'] }),
  now = new Date(),
) {
  const failures = []
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { ok: false, failures: ['Evidence file must contain a JSON object.'], counts: {} }
  }

  if (evidence.release !== config.release) {
    failures.push(`Expected release ${config.release}, got ${evidence.release ?? 'missing'}.`)
  }
  if (evidence.template !== false) {
    failures.push('Evidence must set template=false after replacing every placeholder with observed pilot data.')
  }

  const testedAt = Date.parse(evidence.testedAt)
  const nowMs = now.getTime()
  const maxAgeMs = config.maxAgeDays * 24 * 60 * 60 * 1000
  if (!Number.isFinite(testedAt)) {
    failures.push('testedAt must be a valid ISO timestamp.')
  } else if (testedAt > nowMs + 5 * 60 * 1000) {
    failures.push('testedAt must not be in the future.')
  } else if (nowMs - testedAt > maxAgeMs) {
    failures.push(`Pilot evidence must be no older than ${config.maxAgeDays} days.`)
  }

  const connector = evidence.connector ?? {}
  if (!['grok-cli', 'grok-custom-connector'].includes(connector.type)) {
    failures.push('Connector type must be grok-cli or grok-custom-connector.')
  }
  if (!isPublicHttpsUrl(connector.mcpUrl, { requirePath: true })) failures.push('Connector MCP URL must be a non-placeholder public HTTPS URL with an exact path.')
  if (!isPublicHttpsUrl(connector.oauthIssuer)) failures.push('OAuth issuer must be a non-placeholder public HTTPS URL.')
  if (connector.externalNetwork !== true) failures.push('The Grok connection must be observed over an external network path.')
  if (connector.authorizationCodeFlow !== true || connector.pkceMethod !== 'S256') {
    failures.push('The observed OAuth flow must use authorization code with PKCE S256.')
  }
  if (connector.grokConnectionVerified !== true) failures.push('Grok connection verification is missing.')

  const tenant = evidence.tenant ?? {}
  if (tenant.dedicated !== true) failures.push('The MCP runtime must be a dedicated tenant.')
  if (tenant.readOnly !== true || tenant.sendEnabled !== false) failures.push('The first hosted pilot must remain read-only with send disabled.')
  if (tenant.secretDelivery !== 'mounted-files') failures.push('Runtime secrets must be delivered as mounted files.')
  if (!['business', 'enterprise'].includes(tenant.minimumVerificationTier)) {
    failures.push('The pilot must enforce a business or enterprise target-assurance tier.')
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(tenant.imageDigest ?? '')) {
    failures.push('The tenant must record an immutable sha256 container image digest.')
  }

  const observations = evidence.observations ?? {}
  if (observations.healthStatus !== 200) failures.push('Public health check must return HTTP 200.')
  if (observations.protectedResourceMetadataStatus !== 200) failures.push('RFC 9728 protected-resource metadata must return HTTP 200.')
  if (observations.unauthenticatedMcpStatus !== 401) failures.push('Unauthenticated MCP access must return HTTP 401.')
  const tools = Array.isArray(observations.toolNames)
    ? [...new Set(observations.toolNames.filter(hasText))].sort()
    : []
  if (JSON.stringify(tools) !== JSON.stringify(REQUIRED_TOOLS)) {
    failures.push(`Read-only tool list must contain exactly ${REQUIRED_TOOLS.join(', ')}.`)
  }
  if (observations.beamSendAdvertised !== false || observations.messageSent !== false) {
    failures.push('beam_send must be absent and the read-only pilot must not send a message.')
  }
  if (observations.targetLookupSucceeded !== true) failures.push('A real target lookup through Grok must succeed.')
  if (!['business', 'enterprise'].includes(observations.targetAssuranceTier)) {
    failures.push('The looked-up target must satisfy business or enterprise assurance.')
  }
  if (observations.auditContentFree !== true || observations.tokenInAudit !== false) {
    failures.push('Audit evidence must be content-free and contain no OAuth token.')
  }
  if (observations.secretInContainerEnvironment !== false) {
    failures.push('Container inspection must show that secret values are absent from the environment.')
  }

  const operator = evidence.operator ?? {}
  if (operator.external !== true || !hasText(operator.organization) || !hasText(operator.operatorRef)) {
    failures.push('A pseudonymous external operator and organization must attest the Grok pilot.')
  }

  const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : []
  const validArtifacts = artifacts.filter((artifact) => hasText(artifact?.kind) && validSha256(artifact?.sha256))
  const artifactKinds = new Set(validArtifacts.map((artifact) => artifact.kind))
  for (const kind of REQUIRED_ARTIFACTS) {
    if (!artifactKinds.has(kind)) failures.push(`Missing hashed ${kind} artifact.`)
  }

  const forbiddenKeys = findForbiddenSecretKeys(evidence)
  if (forbiddenKeys.length > 0) {
    failures.push(`Evidence contains forbidden secret-bearing fields: ${forbiddenKeys.join(', ')}.`)
  }

  return {
    ok: failures.length === 0,
    failures,
    counts: {
      tools: tools.length,
      hashedArtifacts: validArtifacts.length,
      externalOperators: operator.external === true ? 1 : 0,
    },
  }
}

async function main() {
  const config = createMcpPilotConfig()
  const evidencePath = path.resolve(config.evidencePath)
  let evidence
  let readFailure = null
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  } catch (error) {
    readFailure = `Could not read MCP pilot evidence at ${evidencePath}: ${error.message}`
  }

  const evaluation = readFailure == null
    ? evaluateMcpPilotEvidence(evidence, config)
    : { ok: false, counts: {}, failures: [readFailure] }
  const result = {
    ok: evaluation.ok,
    date: formatDate(),
    generatedAt: formatDateTime(),
    release: config.release,
    evidencePath,
    maxAgeDays: config.maxAgeDays,
    counts: evaluation.counts,
    failures: evaluation.failures,
  }

  if (config.outputPath) {
    const markdown = `# Beam Hosted MCP Pilot Evidence Check

## Context

- generated at: \`${formatDateTime()}\`
- release: \`${config.release}\`
- evidence path: \`${evidencePath}\`

## Result

\`${result.ok ? 'PASS' : 'FAIL'}\`

## Evidence

${toJsonBlock(result)}
`
    await writeMarkdownReport(path.resolve(config.outputPath), markdown)
  }

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[production:mcp-pilot] failed:', error)
    process.exitCode = 1
  })
}
