import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createExternalDogfoodConfig,
  evaluateExternalDogfoodEvidence,
} from './external-dogfood-evidence-check.mjs'
import { formatDate, formatDateTime, optionalFlag, repoRoot } from './shared.mjs'

const defaultInputDir = path.join(repoRoot, 'tmp/external-dogfood-pack')
const defaultOutputPath = path.join(repoRoot, 'reports/1.7.0-external-dogfood-evidence.json')

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function containsTodo(value) {
  return typeof value === 'string' && value.toLowerCase().includes('todo')
}

function isLoopback(url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function completionKey(completion) {
  return completion?.source?.packPath ?? completion?.host?.label ?? 'unknown-completion'
}

function participantKey(value) {
  return hasText(value?.email) ? value.email.trim().toLowerCase() : String(value?.name ?? '').trim().toLowerCase()
}

function uniqueBy(values, keyFn) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const key = keyFn(value)
    if (!hasText(key) || seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(value)
  }
  return result
}

function requireCompletedField(failures, label, value) {
  if (!hasText(value) || containsTodo(value)) {
    failures.push(`${label} is missing or still contains TODO.`)
  }
}

export function assembleExternalDogfoodEvidenceFromCompletions(completions, {
  release = '1.7.0',
  generatedAt = formatDateTime(),
} = {}) {
  const failures = []
  const operators = []
  const hosts = []
  const supportHandoffs = []
  const feedback = []

  for (const completion of Array.isArray(completions) ? completions : []) {
    const label = completionKey(completion)

    if (!completion || typeof completion !== 'object') {
      failures.push(`${label}: completion must be a JSON object.`)
      continue
    }
    if (completion.template === true) {
      failures.push(`${label}: completion is still marked as a template.`)
    }
    if (completion.release !== release) {
      failures.push(`${label}: expected release ${release}, got ${completion.release ?? 'missing'}.`)
    }
    if (completion.source?.publicDirectory !== true || completion.source?.releaseEvidenceCandidate !== true) {
      failures.push(`${label}: completion was not generated as a public release-evidence candidate.`)
    }
    if (!hasText(completion.source?.directoryUrl) || isLoopback(completion.source.directoryUrl)) {
      failures.push(`${label}: directoryUrl must be a non-local Beam control plane.`)
    }

    const operator = completion.operator ?? {}
    requireCompletedField(failures, `${label}: operator.name`, operator.name)
    requireCompletedField(failures, `${label}: operator.email`, operator.email)
    requireCompletedField(failures, `${label}: operator.organization`, operator.organization)
    if (operator.external !== true) {
      failures.push(`${label}: operator.external must be true.`)
    }

    const host = completion.host ?? {}
    requireCompletedField(failures, `${label}: host.label`, host.label)
    requireCompletedField(failures, `${label}: host.machine`, host.machine)
    requireCompletedField(failures, `${label}: host.os`, host.os)
    requireCompletedField(failures, `${label}: host.installedAt`, host.installedAt)
    if (host.external !== true) {
      failures.push(`${label}: host.external must be true.`)
    }
    if (host.installed !== true) {
      failures.push(`${label}: host.installed must be true.`)
    }
    if (host.bootstrapFlow !== 'packaged') {
      failures.push(`${label}: host.bootstrapFlow must be "packaged".`)
    }
    if (host.heartbeatSeen !== true) {
      failures.push(`${label}: host.heartbeatSeen must be true.`)
    }
    if (host.inventorySeen !== true) {
      failures.push(`${label}: host.inventorySeen must be true.`)
    }

    const handoff = completion.supportHandoff ?? {}
    requireCompletedField(failures, `${label}: supportHandoff.hostLabel`, handoff.hostLabel)
    requireCompletedField(failures, `${label}: supportHandoff.summary`, handoff.summary)
    requireCompletedField(failures, `${label}: supportHandoff.exportedAt`, handoff.exportedAt)
    if (!['support-bundle', 'fleet-analytics'].includes(handoff.type)) {
      failures.push(`${label}: supportHandoff.type must be support-bundle or fleet-analytics.`)
    }
    if (handoff.usedInRealDebug !== true) {
      failures.push(`${label}: supportHandoff.usedInRealDebug must be true.`)
    }

    const item = completion.feedback ?? {}
    requireCompletedField(failures, `${label}: feedback.tester`, item.tester)
    requireCompletedField(failures, `${label}: feedback.hostLabel`, item.hostLabel)
    requireCompletedField(failures, `${label}: feedback.verdict`, item.verdict)
    requireCompletedField(failures, `${label}: feedback.solidSignal`, item.solidSignal)
    if (item.external !== true) {
      failures.push(`${label}: feedback.external must be true.`)
    }

    operators.push(operator)
    hosts.push(host)
    supportHandoffs.push(handoff)
    feedback.push(item)
  }

  const evidence = {
    release,
    generatedAt,
    assembledAt: generatedAt,
    operators: uniqueBy(operators, participantKey),
    hosts,
    supportHandoffs,
    feedback,
  }

  const gate = evaluateExternalDogfoodEvidence(
    evidence,
    createExternalDogfoodConfig({ argv: ['node', 'external-dogfood-evidence-check.mjs', '--release', release] }),
  )

  return {
    ok: failures.length === 0 && gate.ok,
    evidence,
    failures: [...failures, ...gate.failures],
    counts: gate.counts,
  }
}

async function loadCompletionFiles(inputDir) {
  const entries = await readdir(inputDir, { withFileTypes: true })
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.completion.json'))
    .map((entry) => path.join(inputDir, entry.name))
    .sort()

  const completions = []
  for (const filePath of paths) {
    const completion = JSON.parse(await readFile(filePath, 'utf8'))
    completion.source = {
      ...(completion.source ?? {}),
      completionPath: filePath,
    }
    completions.push(completion)
  }
  return { paths, completions }
}

async function main() {
  const release = optionalFlag('--release', '1.7.0')
  const inputDir = path.resolve(optionalFlag('--input-dir', defaultInputDir))
  const outputPath = path.resolve(optionalFlag('--output', defaultOutputPath))
  const generatedAt = formatDateTime()
  const { paths, completions } = await loadCompletionFiles(inputDir)
  const result = assembleExternalDogfoodEvidenceFromCompletions(completions, { release, generatedAt })

  const response = {
    ok: result.ok,
    date: formatDate(),
    generatedAt,
    release,
    inputDir,
    outputPath,
    completionFiles: paths,
    counts: result.counts,
    failures: result.failures,
  }

  if (result.ok) {
    await writeFile(outputPath, `${JSON.stringify(result.evidence, null, 2)}\n`, 'utf8')
  }

  console.log(JSON.stringify(response, null, 2))
  if (!result.ok) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[production:external-dogfood-assemble] failed:', error)
    process.exitCode = 1
  })
}
