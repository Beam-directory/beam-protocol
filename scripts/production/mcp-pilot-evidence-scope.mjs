import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { repoRoot } from './shared.mjs'

// Everything that ends up in the hosted MCP pilot image or changes how the
// pilot is deployed. The image copies the SDK source, the lockfile and LICENSE.
export const MCP_PILOT_PATH_PREFIXES = [
  'packages/mcp-server/',
  'packages/sdk-typescript/',
  'ops/mcp-pilot/',
  'ops/mcp-tenant/',
  'scripts/e2e/mcp-',
  'scripts/production/mcp-',
  'scripts/production/prepare-mcp-pilot-secrets.mjs',
  'scripts/production/upgrade-mcp-pilot-network-e2ee.mjs',
  'scripts/production/configure-keycloak-',
  'scripts/production/finalize-keycloak-grok-client.mjs',
  'scripts/production/install-grok-beam-oauth.mjs',
  '.github/workflows/ci.yml',
  'package-lock.json',
  'LICENSE',
]

export const SCOPE_ALWAYS = 'always'
export const SCOPE_MCP_CHANGES = 'mcp-changes'

export function normalizeScope(raw) {
  return typeof raw === 'string' && raw.trim() === SCOPE_MCP_CHANGES ? SCOPE_MCP_CHANGES : SCOPE_ALWAYS
}

export function isMcpPilotPath(file) {
  return MCP_PILOT_PATH_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))
}

function stripPackageJsonVersion(json, workspaceNames) {
  const copy = structuredClone(json)
  delete copy.version
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!copy[field] || typeof copy[field] !== 'object') continue
    for (const name of workspaceNames) delete copy[field][name]
  }
  return copy
}

function lockfileWorkspaceNames(lock) {
  const names = new Set()
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key !== '' && !key.startsWith('node_modules/') && typeof entry?.name === 'string') names.add(entry.name)
  }
  return names
}

function stripLockfileVersions(lock, workspaceNames) {
  const copy = structuredClone(lock)
  delete copy.version
  for (const [key, entry] of Object.entries(copy.packages ?? {})) {
    if (key === '' || !key.startsWith('node_modules/')) {
      copy.packages[key] = stripPackageJsonVersion(entry, workspaceNames)
    }
  }
  return copy
}

// A release bump only changes workspace version fields and the internal pins
// between workspace packages. That does not change what the pilot runs.
export function isVersionOnlyChange(file, before, after, workspaceNames = new Set()) {
  if (typeof before !== 'string' || typeof after !== 'string') return false
  if (!file.endsWith('package.json') && file !== 'package-lock.json') return false
  let beforeJson
  let afterJson
  try {
    beforeJson = JSON.parse(before)
    afterJson = JSON.parse(after)
  } catch {
    return false
  }
  if (file === 'package-lock.json') {
    const names = new Set([...workspaceNames, ...lockfileWorkspaceNames(beforeJson), ...lockfileWorkspaceNames(afterJson)])
    return isDeepStrictEqual(stripLockfileVersions(beforeJson, names), stripLockfileVersions(afterJson, names))
  }
  return isDeepStrictEqual(stripPackageJsonVersion(beforeJson, workspaceNames), stripPackageJsonVersion(afterJson, workspaceNames))
}

export function decideMcpPilotEvidence({ scope, eventName, ref, previousTag, changes = [], workspaceNames = new Set() }) {
  const normalizedScope = normalizeScope(scope)
  const base = { scope: normalizedScope, previousTag: previousTag ?? null, mcpChanges: [] }

  if (normalizedScope !== SCOPE_MCP_CHANGES) {
    return { ...base, required: true, reason: `scope is ${SCOPE_ALWAYS}` }
  }
  if (eventName !== 'push' || typeof ref !== 'string' || !ref.startsWith('refs/tags/v')) {
    return { ...base, required: true, reason: 'only tag pushes can skip the evidence check' }
  }
  if (!previousTag) {
    return { ...base, required: true, reason: 'no previous release tag to compare with' }
  }

  const mcpChanges = changes
    .filter(({ file }) => isMcpPilotPath(file))
    .filter(({ file, before, after }) => !isVersionOnlyChange(file, before, after, workspaceNames))
    .map(({ file }) => file)

  if (mcpChanges.length > 0) {
    return { ...base, mcpChanges, required: true, reason: `MCP pilot files changed since ${previousTag}` }
  }
  return { ...base, required: false, reason: `no MCP pilot files changed since ${previousTag}` }
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitShow(rev, file) {
  try {
    return git(['show', `${rev}:${file}`])
  } catch {
    return null
  }
}

export function collectGitChanges(head) {
  let previousTag = null
  try {
    previousTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${head}^`]).trim() || null
  } catch {
    return { previousTag: null, changes: [], workspaceNames: new Set() }
  }
  const files = git(['diff', '--name-only', previousTag, head]).split('\n').map((line) => line.trim()).filter(Boolean)
  const changes = files.map((file) => ({
    file,
    before: isMcpPilotPath(file) ? gitShow(previousTag, file) : null,
    after: isMcpPilotPath(file) ? gitShow(head, file) : null,
  }))
  const lock = gitShow(head, 'package-lock.json')
  let workspaceNames = new Set()
  try {
    workspaceNames = lockfileWorkspaceNames(JSON.parse(lock ?? '{}'))
  } catch {
    workspaceNames = new Set()
  }
  return { previousTag, changes, workspaceNames }
}

function main() {
  const scope = normalizeScope(process.env.MCP_PILOT_EVIDENCE_SCOPE)
  const eventName = process.env.GITHUB_EVENT_NAME ?? ''
  const ref = process.env.GITHUB_REF ?? ''
  const head = process.env.GITHUB_SHA || 'HEAD'

  let decision
  try {
    const gitState = scope === SCOPE_MCP_CHANGES ? collectGitChanges(head) : { previousTag: null, changes: [], workspaceNames: new Set() }
    decision = decideMcpPilotEvidence({ scope, eventName, ref, ...gitState })
  } catch (error) {
    decision = { scope, required: true, reason: `could not compare releases: ${error.message}`, previousTag: null, mcpChanges: [] }
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${decision.required ? 'true' : 'false'}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## Hosted MCP pilot evidence',
      '',
      `- scope: \`${decision.scope}\``,
      `- required: \`${decision.required}\``,
      `- reason: ${decision.reason}`,
      ...decision.mcpChanges.map((file) => `- changed: \`${file}\``),
      '',
    ]
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
  console.log(JSON.stringify(decision, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
