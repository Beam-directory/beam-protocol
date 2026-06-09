import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { formatDate, formatDateTime, optionalFlag, repoRoot, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const defaultEvidencePath = path.join(repoRoot, 'reports/1.7.0-external-dogfood-evidence.json')

export function createExternalDogfoodConfig({ argv = process.argv } = {}) {
  const optional = (name, fallback = null) => {
    if (argv === process.argv) {
      return optionalFlag(name, fallback)
    }

    const index = argv.indexOf(name)
    if (index === -1) {
      return fallback
    }

    const value = argv[index + 1] ?? fallback
    if (typeof value !== 'string') {
      return value
    }

    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.startsWith('--')) {
      return fallback
    }

    return trimmed
  }

  return {
    release: optional('--release', '1.7.0'),
    evidencePath: optional('--evidence', defaultEvidencePath),
    outputPath: optional('--output'),
    minOperators: numericValue('--min-operators', optional('--min-operators', '2')),
    minHosts: numericValue('--min-hosts', optional('--min-hosts', '5')),
    minFeedback: numericValue('--min-feedback', optional('--min-feedback', '2')),
  }
}

function numericValue(name, raw) {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Invalid ${name} value: ${raw}`)
  }
  return value
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function participantKey(value) {
  return hasText(value?.email) ? value.email.trim().toLowerCase() : String(value?.name ?? '').trim().toLowerCase()
}

function uniqueCount(values, keyFn) {
  return new Set(values.map(keyFn).filter(hasText)).size
}

export function evaluateExternalDogfoodEvidence(evidence, config = createExternalDogfoodConfig({ argv: ['node'] })) {
  const failures = []

  if (!evidence || typeof evidence !== 'object') {
    return {
      ok: false,
      failures: ['Evidence file must contain a JSON object.'],
      counts: {},
    }
  }

  if (evidence.release !== config.release) {
    failures.push(`Expected release ${config.release}, got ${evidence.release ?? 'missing'}.`)
  }

  if (evidence.template === true) {
    failures.push('Evidence file is marked as a template; copy it to a real evidence file and replace placeholders with real external dogfood data.')
  }

  const operators = asArray(evidence.operators)
  const externalOperators = operators.filter((operator) => operator?.external === true && participantKey(operator))
  const externalOperatorCount = uniqueCount(externalOperators, participantKey)
  if (externalOperatorCount < config.minOperators) {
    failures.push(`Need at least ${config.minOperators} distinct external operators; found ${externalOperatorCount}.`)
  }

  const hosts = asArray(evidence.hosts)
  const externalPackagedHosts = hosts.filter((host) => {
    return host?.external === true
      && host?.installed === true
      && host?.bootstrapFlow === 'packaged'
      && hasText(host?.label)
      && hasText(host?.machine)
      && hasText(host?.os)
  })
  if (externalPackagedHosts.length < config.minHosts) {
    failures.push(`Need at least ${config.minHosts} external packaged-bootstrap hosts; found ${externalPackagedHosts.length}.`)
  }

  const freshMachineHosts = externalPackagedHosts.filter((host) => host.freshMachine === true && host.noPreloadedRepoState === true)
  if (freshMachineHosts.length < 1) {
    failures.push('Need at least one fresh-machine onboarding with no preloaded repo state.')
  }

  const supportHandoffs = asArray(evidence.supportHandoffs)
  const realSupportHandoffs = supportHandoffs.filter((handoff) => {
    return ['support-bundle', 'fleet-analytics'].includes(handoff?.type)
      && handoff?.usedInRealDebug === true
      && hasText(handoff?.hostLabel)
      && hasText(handoff?.summary)
  })
  if (realSupportHandoffs.length < 1) {
    failures.push('Need at least one real support-bundle or fleet-analytics handoff used in support/debug.')
  }

  const feedback = asArray(evidence.feedback)
  const externalFeedback = feedback.filter((item) => {
    return item?.external === true
      && hasText(item?.tester)
      && hasText(item?.hostLabel)
      && hasText(item?.verdict)
      && hasText(item?.solidSignal)
  })
  if (externalFeedback.length < config.minFeedback) {
    failures.push(`Need at least ${config.minFeedback} written external feedback entries; found ${externalFeedback.length}.`)
  }

  return {
    ok: failures.length === 0,
    failures,
    counts: {
      externalOperators: externalOperatorCount,
      externalPackagedHosts: externalPackagedHosts.length,
      freshMachineHosts: freshMachineHosts.length,
      realSupportHandoffs: realSupportHandoffs.length,
      externalFeedback: externalFeedback.length,
    },
  }
}

async function main() {
  const config = createExternalDogfoodConfig()
  const evidencePath = path.resolve(config.evidencePath)
  let evidence
  let readFailure = null

  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  } catch (error) {
    readFailure = `Could not read external dogfood evidence at ${evidencePath}: ${error.message}`
  }

  const evaluation = readFailure == null
    ? evaluateExternalDogfoodEvidence(evidence, config)
    : { ok: false, counts: {}, failures: [readFailure] }
  const result = {
    ok: evaluation.ok,
    date: formatDate(),
    generatedAt: formatDateTime(),
    release: config.release,
    evidencePath,
    requirements: {
      minOperators: config.minOperators,
      minHosts: config.minHosts,
      minFeedback: config.minFeedback,
      freshMachineOnboarding: true,
      realSupportHandoff: true,
    },
    counts: evaluation.counts,
    failures: evaluation.failures,
  }

  if (config.outputPath) {
    const markdown = `# Beam External Dogfood Evidence Check

## Context

- run date: \`${formatDate()}\`
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
  if (!result.ok) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[production:external-dogfood] failed:', error)
    process.exitCode = 1
  })
}
