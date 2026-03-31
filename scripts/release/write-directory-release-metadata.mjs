import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const defaultOutputPath = resolve(__dirname, '../../packages/directory/release.json')

function readFlag(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  return process.argv[index + 1] ?? null
}

function requiredFlag(name) {
  const value = readFlag(name)
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing required flag: ${name}`)
  }
  return value.trim()
}

function normalizeIsoTimestamp(value) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid deployed-at timestamp: ${value}`)
  }
  return parsed.toISOString()
}

function main() {
  const version = requiredFlag('--version')
  const gitSha = requiredFlag('--git-sha')
  const deployedAt = normalizeIsoTimestamp(requiredFlag('--deployed-at'))
  const outputPath = readFlag('--output') ? resolve(process.cwd(), readFlag('--output')) : defaultOutputPath

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        version,
        gitSha,
        deployedAt,
      },
      null,
      2,
    ) + '\n',
  )

  console.log(`Wrote directory release metadata to ${outputPath}`)
}

main()
